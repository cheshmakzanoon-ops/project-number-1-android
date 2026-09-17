package com.garma.screenshare

import android.app.Activity
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.ServiceCompat
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.screencapture.ScreenCaptureParams
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/** Screen-only capture after Android consent and a server-authorized handoff. */
class ScreenShareService : Service() {
    companion object {
        const val ACTION_START = "com.garma.screenshare.START"
        const val ACTION_STOP = "com.garma.screenshare.STOP"
        const val EXTRA_CODE = "handoff_code"
        const val EXTRA_RESULT_CODE = "projection_result_code"
        const val EXTRA_RESULT_DATA = "projection_result_data"

        fun buildStartIntent(context: Context, code: String, resultCode: Int, data: Intent): Intent =
            Intent(context, ScreenShareService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_CODE, code)
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_RESULT_DATA, data)
            }
    }

    private class Session(val code: String, val projectionResult: Intent) {
        var room: Room? = null
        var beginJob: Job? = null
        var localJob: Job? = null
        var pollJob: Job? = null
        var eventsJob: Job? = null
        var cleanupJob: Job? = null
        var lease: ScreenShareLease? = null
        var owner: String? = null
        var ending = false
    }
    private val supervisor = SupervisorJob()
    private val scope = CoroutineScope(supervisor + Dispatchers.Main.immediate)
    private var current: Session? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            current?.let { endShare(it) } ?: releaseForegroundOnly()
            return START_NOT_STICKY
        }
        val code = intent?.getStringExtra(EXTRA_CODE)
        val result = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
        val data = projectionResultData(intent)
        // Never promote without a valid consent result, nor destroy a legitimate
        // running share because of a malformed/replayed service command.
        if (intent?.action != ACTION_START || code == null ||
            !code.matches(Regex("[A-Za-z0-9_-]{43}")) || result != Activity.RESULT_OK || data == null) {
            if (current == null) releaseForegroundOnly()
            return START_NOT_STICKY
        }
        if (current?.let { !it.ending && it.code == code } == true) return START_NOT_STICKY
        try {
            promoteToForeground()
        } catch (_: RuntimeException) {
            current?.let { endShare(it) } ?: releaseForegroundOnly()
            return START_NOT_STICKY
        }
        val previous = current
        val session = Session(code, data)
        // Transfer ownership BEFORE teardown: synchronous old cleanup must not
        // call stopSelf or remove the new session's notification.
        current = session
        previous?.let { endShare(it) }
        session.beginJob = scope.launch(start = CoroutineStart.LAZY) {
            try {
                withTimeout(30_000) {
                    previous?.cleanupJob?.join()
                    begin(session)
                }
            } catch (_: CancellationException) {
                endShare(session)
            } catch (_: Exception) {
                endShare(session)
            }
        }
        session.beginJob?.start()
        return START_NOT_STICKY
    }

    private fun promoteToForeground() {
        ScreenShareNotifications.ensureChannel(this)
        val notification = ScreenShareNotifications.build(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ScreenShareNotifications.NOTIFICATION_ID, notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else startForeground(ScreenShareNotifications.NOTIFICATION_ID, notification)
    }

    private fun releaseForegroundOnly() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        ScreenShareNotifications.clear(this)
        stopSelf()
    }

    private suspend fun begin(session: Session) {
        val credentials = withContext(Dispatchers.IO) {
            HandoffClient.redeem(BuildConfig.CONVEX_URL, session.code)
        }
        if (session.ending) return
        if (!credentials.identity.endsWith(":screen")) throw IllegalStateException("invalid_identity")
        session.owner = credentials.identity.removeSuffix(":screen")
        val room = LiveKit.create(applicationContext)
        session.room = room
        observeRoom(session, room)
        room.connect(credentials.url, credentials.token)
        if (session.ending) return
        // A call may end while room.connect is pending. Check again BEFORE any
        // screen publication instead of relying solely on the redeemed token.
        val authorized = withContext(Dispatchers.IO) {
            HandoffClient.sessionLive(BuildConfig.CONVEX_URL, credentials.sessionId)
        }
        if (session.ending) return
        if (!authorized) throw IllegalStateException("share_ended")
        session.lease = ScreenShareLease(SystemClock.elapsedRealtime())
        val started = room.localParticipant.setScreenShareEnabled(true,
            ScreenCaptureParams(session.projectionResult, onStop = {
                // LiveKit may call this from a capturer thread; mutate ownership
                // only on Main. onDestroy has its own unconditional cleanup.
                scope.launch { endShare(session) }
            }))
        if (session.ending || !started) {
            endShare(session)
            return
        }
        watch(session, credentials.sessionId)
    }

    private fun observeRoom(session: Session, room: Room) {
        session.eventsJob = scope.launch {
            try {
                room.events.collect { event ->
                    when (event) {
                        is RoomEvent.Disconnected -> endShare(session)
                        is RoomEvent.DataReceived -> {
                            val type = if (event.data.size <= 512) try {
                                JSONObject(event.data.toString(Charsets.UTF_8)).optString("type")
                            } catch (_: Exception) { null } else null
                            if (isOwnerStop(event.participant?.identity?.value, session.owner, event.topic, type))
                                endShare(session)
                        }
                        is RoomEvent.TrackUnpublished -> if (event.participant is LocalParticipant &&
                            event.publication.source == Track.Source.SCREEN_SHARE) endShare(session)
                        else -> Unit
                    }
                }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { endShare(session) }
        }
    }

    private fun watch(session: Session, sessionId: String) {
        // Independent jobs: a slow HTTP request cannot pause local revocation
        // checks or extend the authorization lease indefinitely.
        session.localJob = scope.launch {
            while (isActive && !session.ending) {
                delay(1_000)
                if (session.room?.localParticipant?.isScreenShareEnabled != true ||
                    session.lease?.expired(SystemClock.elapsedRealtime()) != false) {
                    endShare(session)
                    return@launch
                }
            }
        }
        session.pollJob = scope.launch {
            while (isActive && !session.ending) {
                delay(5_000)
                val live = try {
                    withContext(Dispatchers.IO) { HandoffClient.sessionLive(BuildConfig.CONVEX_URL, sessionId) }
                } catch (e: CancellationException) { throw e }
                catch (_: Exception) { null }
                if (session.ending) return@launch
                when (live) {
                    true -> session.lease?.renew(SystemClock.elapsedRealtime())
                    false -> { endShare(session); return@launch }
                    null -> Unit // no renewal; local watchdog stops after 30 s
                }
            }
        }
    }

    /** Idempotent Main-thread teardown; the creating job is owned and cancelled. */
    private fun endShare(session: Session) {
        if (session.ending) return
        session.ending = true
        session.beginJob?.cancel()
        session.localJob?.cancel()
        session.pollJob?.cancel()
        session.eventsJob?.cancel()
        val room = session.room
        session.room = null
        // Stop transport immediately; don't wait for a network-bound suspend
        // function before responding to Android's STOP action.
        try { room?.disconnect() } catch (_: Exception) { /* release below */ }
        session.cleanupJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            withContext(NonCancellable) {
                try {
                    if (room != null) withTimeoutOrNull(2_500) {
                        room.localParticipant.setScreenShareEnabled(false)
                    }
                } catch (_: Exception) { /* release is still mandatory */ }
                finally {
                    try { room?.release() } catch (_: Exception) { /* already disposed */ }
                    if (current === session) {
                        current = null
                        releaseForegroundOnly()
                    }
                }
            }
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        current?.let { endShare(it) }
        super.onTaskRemoved(rootIntent)
    }
    override fun onDestroy() {
        current?.let { endShare(it) }
        // Cleanup has already entered NonCancellable; all ordinary jobs must end.
        supervisor.cancel()
        super.onDestroy()
    }
    @Suppress("DEPRECATION")
    private fun projectionResultData(intent: Intent?): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else intent?.getParcelableExtra(EXTRA_RESULT_DATA)
}
