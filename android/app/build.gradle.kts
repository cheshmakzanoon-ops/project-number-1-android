plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val signingPath = providers.environmentVariable("GARMA_ANDROID_KEYSTORE").orNull
val signingPassword = providers.environmentVariable("GARMA_ANDROID_STORE_PASSWORD").orNull
val signingAlias = providers.environmentVariable("GARMA_ANDROID_KEY_ALIAS").orNull
val signingKeyPassword = providers.environmentVariable("GARMA_ANDROID_KEY_PASSWORD").orNull
val hasReleaseSigning = listOf(signingPath, signingPassword, signingAlias, signingKeyPassword).all { !it.isNullOrBlank() }
val packagingRelease = gradle.startParameter.taskNames.any {
    val name = it.substringAfterLast(':').lowercase()
    (name.contains("release") && listOf("assemble", "bundle", "package", "install", "publish").any(name::startsWith)) ||
        name in listOf("build", "assemble", "bundle")
}
if (packagingRelease && !hasReleaseSigning) {
    throw GradleException("Release signing is required: configure GARMA_ANDROID_KEYSTORE, STORE_PASSWORD, KEY_ALIAS and KEY_PASSWORD. Debug keys are not release keys.")
}

android {
    namespace = "com.garma.screenshare"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.garma.screenshare"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "1.1"

        // The ONE Convex deployment this companion talks to. It is baked into
        // the build on purpose: the deep link must never be able to point the
        // companion (and therefore a redeemable handoff code) at a server an
        // attacker controls. Change it here, in the same commit as
        // src/main.tsx's CONVEX_URL.
        buildConfigField("String", "CONVEX_URL", "\"https://precise-ptarmigan-412.eu-west-1.convex.cloud\"")

        // Host of the optional https App Link (see AndroidManifest.xml and
        // README.md). The custom scheme below works without it.
        manifestPlaceholders["appLinkHost"] = "garma.app"
    }

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("production") {
                storeFile = file(requireNotNull(signingPath))
                storePassword = signingPassword
                keyAlias = signingAlias
                keyPassword = signingKeyPassword
            }
        }
    }
    buildTypes {
        release {
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("production")
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Official LiveKit Android SDK: room connect + the MediaProjection
    // screen-share entry point (LocalParticipant.setScreenShareEnabled).
    // Pinned to the current release; the API used here (`ScreenCaptureParams`,
    // `RoomEvent.TrackUnpublished`, `LocalParticipant.isScreenShareEnabled`)
    // is the one in this version's documentation.
    implementation("io.livekit:livekit-android:2.28.2")
}
