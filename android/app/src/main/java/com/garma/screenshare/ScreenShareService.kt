package com.garma.screenshare

import android.app.Activity
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The MediaProjection foreground service: the ONE thing that makes Android
 * screen sharing real.
 *
 * Responsibilities (all of them required for a capture that behaves):
 *  - run as a foreground service of type `mediaProjection`, with the
 *    user-visible notification and its STOP action, for exactly as long as the
 *    capture lasts;
 *  - redeem the one-time code for a restricted LiveKit grant (screen-share
 *    source only, subscribe disabled) and join the SAME room as the browser
 *    participant under the server-minted auxiliary "<userId>:screen" identity
 *    — never the user's own identity, so the browser connection is never
 *    evicted;
 *  - publish the screen captured through the consent [Intent] the activity
 *    obtained;
 *  - end the share on EVERY stop path: notification STOP, the browser's stop
 *    message, the call ending (server session poll), the room disconnecting,
 *    the capture track ending (projection revoked / system "stop sharing"), or
 *    the service being destroyed — and always unpublish the track, disconnect
 *    the room, drop the foreground notification and stop the service.
 *
 * It intentionally publishes NO camera and NO microphone: it is a capture pipe
 * for the screen, nothing else.
 *
 * OWNERSHIP: each share is a [Session]. A new share started on the same service
 * instance (stop → share again) ends the previous session first and only the
 * session that is still CURRENT is allowed to stop the foreground service or
 * clear the notification, so an old session tearing down late can never kill a
 * newer share.
 */
class ScreenShareService : Service() {

    companion object {
        const val ACTION_START = "com.garma.screenshare.START"
        const val ACTION_STOP = "com.garma.screenshare.STOP"
        const val EXTRA_CODE = "handoff_code"
        const val EXTRA_RESULT_CODE = "projection_result_code"
        const val EXTRA_RESULT_DATA = "projection_result_data"

        /** Topic the web participant publishes its stop request on. */
        private const val STOP_TOPIC = "garma.screen-share"

        /** Local liveness check: is the screen still actually published? */
        private const val LOCAL_CHECK_MS = 1_000L

        /** Ask the server every N local checks (~5 s) whether the share is allowed. */
        private const val SERVER_POLL_TICKS = 5

        fun buildStartIntent(context: Context, code: String, resultCode: Int, data: Intent): Intent =
            Intent(context, ScreenShareService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_CODE, code)
                putExtra(EXTRA_RESULT_CODE, resultCode)
                putExtra(EXTRA_RESULT_DATA, data)
            }
    }

    /** One MediaProjection share. Owns its room, its jobs and its latch. */
    private inner class Session(val code: String, val projectionResult: Intent) {
        var room: Room? = null
        var pollJob: Job? = null
        var eventsJob: Job? = null

        /** Set synchronously the moment this session starts ending. */
        var ending = false
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var current: Session? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            current?.let { endShare(it) } ?: releaseForegroundOnly()
            return START_NOT_STICKY
        }

        // Foreground FIRST: Android kills a service that was promoted but never
        // posted its notification, and the handoff redemption below is a
        // network round-trip that can take a moment.
        promoteToForeground()

        val code = intent?.getStringExtra(EXTRA_CODE)
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
            ?: Activity.RESULT_CANCELED
        val resultData = projectionResultData(intent)

        if (code.isNullOrEmpty() || resultCode != Activity.RESULT_OK || resultData == null) {
            current?.let { endShare(it) } ?: releaseForegroundOnly()
            return START_NOT_STICKY
        }

        // A share may be started on an instance that is still finishing the
        // previous one (stop, then share again). End the old session first: its
        // capture, room and jobs must not leak into this one.
        current?.let { endShare(it) }
        val session = Session(code, resultData)
        current = session
        scope.launch { begin(session) }
        return START_NOT_STICKY
    }

    private fun promoteToForeground() {
        ScreenShareNotifications.ensureChannel(this)
        val notification = ScreenShareNotifications.build(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                ScreenShareNotifications.NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else {
            startForeground(ScreenShareNotifications.NOTIFICATION_ID, notification)
        }
    }

    /** Nothing was ever shared (bad link / denied consent): just go away. */
    private fun releaseForegroundOnly() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        ScreenShareNotifications.clear(this)
        stopSelf()
    }

    private suspend fun begin(session: Session) {
        try {
            // The server decides everything: which call, which identity, which
            // sources. A bad/expired/replayed code throws and we stop.
            val credentials = withContext(Dispatchers.IO) {
                HandoffClient.redeem(BuildConfig.CONVEX_URL, session.code)
            }
            if (session.ending) return

            val liveRoom = LiveKit.create(applicationContext)
            session.room = liveRoom
            // Observe BEFORE connecting so a failed/disconnected room is never
            // missed.
            observeRoom(session, liveRoom)
            liveRoom.connect(credentials.url, credentials.token)
            if (session.ending) return

            // Screen only, and only from the consent the activity obtained.
            // The server-minted grant allows nothing else.
            val started = liveRoom.localParticipant.setScreenShareEnabled(
                true,
                ScreenCaptureParams(session.projectionResult),
            )
            if (session.ending) return
            if (!started) {
                endShare(session)
                return
            }
            watch(session, credentials.sessionId)
        } catch (_: Throwable) {
            endShare(session)
        }
    }

    /**
     * The room's own events: a disconnect or the web app's stop request end the
     * share immediately. Liveness of the capture itself is checked by [watch],
     * which is what catches a revoked projection without depending on the
     * exact shape of an SDK event.
     */
    private fun observeRoom(session: Session, liveRoom: Room) {
        session.eventsJob = scope.launch {
            try {
                liveRoom.events.collect { event ->
                    when (event) {
                        is RoomEvent.Disconnected -> endShare(session)
                        is RoomEvent.DataReceived ->
                            if (event.topic == STOP_TOPIC) endShare(session)
                        is RoomEvent.TrackUnpublished ->
                            // Only OUR screen matters; another participant's
                            // unpublish is not a reason for us to stop.
                            if (event.participant is LocalParticipant &&
                                event.publication.source == Track.Source.SCREEN_SHARE
                            ) {
                                endShare(session)
                            }
                        else -> Unit
                    }
                }
            } catch (e: Throwable) {
                if (e is CancellationException) return@launch
                endShare(session)
            }
        }
    }

    /**
     * Two independent liveness checks, because a MediaProjection capture can
     * die in ways no single signal covers:
     *
     *  1. every second, is the screen still published on the room? Android
     *     revoking the projection, the system "stop sharing" control and any
     *     internal unpublish all land here;
     *  2. every ~5 s, does the server still allow this share? That is what ends
     *     the capture when the call is hung up, even if the stop message never
     *     arrives.
     *
     * A transient network failure is explicitly NOT a reason to stop.
     */
    private fun watch(session: Session, sessionId: String) {
        session.pollJob = scope.launch {
            var ticks = 0
            while (isActive) {
                delay(LOCAL_CHECK_MS)
                val liveRoom = session.room ?: return@launch
                if (!liveRoom.localParticipant.isScreenShareEnabled) {
                    endShare(session)
                    return@launch
                }
                ticks += 1
                if (ticks < SERVER_POLL_TICKS) continue
                ticks = 0
                val live = try {
                    withContext(Dispatchers.IO) {
                        HandoffClient.sessionLive(BuildConfig.CONVEX_URL, sessionId)
                    }
                } catch (_: Throwable) {
                    true // transient failure: keep sharing
                }
                if (!live) {
                    endShare(session)
                    return@launch
                }
            }
        }
    }

    /**
     * The single cleanup path, idempotent and non-cancellable: unpublish the
     * screen (which is what releases the MediaProjection/VirtualDisplay inside
     * the SDK), disconnect the auxiliary participant, stop the poll, clear the
     * notification and stop the foreground service.
     *
     * It runs for a user stop, a hangup, a revoked projection, a lost room and
     * service destruction alike, and it only touches the foreground service /
     * notification when its own session is still the current one.
     */
    private fun endShare(session: Session) {
        if (session.ending) return
        session.ending = true
        session.pollJob?.cancel()
        session.pollJob = null
        session.eventsJob?.cancel()
        session.eventsJob = null
        val liveRoom = session.room
        session.room = null
        scope.launch {
            // NonCancellable: this is exactly the work that must complete even
            // though the jobs above were just cancelled.
            withContext(NonCancellable) {
                if (liveRoom != null) {
                    try {
                        liveRoom.localParticipant.setScreenShareEnabled(false)
                    } catch (_: Throwable) {
                        /* the capture is being torn down anyway */
                    }
                    try {
                        liveRoom.disconnect()
                    } catch (_: Throwable) {
                        /* already gone */
                    }
                }
                if (current === session) {
                    current = null
                    ServiceCompat.stopForeground(this@ScreenShareService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    ScreenShareNotifications.clear(this@ScreenShareService)
                    stopSelf()
                }
            }
        }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // The user swiped the task away: the capture must not survive it.
        current?.let { endShare(it) }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        // The system can destroy the service (low memory, force stop): the
        // capture, the auxiliary participant and the notification must not
        // outlive it. `endShare` schedules the teardown on a scope that is NOT
        // cancelled here, so the room really does disconnect; if the process
        // dies first, LiveKit's server drops the participant when the socket
        // closes, and `sessionState` already reports the session dead.
        current?.let { endShare(it) }
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    private fun projectionResultData(intent: Intent?): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA, Intent::class.java)
        } else {
            intent?.getParcelableExtra(EXTRA_RESULT_DATA)
        }
}
