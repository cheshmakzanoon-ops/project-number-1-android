# Acceptance checklist: calls, media and screen sharing

Unit tests prove the lifecycle rules; they cannot prove a real call between two
phones. This is the checklist to run on **two separate identities on two
separate devices** (A and B; on Android, Chrome; plus a desktop browser for the
web screen-share column).

Record the build/commit under test, then walk the list top to bottom. Anything
that fails: repeat it once (to rule out a one-off network blip), then note the
exact step, what was expected and what happened.

## 1. Audio calls

| # | Step (device A)                                  | Expected                                                                 |
| - | ------------------------------------------------ | ------------------------------------------------------------------------ |
| 1 | A opens the chat with B and taps the call button  | B's phone rings within ~2 s (notification + in-app ring if open)          |
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
| 16 | (same A) starts a NEW call to B                  | it starts (A is not blocked by the group call that continued)           |

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
| 25 | Tap «شروع/ضبط» (approve)                                  | a persistent notification appears (with an STOP action); B sees A's phone screen |
| 26 | Open another app on A's phone                             | B sees that app live — the capture is the whole screen, not a camera            |
| 27 | B keeps talking on the call                               | audio is unaffected; A's camera/mic tiles are unchanged                          |
| 28 | Tap STOP in the notification                              | capture ends; the notification disappears; B's screen tile disappears           |
| 29 | Share again (same call)                                   | it works without restarting the phone or the app; B sees the new share          |
| 30 | While sharing, B hangs up                                  | A's capture ends within ~5 s (server session check) and the notification clears |
| 31 | While sharing, A taps «پایان اشتراک (اپ همراه)» in the browser | the capture ends and B's tile clears                                      |
| 32 | While sharing, revoke/stop the projection from the system UI | the capture ends and the UI returns to non-sharing on both sides             |
| 33 | After each of steps 28–32: check the phone's status bar    | no screen-cast/recording indicator remains; no camera/mic dot reappears         |
| 34 | Try the same button on an Android browser where the API is absent but the companion is NOT installed | an honest message plus an install link — never a silent failure or a fake share |

## 5. Failure and edge cases

| # | Step                                                     | Expected                                                                        |
| - | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 35 | Start a call, hang up during connection                  | the red button responds instantly; the call screen is gone immediately          |
| 36 | Start a call while offline, then hang up                 | local screen closes at once; the server row ends once connectivity returns      |
| 37 | Deny microphone permission, then place a call            | a clear Persian microphone explanation; the call still connects                 |
| 38 | Deny camera permission on a video call                   | a clear Persian camera explanation; audio keeps working                         |
| 39 | Two devices, same account, one starts a call             | the other does not silently join; no duplicate rooms                            |

## What is automated already

```bash
bun tsc -b --noEmit                       # types
bun run test:call-video                   # 67 tests: lifecycle ownership, backend guards, protocol
node scripts/verify-call-lifecycle.mjs    # live server rules (dev deployment)
```

`bun run test:call-video` covers, on top of the pre-existing SDK-event and
protocol suites:

- a microphone publish that never settles fails with a finite deadline and the
  clear Persian mic error; a publish that answers after a hangup — or after a
  **new** call has started — is released and cannot touch the new call;
- a camera flip that outlives its call is inert, and a `restartTrack` that
  answers after the call ended releases the capture it installed late;
- a screen capture that lands after a hangup is released (no late
  publication); start → stop → start stays truthful; the browser's own "stop
  sharing" ends the share; an auxiliary companion's screen disappears from the
  remote tile the moment it unpublishes;
- an obsolete operation cannot release a **newer** call's microphone/share
  lock, and a room connect that answers after its deadline is closed again;
- hangup completes immediately even when the end mutation never resolves.
- **group-call `already_in_call`** — a member who left a continuing group call
  can start a new call, while a genuinely present member is still refused; this
  one runs the real Convex mutations through `convex-test`
  (`src/convex/calls.test.ts`).

`scripts/verify-call-lifecycle.mjs` proves against the real deployment that:

- a member who left a continuing group call can start a new call, while a
  genuinely present member still cannot (`already_in_call`);
- a live participant can request a handoff code, the code redeems **once** into
  the auxiliary `<userId>:screen` identity for that call's room, the minted
  grant is screen-only and cannot subscribe, a replay is refused, and the
  session verdict the companion polls flips to `false` the moment the call
  ends;
- unissued, malformed, session-less, ended-call and foreign requests are
  refused, and a code minted *before* the call ended is refused after it.

The one handoff rule that is **unit-tested only** is expiry: the server clamps
every TTL to ≤60 s and the verdict rejects an expired row
(`src/lib/screenShareProtocol.test.ts`), but no public API can mint a
short-TTL row, so the live script does not wait for a real code to age out.

## What still needs a real device (not automated here)

- Every row in sections 1–5 above.
- The Android companion **build**: this repository's environment has no JDK,
  Gradle or Android SDK, so `./gradlew :app:assembleDebug` has not been run.
  Every LiveKit call the module makes was instead checked against the official
  `livekit-android` **2.28.2 sources jar** (the exact pinned version), which
  confirms the classes, methods and properties exist as used (see
  `android/README.md` → *Verification status*). That is not a substitute for a
  compiler: the first real Gradle build is still yours to run, and until it
  succeeds treat the Android side of rows 23–34 as **unverified in practice**,
  not as done.
