# گرما — Family Messenger

Persian-first family messaging and calling, with name-only registration, a React
progressive web app, a Convex backend, LiveKit audio/video rooms, Web Push, and
an Android screen-sharing companion.

**Release status: not approved for unattended family use.** The repository
repairs are tested, but the matching backend/frontend deployment and actual
phones must also pass acceptance. Read [the current release report](docs/release-status.md)
before sending an installation link to family. Name-only registration is open
self-enrollment, not an invitation-only family boundary.

## Project layout

| Path | Responsibility |
| --- | --- |
| `src/components/` | Conversations, voice messages, statuses and call interface |
| `src/lib/` | Call lifecycle, media ownership, durable text outbox and device support |
| `src/convex/` | Server-side authorization, data, calls, storage and push actions |
| `public/` | PWA manifest, service worker and notification actions |
| `android/` | Native screen capture published into the same LiveKit room |
| `.github/workflows/` | Web/native verification, live readiness and guarded backend deployment |

The Android module is **only the screen-sharing companion**. It does not contain
the chat or calling interface. Read [its build and capture instructions](android/README.md).

## Run and verify

```sh
bun install --frozen-lockfile
bun run dev
bun run test:call-video
bun run typecheck
bun run build
```

Despite its historical name, `test:call-video` runs the entire web/backend
regression suite. The reliability repair includes 144 tests covering call
rendering/lifecycle, microphone cleanup, uploads, message retries, multi-tab
queue isolation, notification actions, read receipts, shared-media deletion,
and server-side authorization. Tests involving LiveKit/browser APIs use mocks;
they are not evidence of a real call between two phones.

Production output is `dist/`. `Verify family messenger` installs the committed
lockfile, runs tests, checks TypeScript and builds the frontend. Its short-lived
artifacts contain the tested source, JUnit report and build output, not secrets
or production user data.

## One backend, separate deployment steps

The canonical Convex deployment is hard-coded in `src/main.tsx` and the Android
BuildConfig. Do not silently replace it with a new backend: that would separate
existing accounts, conversations and call state. A development preview's local
proxy is not a production endpoint.

Server-only environment variables belong in Convex, never frontend source:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`

A GitHub push does **not** by itself update Convex or the frontend host.

1. Store a deployment key for the existing canonical backend in the repository's
   GitHub Actions secret `CONVEX_DEPLOY_KEY`.
2. Manually run `Deploy verified backend` from `main`. It runs the regression
   gates and verifies the resolved backend URL before pushing any functions or
   schema changes. A key for a different deployment is refused.
3. Run `Check deployed backend`. It performs read-only checks, creates no users
   or calls, and archives no returned directory data. Its last recorded live
   directory-privacy check failed; see the release report.
4. Deploy the matching `dist/` to the actual HTTPS frontend host. No verified
   hosting account or public frontend URL is recorded in this repository.
5. Distribute a properly signed Android companion through a verified route and
   execute [the two-device acceptance checklist](docs/call-manual-acceptance.md).

The storage repair adds `by_storage` indexes without changing existing document
fields. The new read-receipt `throughId` argument is optional for older clients.
Backend changes must be deployed before the matching new frontend. Checked-in
static `_generated` declarations have been synchronized; the authorized Convex
CLI should regenerate them during deployment rather than treating hand-edited
declarations as proof of a live schema.

## Call video evidence

`RemoteVideoFeed.tsx` attaches SDK `RemoteVideoTrack` objects to actual video
elements. With `VITE_CALL_VIDEO_DEBUG=1`, opt-in logs show connection/subscription
stages and limited receiver statistics. Normal operation does not enable this
telemetry.

Remote video elements expose `data-call-video`, `data-call-video-play`, and
`data-call-video-frame`. A room connection or successful `play()` promise is not
proof of a displayed frame. Verify moving images and audible two-way audio on
independent devices, then camera switching, mute, hangup/redial, screen-share
stop/restart, notification actions and network changes.

Full-screen takeover and reliable ringing while locked/closed depend on the
browser and operating system. A PWA cannot promise native telephone behavior.
Keep another established way to contact family until the deployed build passes
on their actual phones and networks.
