# گرما — Family Messenger

Persian-first messaging and audio/video calling for one small, trusted family.
The intended rollout is **the owner and two parents**, not a public messaging
service or a Play Store launch. React/Vite provide the installable web app,
Convex stores family data, LiveKit carries call media, and a separate Android
companion supplies screen capture where the browser cannot.

**Code release candidate for private family use.** The prior Android release
and messaging acceptance failures are resolved. The application passes the
family verification described in [the release report](docs/release-status.md).
This does not mean the existing hosted service has been updated: deployment,
owner signing credentials and the target phones remain separate release steps.

## Included family workflows

Direct and three-person group conversations; text, image and voice messages;
replies, reactions, edits and deletion; displayed-message read receipts;
conversation mute; recent and older-message search; text/image statuses and
view receipts; durable offline outgoing text; audio/video calls, redial,
decline, group participation and reconnection; web screen sharing and the
Android screen-sharing handoff. The production worker precaches the app shell
and lazy-loaded assets without caching private API responses or invite URLs.

**New enrollment requires the private family invitation.** A name alone is not
a valid new account. Existing device sessions are preserved by the migration.
Only authenticated family members can retrieve the invitation. Keep that link
private; it is an enrollment credential, not a public download link. Membership
and upload ownership checks apply independently of enrollment.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/components/` | Conversations, media, statuses and call interface |
| `src/lib/` | Media ownership, retries, outbox, device support and PWA behavior |
| `src/convex/` | Authorization, data, calls, media ownership and push actions |
| `public/` | Manifest, worker, icons and Persian companion-installation guidance |
| `android/` | Native screen capture into an authorized existing LiveKit room |
| `scripts/e2e/` | Disposable real-server browser verification |
| `.github/workflows/` | Verification, guarded backend deployment and family APK packaging |

The Android APK is **only the screen-sharing companion**. Chat and ordinary
calling stay in the web app; parents do not need the companion for those.
There is no claimed Play Store listing. The in-app installation link opens
bundled Persian instructions, including offline, rather than an invented store URL.

## Run and verify

```sh
bun install --frozen-lockfile
bun run dev
bun run test
bun run typecheck
bun run build
```

`test:call-video` is retained as an alias for the same complete test suite.
`bun run build` includes TypeScript, Vite and offline-shell versioning; do not
publish a hand-built directory that omitted the finalization step. Output is
`dist/`, including the worker, hashed assets, icons, manifest and help page.

GitHub Actions runs four checks: `web`, `browser (messaging)`, `browser (calls)`
and `android`. Browser checks use the actual built app, fresh Convex/LiveKit
servers and synthetic media inputs; they do not modify the family deployment.
Native verification includes debug and release variants, lint, actual JVM tests,
signed APK validation and App Bundle generation. Its signing key is disposable
and its release packages are deliberately not distributed.

## Configure and release to the three family members

Follow [the private family release procedure](docs/family-release.md). It lists
the required server configuration, exact signing-secret names and deployment
order. No public store, public self-enrollment or enterprise infrastructure is
required for this scope.

The canonical backend remains the existing one pinned in `src/main.tsx` and
Android `BuildConfig`. Do not replace it with another deployment: doing so would
separate existing identities, messages and calls. A GitHub push by itself does
not publish backend functions or replace the frontend host.

The release procedure uses the existing `Deploy verified backend` workflow,
which refuses a key for another deployment, followed by the matching HTTPS
frontend. `Build signed family companion` produces an owner-signed APK for
private sharing after the owner provides a persistent keystore through Actions
secrets. No signing keys, deployment keys, invitation codes or private user data
belong in Git, logs, issues or chat.

## Verification boundaries

The latest observed live-backend privacy check is recorded separately in the
release report; it is not replaced by a successful isolated test. The repair
has not deployed that backend or identified the real frontend hosting account.

Use [the device acceptance checklist](docs/call-manual-acceptance.md) for the
actual phones. Synthetic browser media proves frame/audio transport, not the
parents' microphones, cameras, permissions, mobile network, Android projection
or locked-screen notification delivery. PWA ringing follows browser/OS policy
and is not a native telephone service. Keep the family's existing contact method
until the configured deployment passes that short real-device check.
