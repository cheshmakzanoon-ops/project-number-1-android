# اپ همراه اشتراک صفحه (Android screen-share companion)

This module exists for **one** reason, and it is not optional:

> Chrome/WebView on Android does **not** expose
> `navigator.mediaDevices.getDisplayMedia()`, and **no JavaScript can create
> that capability**. Android's only real screen-capture path is
> [MediaProjection](https://developer.android.com/media/grow/media-projection),
> which requires a native app, a foreground service and Android's own consent
> dialog for every session.

So the web call UI has two genuine paths (never a fake one):

| device                                              | path                                        |
| --------------------------------------------------- | ------------------------------------------- |
| browser that really implements display capture       | web screen share (LiveKit, `getDisplayMedia`) |
| Android browser without working display capture      | **this companion app**, publishing into the SAME LiveKit room as an auxiliary participant |
| anything else (e.g. iOS Safari)                      | an honest "not supported here" message      |

The companion is **not** a second messaging client. It has no account, no
contacts, no chat and no stored credentials; it joins one call, publishes the
screen, and leaves.

## How the handoff works (and why it is safe)

1. The user taps **اشتراک صفحه** in the call (on a supported browser this whole
   path is never taken).
2. The web client asks the server
   (`livekit:requestScreenShareHandoff`) for a handoff code. The server
   re-verifies that the caller is an authenticated, live, publish-allowed
   participant of that exact call.
3. The server mints **32 random bytes** (base64url) and stores only their
   SHA-256, associated server-side with the user and the call, with a **≤60 s**
   TTL and single-use semantics.
4. The browser launches this app with `intent://share?code=<code>` — only the
   opaque code travels. No Convex token, no LiveKit JWT, no API secret, no room
   credential, and **no server address**: the deployment URL is baked into
   `BuildConfig.CONVEX_URL` at build time, so a crafted link cannot redirect the
   code to an attacker's server.
5. The app posts the code to `livekit:redeemScreenShareHandoff`, which consumes
   it **exactly once** (a Convex mutation is a serializable transaction) and
   mints a restricted LiveKit grant:
   - identity `"<userId>:screen"` — **auxiliary**, so it can never evict or
     replace the user's own browser participant;
   - `canPublishSources = [screen_share, screen_share_audio]` — screen only;
   - `canSubscribe = false` — it is a capture pipe, not a listener.
6. Remote clients attribute that track to the **real user's** existing tile
   (`src/lib/screenShareProtocol.ts` → `screenOwnerOf`); an auxiliary identity
   for someone not on the call is ignored, so no mystery participant ever
   appears and metadata cannot impersonate anyone.

Replay, expiry, a foreign call, a departed user or a finished call all fail
closed — the server mints nothing.

## Stopping a share (all of these are wired)

- **STOP action** in the persistent notification.
- The **browser's own stop**: the web app publishes a stop request on the
  `garma.screen-share` LiveKit data topic; the service also **polls the server
  session every 5 s**, so a lost message or a hangup still ends the capture.
- **Call ended / user left** (the server says the share session is not live).
- **Projection revoked** or stopped from the system UI → the screen track
  stops being published, which the service notices within one second
  (`LocalParticipant.isScreenShareEnabled`) → it releases everything.
- **The browser task is swiped away** → `onTaskRemoved` ends the share.
- **Service destroyed** by the system → `onDestroy` releases the track, the
  room and the notification (again within the second-level liveness check, and
  unconditionally server-side once the socket drops).

In every case: screen track unpublished, MediaProjection session released by
LiveKit's capturer, auxiliary participant disconnected, foreground service
stopped, notification removed, remote tiles cleared, browser UI back to
non-sharing. Starting a second share afterwards works without restarting the
phone or the app.

## Build & install

```bash
cd android
./gradlew :app:assembleDebug          # or :app:assembleRelease
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Requires: JDK 17, Android SDK with platform 35 and build-tools, `ANDROID_HOME`
set. The first build downloads the LiveKit Android SDK from Maven Central.

Toolchain versions are pinned to the ones the LiveKit Android SDK builds
itself with (AGP 8.7.2, Kotlin 1.9.25, `livekit-android` 2.28.2), so the SDK's
Kotlin metadata is guaranteed to be readable by this module's compiler.

Before shipping:

1. Set the real Convex deployment in `app/build.gradle.kts`
   (`buildConfigField("String", "CONVEX_URL", …)`) — it must match
   `CONVEX_URL` in `src/main.tsx`.
2. (Optional, recommended) Publish an App Link: set `appLinkHost` in
   `app/build.gradle.kts` to the web app's host and serve
   `https://<host>/.well-known/assetlinks.json` containing the release signing
   key's SHA-256, then point the UI at
   `https://<host>/screen-share?code=…`. Without it the `intent://` custom
   scheme above is used, which needs no domain verification.
3. Sign the release with a keystore you keep out of the repository.

## Verification status — read this

- The **server side** of the handoff is deployed and verified end-to-end
  against the live dev deployment (`node scripts/verify-call-lifecycle.mjs`):
  a live participant gets a code, the code redeems **once** into the
  auxiliary `<userId>:screen` identity for that call's room, the grant is
  screen-only and cannot subscribe, replay is refused, and the session verdict
  the companion polls flips to `false` the moment the call ends. Unissued,
  malformed, expired, foreign and ended-call requests are all refused.
- The **web side** of the dual path is covered by unit tests
  (`src/lib/screenShare.test.ts`, `src/lib/screenShareProtocol.test.ts`,
  `src/lib/useCallkit.lifecycle.test.tsx`).
- The **native module in this directory has NOT been compiled**: this
  environment has no JDK, no Gradle and no Android SDK, so no Gradle build
  could be run here. What *was* done instead is a line-by-line check of every
  LiveKit API this module calls against the **official sources jar of the
  exact pinned version**
  (`io.livekit:livekit-android:2.28.2` → `livekit-android-2.28.2-sources.jar`),
  which is stronger than reading the docs: the declarations below were read
  out of the SDK's own Kotlin sources. The declared toolchain versions were
  also confirmed to exist on Maven Central / Google's Maven repo (AGP 8.7.2,
  Kotlin 1.9.25, appcompat 1.7.0, livekit-android 2.28.2). **This is not a
  compiler** — only `./gradlew :app:assembleDebug` can prove the module
  compiles.

  | call in this module | declaration in `livekit-android-2.28.2-sources.jar` |
  | --- | --- |
  | `LiveKit.create(applicationContext)` | `LiveKit.kt`: `fun create(appContext, options = …, overrides = …): Room` |
  | `room.connect(url, token)` (suspend) | `Room.kt`: `suspend fun connect(url: String, token: String, options = …)` |
  | `room.disconnect()` | `Room.kt`: `fun disconnect()` (non-suspend) |
  | `room.events.collect { }` | `Room.kt`: `val events = eventBus.readOnly(): EventListenable<RoomEvent>`; `EventListenable.kt`: `suspend inline fun <T> EventListenable<T>.collect(…)` |
  | `room.localParticipant` | `Room.kt`: `val localParticipant: LocalParticipant` |
  | `setScreenShareEnabled(true, ScreenCaptureParams(intent))` | `LocalParticipant.kt`: `suspend fun setScreenShareEnabled(enabled: Boolean, screenCaptureParams: ScreenCaptureParams? = null): Boolean` |
  | `ScreenCaptureParams(intent)` | `ScreenCaptureParams.kt`: `class ScreenCaptureParams(val mediaProjectionPermissionResultData: Intent, notificationId: Int? = null, notification: Notification? = null, onStop: (() -> Unit)? = null)` |
  | `LocalParticipant.isScreenShareEnabled` | inherited from `Participant.kt`: `val isScreenShareEnabled by flowDelegate(…)` (a synchronously readable state-flow delegate) |
  | `RoomEvent.TrackUnpublished` | `RoomEvent.kt`: `class TrackUnpublished(room: Room, val publication: TrackPublication, val participant: Participant)` |
  | `publication.source == Track.Source.SCREEN_SHARE` | `Track.Source` enum contains `SCREEN_SHARE` / `SCREEN_SHARE_AUDIO` |
  | `RoomEvent.DataReceived.topic` | `RoomEvent.kt`: `class DataReceived(room, val data, val participant: RemoteParticipant?, val topic: String?, val encryptionType)` |
  | `RoomEvent.Disconnected` | `RoomEvent.kt`: `class Disconnected(room, val error: Exception?, val reason: DisconnectReason)` |

  **Remaining environment-only verification:** run
  `./gradlew :app:assembleDebug` (and `:app:testDebugUnitTest` if unit tests
  are added) on a machine with JDK 17 + Android SDK 35, then install on a real
  device and walk the Android rows of `docs/call-manual-acceptance.md`
  (consent dialog → receiver sees the screen → STOP from the notification →
  share again → hang up while sharing → nothing left running).
