package com.garma.screenshare

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Entry point of the screen-share companion.
 *
 * Flow (nothing more):
 *  1. the browser launches us with `garma-screenshare://share?code=<opaque code>`;
 *  2. we ask Android for MediaProjection consent — the SYSTEM dialog, required
 *     for every new session, which is why this cannot be skipped or automated;
 *  3. on approval we hand the consent result and the code to
 *     [ScreenShareService], which owns the actual capture;
 *  4. this activity goes away; the share is visible through the persistent
 *     notification (with its STOP action) and can outlive the browser tab.
 *
 * The activity deliberately has no UI beyond a single status line, and it
 * never asks for an account, a token or any text input: the code is the only
 * input, and the server decides what it authorizes.
 */
class ScreenShareActivity : AppCompatActivity() {

    private lateinit var status: TextView
    private var handoffCode: String? = null
    private var flowStarted = false

    private val projectionConsent =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            if (result.resultCode != Activity.RESULT_OK || data == null) {
                finishWith(getString(R.string.app_name), "اجازهٔ ضبط صفحه داده نشد.")
                return
            }
            val code = handoffCode
            if (code == null) {
                finishWith(getString(R.string.app_name), "کد اشتراک پیدا نشد.")
                return
            }
            startService(code, result.resultCode, data)
            finish()
        }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { askForProjection() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handoffCode = codeFrom(intent)
        status = TextView(this).apply {
            text = getString(R.string.notification_title)
            textSize = 16f
            gravity = Gravity.CENTER
        }
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(48, 48, 48, 48)
                addView(status)
            },
        )

        if (handoffCode == null) {
            // Launched from the launcher (or with a malformed link): there is
            // nothing to share — say so instead of pretending.
            finishWith(
                getString(R.string.app_name),
                "این برنامه فقط از دکمهٔ «اشتراک صفحه» در تماس گرما باز می‌شود.",
            )
            return
        }
        if (savedInstanceState == null) startFlow()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handoffCode = codeFrom(intent)
        if (handoffCode != null) startFlow()
    }

    private fun startFlow() {
        if (flowStarted) return
        flowStarted = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationPermission()) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        askForProjection()
    }

    private fun askForProjection() {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
        if (manager == null) {
            finishWith(getString(R.string.app_name), "این گوشی ضبط صفحه را پشتیبانی نمی‌کند.")
            return
        }
        // Android shows the mandatory consent sheet for every new session.
        projectionConsent.launch(manager.createScreenCaptureIntent())
    }

    private fun hasNotificationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    private fun startService(code: String, resultCode: Int, data: Intent) {
        ScreenShareNotifications.ensureChannel(this)
        val intent = ScreenShareService.buildStartIntent(this, code, resultCode, data)
        ContextCompat.startForegroundService(this, intent)
    }

    private fun finishWith(title: String, message: String) {
        status.text = "$title\n$message"
        status.postDelayed({ finish() }, 3_500)
    }

    /** Only the opaque code is accepted from the link (custom scheme or App Link). */
    private fun codeFrom(intent: Intent?): String? {
        val uri = intent?.data ?: return null
        val code = uri.getQueryParameter("code") ?: return null
        return code.takeIf { it.length in 20..128 }
    }
}
