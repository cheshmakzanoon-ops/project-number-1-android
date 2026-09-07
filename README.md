# گرما — Family Messenger

Private Persian messaging + calling app for families (name-only signup, no
email/phone). Built with React + Vite + Convex (backend/database) + LiveKit
(calls) + Web Push (ringing while closed).

## Stack & layout

- `src/` — React frontend (Vite, Tailwind v4, TypeScript)
- `src/convex/` — Convex backend: schema, queries, mutations, actions
  (LiveKit token minting + Web Push run in Node via `"use node"` files)
- `public/` — PWA shell: `sw.js` (network-first cache + incoming-call push),
  manifest, icons

## Convex backend

The app talks to one Convex Cloud deployment, hard-coded in `src/main.tsx`
(`resolveConvexUrl`). There is no `.env` indirection for the backend URL, on
purpose: a build-environment default can never silently redirect the app to a
wrong backend.

Convex env vars used by actions (LiveKit + Web Push) live in the deployment's
env (never in git):

- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — video/audio calls
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — push ringing for incoming calls

## Running

```sh
bun install
bun convex dev --once     # regenerate _generated + typecheck backend
bun run dev              # frontend dev server
bun tsc -b --noEmit      # typecheck
bun run build            # production build (tsc + vite build -> dist/)
```

## Deploying

The frontend is a static Vite build (`dist/`) served by the host platform.
The Convex backend must be pushed to the same Convex Cloud deployment the
frontend points at — if the two drift, screens that call missing functions
show empty/error states instead of content. After changing anything in
`src/convex/`, push the backend to the cloud deployment before shipping the
frontend build.

## Call video verification

Remote video is delivered as SDK `RemoteVideoTrack` objects and attached per
video element (`src/components/RemoteVideoFeed.tsx`); the tests below guard
that path (subscription → snapshot → layout → element → displayed frame).

- Run the suite:

  ```sh
  bun run test:call-video
  bun run typecheck
  bun run build
  ```

- Diagnostics: set `VITE_CALL_VIDEO_DEBUG=1` for opt-in markers only — the
  hook logs connection/subscription stages (`[call-video] roomConnected`,
  `remoteVideoSubscribed`) and RemoteVideoFeed logs ≤1/s receiver-stat samples
  (bytesReceived, framesReceived/framesDecoded, frameWidth/Height,
  attachedElements, play state). Default operation logs no call telemetry.

- Rendering evidence lives on the remote `<video>` element: `data-call-video`
  = `remote-camera` | `remote-screen`, `data-call-video-play` =
  waiting/playing/failed, `data-call-video-frame` = none/rvfc/fallback. A room
  connection or a fulfilled `play()` promise is **not** a displayed frame —
  only the frame marker (or visible motion) proves decoding.

- Manual receiving tests (two independent devices/accounts against a real
  LiveKit deployment; this patch is receiving-side only — Android capture is
  a separate step):
  1. A↔B video call with cameras on: moving local preview and moving remote
     image on both ends; with `VITE_CALL_VIDEO_DEBUG=1`, take two successive
     receiver-stat samples showing increasing decoded frames while motion is
     visible.
  2. Desktop sender shares a changing screen: verify reception, stop sharing,
     and confirm the camera picture resumes with no stale shared content.
  3. Three-person call (grid), camera mute/unmute on a participant,
     minimize/restore of the call overlay, and repeated layout switches.

- Not executed here: real two-identity device/browser calls, screenshare
  reception, and relay/decoder verification require deployed LiveKit
  credentials and hardware not available in this workspace; those checks are
  listed above for a device pass.
