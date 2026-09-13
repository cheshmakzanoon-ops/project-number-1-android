package com.garma.screenshare

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * The persistent, user-visible notification that MUST accompany a
 * MediaProjection capture (Android requires a foreground service with a
 * visible notification while the screen is being read).
 *
 * It carries a STOP action, which is one of the three ways a share ends:
 *  1. the STOP button here,
 *  2. the call ending / the user hanging up (the service polls the call and
 *     also listens for the web app's stop message),
 *  3. Android revoking the projection (the capture track ends).
 */
object ScreenShareNotifications {

    const val CHANNEL_ID = "garma-screen-share"
    const val NOTIFICATION_ID = 4711

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.notification_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    fun build(context: Context): Notification {
        val stopIntent = Intent(context, ScreenShareService::class.java).apply {
            action = ScreenShareService.ACTION_STOP
        }
        val stopPending = PendingIntent.getForegroundService(
            context,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_share)
            .setContentTitle(context.getString(R.string.notification_title))
            .setContentText(context.getString(R.string.notification_text))
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(
                R.drawable.ic_stat_share,
                context.getString(R.string.notification_stop),
                stopPending,
            )
            .build()
    }

    /** Remove the share notification when a share ends. */
    fun clear(context: Context) {
        try {
            NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
        } catch (_: Throwable) {
            /* nothing to remove */
        }
    }
}
