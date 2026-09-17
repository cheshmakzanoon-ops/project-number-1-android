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

/** Each share requires Android's consent; the service owns the resulting capture. */
class ScreenShareActivity : AppCompatActivity() {
    private lateinit var status: TextView
    private var handoffCode: String? = null
    private var flowStarted = false
    private val closeActivity = Runnable { finish() }

    private val projectionConsent =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val data = result.data
            if (result.resultCode != Activity.RESULT_OK || data == null) {
                finishWith("اجازهٔ ضبط صفحه داده نشد.")
                return@registerForActivityResult
            }
            val code = handoffCode
            if (code == null) {
                finishWith("کد اشتراک پیدا نشد؛ از داخل تماس دوباره تلاش کن.")
                return@registerForActivityResult
            }
            try {
                ScreenShareNotifications.ensureChannel(this)
                val start = ScreenShareService.buildStartIntent(this, code, result.resultCode, data)
                ContextCompat.startForegroundService(this, start)
                finish()
            } catch (_: RuntimeException) {
                finishWith("اشتراک صفحه شروع نشد؛ به تماس برگرد و دوباره تلاش کن.")
            }
        }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { askForProjection() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handoffCode = savedInstanceState?.getString("handoffCode") ?: codeFrom(intent)
        flowStarted = savedInstanceState?.getBoolean("flowStarted", false) ?: false
        status = TextView(this).apply {
            text = getString(R.string.notification_title)
            textSize = 16f
            gravity = Gravity.CENTER
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
            addView(status)
        })
        if (handoffCode == null) {
            finishWith("این برنامه فقط از دکمهٔ «اشتراک صفحه» در تماس گرما باز می‌شود.")
            return
        }
        // ActivityResultRegistry restores an outstanding consent request after rotation.
        if (!flowStarted) startFlow()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("handoffCode", handoffCode)
        outState.putBoolean("flowStarted", flowStarted)
        super.onSaveInstanceState(outState)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Never let a second deep link substitute another call's code underneath
        // an already visible consent dialog.
        if (flowStarted) return
        val code = codeFrom(intent) ?: return
        status.removeCallbacks(closeActivity)
        setIntent(intent)
        handoffCode = code
        startFlow()
    }

    private fun startFlow() {
        if (flowStarted) return
        flowStarted = true
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationPermission()) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                askForProjection()
            }
        } catch (_: RuntimeException) {
            finishWith("اجازهٔ اشتراک صفحه باز نشد؛ از داخل تماس دوباره تلاش کن.")
        }
    }

    private fun askForProjection() {
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as? MediaProjectionManager
        if (manager == null) {
            finishWith("این گوشی ضبط صفحه را پشتیبانی نمی‌کند.")
            return
        }
        try {
            projectionConsent.launch(manager.createScreenCaptureIntent())
        } catch (_: RuntimeException) {
            finishWith("اجازهٔ اشتراک صفحه باز نشد؛ از داخل تماس دوباره تلاش کن.")
        }
    }

    private fun hasNotificationPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED

    private fun finishWith(message: String) {
        status.text = "${getString(R.string.app_name)}\n$message"
        status.removeCallbacks(closeActivity)
        status.postDelayed(closeActivity, 3_500)
    }

    override fun onDestroy() {
        if (::status.isInitialized) status.removeCallbacks(closeActivity)
        super.onDestroy()
    }

    private fun codeFrom(intent: Intent?): String? {
        val uri = intent?.data ?: return null
        if (!uri.isHierarchical) return null
        val custom = uri.scheme == "garma-screenshare" && uri.host == "share"
        val appLink = uri.scheme == "https" && uri.host == "garma.app" && uri.path == "/screen-share"
        if (!custom && !appLink) return null
        val code = uri.getQueryParameter("code") ?: return null
        return code.takeIf { it.matches(Regex("[A-Za-z0-9_-]{43}")) }
    }
}
