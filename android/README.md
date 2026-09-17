# Android screen-sharing companion — گرما

This module supplies Android MediaProjection capture when the browser cannot
capture the screen. It is **not a second messenger or a full native calling
app**: the web app owns accounts, conversations and calls; the companion joins
one authorized LiveKit room and publishes only screen content.

Android's system consent dialog is required for each capture session. The
companion never substitutes camera capture for screen capture and does not
bypass device consent or foreground-service restrictions.

## Authorization and handoff

The browser requests a handoff from `livekit:requestScreenShareHandoff` during
an eligible call. The server checks the caller's session and call membership,
mints 32 random bytes and stores a hash with a single-use, short-lived redemption
window. The launch URL carries only the opaque code, never the session token,
LiveKit JWT or API secrets.

`BuildConfig.CONVEX_URL` pins the trusted redemption endpoint. A deep link cannot
supply another server address. `ScreenShareActivity` validates the code format,
scheme and host, and binds an outstanding consent dialog to its original code;
a second deep link cannot substitute a different call during consent. Activity
state is restored across recreation without requesting duplicate consent.

Redemption returns a restricted auxiliary `<userId>:screen` identity. It does
not replace the owner's browser participant; the grant restricts publication
to screen sources and disables subscriptions. Receivers attribute its screen
to the existing participant. The one-time code's redemption expiry is distinct
from an already authorized, active screen-share session.

## Capture ownership and stopping

`ScreenShareService` validates the start command and consent result before
promoting the foreground service. Startup has an owned, cancellable job and a
30-second connection deadline. After LiveKit connects, it checks server-side
session liveness again **before** publishing the screen.

The service handles:

- The persistent notification's STOP action, including a stop during startup.
- Explicit stop messages on `garma.screen-share` only when the SDK identifies
  the sender as the real owner and the bounded payload contains `type: stop`.
- Android projection revocation, local screen-track removal, room disconnection,
  companion-task removal and service destruction.
- A server liveness check every five seconds, independently of a one-second
  local watchdog. A positive server response renews a monotonic 30-second
  authorization lease; network errors do not renew it.

Teardown is idempotent. It cancels startup and watchers, disconnects immediately,
and releases the LiveKit room even when track-disable cleanup fails. Session
replacement transfers ownership before old cleanup, so an old session cannot
stop its replacement's service or remove its notification.

`onTaskRemoved` concerns the **companion's** task. Swiping away a separate browser
task does not deliver that callback to the companion; browser/call disappearance
is handled through the server session verdict and bounded authorization lease.
Runtime behavior still needs device testing; these code paths are not a claim
that every manufacturer's background restrictions have been verified.

## Build

Use **JDK 17, Gradle 8.9, Android SDK platform 35 and build-tools 35.0.0**. Set
`ANDROID_HOME` to the SDK. This repository does not include a Gradle wrapper;
use the installed Gradle executable or the `Verify Android companion` workflow.

```sh
cd android
gradle --no-daemon :app:assembleDebug :app:lintDebug :app:testDebugUnitTest
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

AGP 8.7.2, Kotlin 1.9.25 and LiveKit Android 2.28.2 are pinned in the build.
Google/Maven Central provide the normal dependencies; the AudioSwitch group
used by LiveKit is restricted to its required JitPack repository in
`settings.gradle.kts`.

Twelve native unit tests run in **each** of the debug and release variants.
They cover authorization leases, owner-only stopping and companion protocol
validation. These are JVM logic tests, not emulator or real MediaProjection
capture tests. CI assembles and lints both variants, generates a release APK and
App Bundle, verifies the APK signature and rejects a debuggable release. Its
release-signing key is disposable; those test-signed release packages are deleted,
not offered to family. The saved debug APK is for developer QA only.

## Release requirements

Read [the current release report](../docs/release-status.md). The updated Convex
backend and frontend must be deployed together before this companion is offered
to parents. The recorded live directory-privacy check failed and the repository
deployment secret was unavailable during this repair.

Keep the native canonical Convex URL aligned with `src/main.tsx`. The optional
`garma.app` App Link is not proof that this hostname is a deployed frontend.
Changing the optional App Link host requires changing both the manifest's
`appLinkHost` placeholder and the activity's allowed-host check, then serving a
matching `assetlinks.json` for the actual release signing certificate. The
custom `garma-screenshare://share` scheme does not require App Link verification.

For the owner's private family release, use **Build signed family companion**.
It requires `GARMA_ANDROID_KEYSTORE_BASE64`, `GARMA_ANDROID_STORE_PASSWORD`,
`GARMA_ANDROID_KEY_ALIAS` and `GARMA_ANDROID_KEY_PASSWORD` as repository Actions
secrets. It decodes the owner's persistent keystore temporarily, builds/tests/lints
the release APK, verifies signature/package identity, uploads only the APK and
commit/checksum files, and removes signing material. Keep the keystore backed up
outside Git; use the same signing identity for future updates. See
[the family release procedure](../docs/family-release.md) for the exact steps.

The web UI now links to bundled Persian installation guidance, not an unverified
Play Store page. A public listing is not required to share a signed APK with the
two parents. This workflow has not produced an owner-signed package in this
repair because the owner's real signing material was not supplied.

On the actual target Android phones, exercise
[the manual call acceptance checklist](../docs/call-manual-acceptance.md): consent
approval/cancellation, receiver-visible screen motion, notification STOP,
stop during connection, immediate restart, hangup while sharing, projection
revocation and loss of the authorization server. Verify capture and notification
cleanup after each case. No physical-device pass has been performed by this
repair.
