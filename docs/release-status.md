# Family release status — 17 September 2026

**Not approved for an unattended family rollout.** A passing build is not a live deployment or a two-phone media test.

## Repairs in this pass

- Preserve the authenticated interface and active call controls while Convex reconnects, without treating an explicit null identity as authenticated.
- Keep durable messages in independent localStorage records. Concurrent tabs, late acknowledgements, remounts and conversation changes cannot replace an entire shared queue. Existing queued replies survive migration.
- Bound read receipts to the latest displayed message ID, keep the cursor monotonic, exclude own/deleted messages before limiting unread counts, and preserve same-millisecond neighbors in anchored message windows.
- Delete media only after its last live message/status reference is removed. Expired statuses release unreferenced images, personal status queries are not truncated by somebody else's busy feed, and view receipts are idempotent.
- Cancel Android screen-share startup on stop, serialize session replacement, release LiveKit room resources, validate owner-originated stop packets, and run local revocation checks independently of network polling. The authorization lease expires after 30 seconds without a positive server response.

The schema adds `by_storage` indexes to messages and statuses without changing existing document fields. `markRead.throughId` is optional for older clients; new clients supply it. Checked-in static generated declarations were synchronized with these changes; actual Convex deployment regenerates them again.

## Live backend evidence

The read-only `Check deployed backend` workflow ran at 2026-09-17T09:51:59Z against the canonical EU-West deployment:

- Unknown sessions were not authenticated: pass.
- Unknown sessions were denied the directory: **fail**. The deployed response did not satisfy the required empty-array result; no returned user data was logged or archived.
- A structurally valid public VAPID key was present: pass (not notification delivery proof).
- LiveKit configuration was present and a deliberately malformed handoff was rejected: pass (not real-media proof).
- The repository's `CONVEX_DEPLOY_KEY` secret was unavailable to the workflow. Backend code changes have therefore NOT been deployed by this repair.

## Required release sequence

1. Add a deployment key for the **existing canonical deployment** as the GitHub Actions repository secret `CONVEX_DEPLOY_KEY`. Do not paste credentials into source, logs, issues or chat.
2. Run `Deploy verified backend` from `main`. Its command checks the resolved deployment URL before any backend push and refuses another target. Then rerun `Check deployed backend`; every check must pass.
3. Deploy the matching `dist/` frontend to the actual HTTPS host. This repository does not identify a verified hosting account or frontend URL. A GitHub commit alone does not replace that frontend.
4. Build and distribute a properly signed Android companion through a verified installation route. CI APKs are debug test artifacts, not a production release. The companion does not replace the web messenger.
5. Complete `docs/call-manual-acceptance.md` on two independent accounts and the actual parents' phones/networks. Confirm moving video and audible two-way audio, camera switch, microphone mute, hangup/redial, locked/background ringing, notification actions, screen share/stop/restart, and Wi-Fi/mobile-data recovery. Record which cases pass; do not infer them from mocked tests.

Name-only self-enrollment is still open to anyone who can access the service. Conversation membership checks are not an invitation-only family-registration boundary. Review this exposure before advertising the app as private to a single family.
