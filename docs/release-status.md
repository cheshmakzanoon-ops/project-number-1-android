# Family release status — 17 September 2026

## Scope and decision

The release scope is **one owner and two parents in a trusted private family**,
not public self-enrollment, a commercial messaging service or a Play Store
submission. The previously identified code-level blockers have been repaired.
The repository is a **private-family release candidate with automated code
verification**, not evidence that the existing hosted service has been updated.

The remaining operational requirements are the existing deployment's credentials
and configuration, the matching HTTPS frontend, the owner's persistent APK
signing identity when native screen sharing is needed, and the actual phones.
They are not substituted by test credentials or an invented installation URL.
Follow `family-release.md`; do not distribute a debug/CI-signed companion as the
family's final release.

## Recorded verification

At application commit `a5b3075a662c892e48fcdff12f42ee27339139e8`, the saved
GitHub evidence verifies:

| Gate | Observed result |
| --- | --- |
| Application/backend regression suite | 344 passing tests; TypeScript and production build passed |
| Real-browser messaging | 20 passing scenarios, no uncaught page errors |
| Real-browser calling | 10 passing scenarios, no uncaught page errors |
| Android debug | APK build, lint and 12 actual JVM tests passed |
| Android release | APK/App Bundle build, lint and 12 actual JVM tests passed; signature and non-debuggable APK verified with disposable CI key |

Browser evidence: Actions run `35235062728`. Native evidence: run
`35235062718`. The application build/test workflow is run `35235062588`.
Artifacts retain the exact commit and test results; the native report records
zero lint errors and three version/target advisories per variant. Vite also
reports a non-blocking size advisory for the lazy media SDK chunk. These warnings
have not been hidden or described as zero-warning output.

At follow-up commit `aa38eaea8d01ca246599ced63c2a8fe592bc4ff9`, all four
code checks passed, including the offline-guide scenario and 346 unit/regression
tests. This continuation adds 50 tests for the deployment configuration and
read-only release probe: **396 tests pass locally**, along with TypeScript and
the production build. Current-commit CI must still pass before release selection.

The release probe now checks the source API version, private-invitation setup,
exact upload origins, upload route behavior and a cryptographically matching
Web Push key pair, not merely the presence of a public key. Malformed origin
entries fail closed at the upload handler as well as in the readiness check.
The actual Node configuration action is also exercised on the disposable backend.
`Deploy verified backend` runs the read-only checks after deploying; a function
upload alone no longer counts as a successful release. The independent manual
check needs only the frontend origin, never a deployment key or device token.

## What the family scenarios exercise

The browser messaging suite uses the built app with its shipped content-security
policy and real disposable Convex storage. It covers invitation-only enrollment,
invitation copying, DM deduplication, two-way messages/read receipts, replies,
reactions, editing/deletion, decoded image uploads, recorded voice playback,
durable offline outgoing text and offline reload. It exercises recent search
hits separately from older hits outside the 100-message live window, conversation
mute, the full-screen image viewer, three-person group messages/deduplication,
and text/image statuses with viewing and deletion.

The calling suite uses real Convex and LiveKit with independent authenticated
browser contexts. It requires advancing decoded remote video frames and received
audio packets, not just a connected room or a successful `play()` promise. It
covers mic/camera controls, temporary signaling loss, hangup, audio-only redial,
decline, three-person video with two remote feeds per participant, and native
handoff replay rejection, screen-only credentials and post-hangup revocation.
Camera and microphone inputs are synthetic. This is not Android MediaProjection
execution or locked-phone notification delivery evidence.

## Repairs that close the previous failures

The release workflow now supplies the exact signing variables read by Gradle;
both native variants actually compile/test/lint. A recent search hit correctly
scrolls inside the loaded conversation; only an older hit needs the separate
surrounding-message window. Both behaviors are covered without skipping the
later group/status tests.

The unverified Play Store destination has been replaced by bundled Persian
installation guidance. The guide is included in the offline shell and build
revision. Help windows neither suppress incoming-call notifications nor consume
Answer/Decline commands. A guarded manual workflow packages an APK using the
owner's persistent key, verifies it, and never uploads that key.

Earlier repairs remain covered: media upload authorization/ownership; preserved
voice/text drafts and retry identity; microphone release before calls; bounded
startup and operations; stale callback isolation; durable multi-tab outboxes;
read cursors bounded to displayed messages; shared-file retention; status
lifecycle safety; private enrollment; notification registration; native consent,
authorization leases, owner-only stopping and capture cleanup.

## Live deployment evidence is separate

The historical read-only backend check at **2026-09-17T09:51:59Z** found that an
unknown session was not authenticated, but the directory response did not meet
the required empty-array assertion. No returned directory data was archived.
A public push key and LiveKit configuration were present; neither proves delivery.
The repository deployment secret was unavailable in that run.

**This repair has not deployed the changed backend or frontend.** No verified
frontend hosting account or public app URL was identified. The historical failed
live check is not silently marked passed because an isolated backend now passes.
After the owner-authorized deployment, rerun the live checks and the family
phone checklist. Private enrollment and allowed upload origins must be configured
on that real backend before sending invitations to the parents.

The old open-enrollment statement is no longer accurate for this code:
`GARMA_FAMILY_INVITE_CODE` is mandatory for new accounts. Existing device sessions
are preserved, so the owner must review any identities already present before
assuming that invitation rotation limits the existing directory to three people.
