// Root build file for the Garma screen-share companion.
//
// This module exists for ONE reason: Android's only real screen-capture path
// is MediaProjection, which needs a native app with a foreground service and
// per-session system consent. Chrome/WebView on Android cannot expose
// navigator.mediaDevices.getDisplayMedia(), and no JavaScript can create that
// capability — so the browser hands a one-time code to this app, and this app
// publishes the phone's screen into the SAME LiveKit call.
//
// Toolchain versions deliberately match the ones the LiveKit Android SDK
// itself builds with (AGP 8.7.2 / Kotlin 1.9.25), so the SDK's Kotlin
// metadata is guaranteed to be consumable by this app's compiler.
plugins {
    id("com.android.application") version "8.7.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.25" apply false
}
