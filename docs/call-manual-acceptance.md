# Acceptance checklist: calls, media and screen sharing

Unit tests check lifecycle rules and the isolated browser workflow exercises real
Convex/LiveKit transport. Neither substitutes for the actual family phones.
Run this checklist on **two separate identities on two separate devices** (A and B; on Android, Chrome; plus a desktop browser for the
web screen-share column).

Record the build/commit under test, then walk the list top to bottom. Anything
that fails: repeat it once (to rule out a one-off network blip), then note the
exact step, what was expected and what happened.

## 1. Audio calls

| # | Step (device A)                                  | Expected                                                                 |
| - | ------------------------------------------------ | ------------------------------------------------------------------------ |
| 1 | A opens the chat with B and taps the call button  | B sees the in-app ring when open; separately measure permitted locked/background notification delivery          |
| 2 | B answers                                        | both sides hear each other; both screens show the timer running           |
| 3 | A ends the call                                   | B's screen closes immediately, no leftover ring/vibration                |
| 4 | B calls A back; A answers                         | audio both ways again (the reversed direction must work too)             |
| 5 | A toggles mic off, then on                        | B stops hearing A while off; audio returns on unmute                    |
| 6 | A taps «صدای مخاطب» off, then on                  | B's voice goes silent locally and comes back (this is remote-audio level, not speaker routing) |
| 7 | A ends the call while B is still connecting       | A's screen closes at once; B's side ends too, nothing hangs              |
| 8 | A immediately starts another call                 | the second call connects (no "already in a call")                        |

## 2. Video calls

| # | Step                                             | Expected                                                                 |
| - | ------------------------------------------------ | ------------------------------------------------------------------------ |
| 9 | A calls B with video; B answers                   | both see each other's camera                                            |
| 10 | A toggles camera off, then on                    | B's tile shows "دوربین خاموش است" then the picture returns              |
| 11 | A flips front/back camera (flip button)          | B sees the switch within a second; A's own preview also flips           |
| 12 | A flips camera and hangs up mid-flip             | no crash, no frozen preview, call ends cleanly                          |
| 13 | A flips camera three times quickly               | no stuck "busy" state; the last flip wins                                |
| 14 | A turns off wifi/data for ~10 s, then restores   | "در حال بازیابی…" appears and the call recovers without re-dialling     |
| 15 | Group call: A + B + C, then A leaves             | the call continues for B and C; C's screen keeps working                 |
| 16 | (same A) calls B again after B and C finish                  | A is not incorrectly treated as busy from the prior group; the new call starts           |

## 3. Web screen sharing (desktop Chrome)

| # | Step                                             | Expected                                                                 |
| - | ------------------------------------------------ | ------------------------------------------------------------------------ |
| 17 | Start a video call, tap «اشتراک صفحه»            | the browser picker opens (this tap is what allows it)                    |
| 18 | Pick a window/screen and confirm                 | B sees the shared screen full-size; A sees the "پایان اشتراک صفحه" chip  |
| 19 | Move a window in the shared area                 | B sees movement live (not a single frozen frame)                         |
| 20 | Stop the share from the browser's own "Stop sharing" bar | B's screen tile returns to the camera/avatar at once              |
| 21 | Share again, then hang up while sharing          | share ends, B's tile clears, the picker does not linger                  |
| 22 | Share → stop → share (twice)                     | each cycle works; the button label and "در حال اشتراک…" stay truthful    |

## 4. Android screen sharing (the companion path)

Prerequisites: the companion APK is installed
(`android/README.md` → build & install), and the browser is Chrome on Android.

| # | Step                                                     | Expected                                                                        |
| - | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 23 | A (Android) starts/joins a video call with B, taps «اشتراک صفحه (اپ همراه)» | the app launches with the one-time code; **no token appears in any URL**       |
| 24 | Android shows its own screen-capture consent              | a system dialog appears **every time** (this is Android's rule, not ours)      |
| 25 | Tap «شروع/ضبط» (approve)                                  | a persistent notification appears (with a STOP action); B sees A's phone screen |
| 26 | Open another app on A's phone                             | B sees that app live — the capture is the whole screen, not a camera            |
| 27 | B keeps talking on the call                               | audio is unaffected; A's camera/mic tiles are unchanged                          |
| 28 | Tap STOP in the notification                              | capture ends; the notification disappears; B's screen tile disappears           |
| 29 | Share again (same call)                                   | it works without restarting the phone or the app; B sees the new share          |
| 30 | While sharing, B hangs up                                  | capture ends at the next successful server check; without server responses the 30 s authorization lease expires |
| 31 | While sharing, A taps «پایان اشتراک (اپ همراه)» in the browser | the capture ends and B's tile clears                                      |
| 32 | While sharing, revoke/stop the projection from the system UI | the capture ends and the UI returns to non-sharing on both sides             |
| 33 | After each of steps 28–32: check the phone's status bar    | no screen-cast/recording indicator remains; no camera/mic dot reappears         |
| 34 | Try the same button on an Android browser where the API is absent but the companion is NOT installed | an honest message and the bundled installation guide — never a fake share or invented store listing |

## 5. Failure and edge cases

| # | Step                                                     | Expected                                                                        |
| - | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 35 | Start a call, hang up during connection                  | the red button responds instantly; the call screen is gone immediately          |
| 36 | Start a call while offline, then hang up                 | local screen closes at once; the server row ends once connectivity returns      |
| 37 | Deny microphone permission, then place a call            | a clear Persian microphone explanation; the call still connects                 |
| 38 | Deny camera permission on a video call                   | a clear Persian camera explanation; audio keeps working                         |
| 39 | Two devices, same account, one starts a call             | the other does not silently join; no duplicate rooms                            |

## What is automated already

```sh
bun run test
bun run typecheck
bun run build
```

The complete application/backend suite covers authorization, durable queues,
media ownership, bounded operations, display/read state, protocol validation,
notifications, offline packaging and release-signing contracts. The current
verified count and workflow evidence are in `release-status.md`.

**Verify real browser integration** runs two independent suites on disposable
Linux runners, never the live family backend. Messaging exercises invitations,
real message/media storage, playback, reactions, edits, read receipts, offline
recovery, both search paths, three-person groups and statuses. Calls exercises
actual LiveKit transport with advancing decoded video frames and received audio
packets, mute/camera recovery, connection loss, audio-only redial, decline,
three-person video, and handoff authorization/revocation. Capture inputs are
synthetic; do not record physical-phone rows above as passed from this evidence.

**Verify Android companion** compiles/tests/lints debug and release variants,
verifies a non-debuggable signed release APK and builds the App Bundle. Its
signing key is temporary CI material, not a distribution identity. Native
compilation is no longer an outstanding blocker. Owner-signed private APK
packaging is documented in `family-release.md` and `../android/README.md`.

`scripts/verify-call-lifecycle.mjs` is now a guarded compatibility entry point
for the disposable call suite. It refuses ordinary local execution and configured
external deployment credentials. The old behavior of creating throwaway users
and calls on the canonical backend has been removed. Use the browser workflow;
do not run synthetic writes against parents' accounts or conversations.

## What still requires the actual family devices

Record rows 1–39 on the deployed build and actual phones, with the third family
member for group calls. Focus on hardware permission handling, front/back camera
switching, Android consent and STOP behavior, locked/background ringing and the
actual Wi-Fi/mobile-data paths. These have device/OS/network dependencies that
neither JVM compilation nor synthetic Chromium capture can certify.

Record failures rather than silently narrowing the promised behavior. This
checklist is for three trusted family users, not a public-store certification.
