# Private release: the owner and two parents

This procedure deploys the repaired code to the **existing family backend**.
It does not create a replacement database, require a Play Store listing, or
promise behavior that depends on untested phones/networks. The code gates are
listed in `release-status.md`.

## 1. Keep the backend and the family data together

The expected backend is:

```text
https://precise-ptarmigan-412.eu-west-1.convex.cloud
```

Both `src/main.tsx` and the Android build use it. A development preview proxy is
not the production endpoint. Before schema changes, use the existing Convex
project's backup/export facilities and retain the last deployed commit/build.
Do not delete sessions or recreate family accounts as a deployment shortcut.

Set these **server-side Convex environment variables** on that deployment:

| Variable | Required value |
| --- | --- |
| `GARMA_FAMILY_INVITE_CODE` | The family enrollment code, 4–128 characters: letters, digits, `_` or `-`. The owner may deliberately keep one short, memorable value; it is still a credential and must stay out of Git, builds and public messages |
| `GARMA_ALLOWED_ORIGINS` | The exact HTTPS frontend origin; comma-separated only when multiple trusted origins are deliberately supported; no wildcard |
| `LIVEKIT_URL` | The existing reachable `wss://` media endpoint, without embedded credentials, query or fragment |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | A matching server credential pair for that LiveKit service |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | A matching persistent Web Push key pair |

Convex supplies `CONVEX_SITE_URL` for its HTTP actions. The upload handler uses
that HTTPS site origin plus `/media/upload`. Images and voice messages fail
closed if upload origins/authorization are not configured; an ordinary text
message succeeding does not establish that media uploads are ready.

The invite secret controls **new** enrollment. Rotating it stops the old link
from enrolling more devices but does not revoke existing sessions. Existing
legacy identities are intentionally preserved; review the existing directory
before inviting the parents. Do not publish the invite link or place it in a
build-time `VITE_` variable. Name-only registration is no longer open.

## 2. Deploy the matching backend and frontend

Store a deploy key for this exact Convex deployment as repository Actions secret
`CONVEX_DEPLOY_KEY`. Run **Deploy verified backend** from `main`. The workflow
installs the locked dependencies, checks tests/types/build, and verifies the
resolved deployment URL before pushing functions or schema.

Set the repository Actions **variable** `GARMA_FRONTEND_ORIGIN` to the exact
HTTPS frontend origin (no path, credentials, query or fragment); alternatively
supply the `frontend_origin` workflow input. It is not a secret. The deployment
workflow checks this input before publishing and runs the read-only release
checks after the backend deploy completes. A successful function upload alone
no longer produces a successful deployment workflow.

**Check deployed backend** can also be run separately on `main`. All 14 checks
must pass: source API compatibility, private-invitation configuration, exact
HTTPS origin allowlisting, HTTPS upload site, secure LiveKit configuration,
matching P-256 Web Push keys, unauthenticated identity/directory denial, actual
upload preflight, and rejection of unauthenticated/opaque-origin uploads. It
neither creates user data nor reads admin/device credentials. Only booleans,
status codes and fixed diagnostic labels enter `backend-readiness.json`.

These checks do not prove frontend publication, LiveKit credential acceptance,
media/push delivery or physical-device behavior. A missing endpoint, timeout,
malformed response or stale API version fails; none counts as permission denial.
A failed post-deployment check does not roll the backend back automatically.
Correct its configuration or follow the compatible rollback procedure below;
do not announce a family release while it remains red.

Build the same commit with `bun run build`, then deploy **the whole `dist/`**
to the actual HTTPS frontend host. Serve it from the origin root, not under a
repository subpath. Serve existing files as files; only application navigation
should fall back to `index.html`. In particular `/sw.js`, `/assets/*`, the
manifest, icons and `/screen-share-help.html` must not be rewritten to HTML.
Use revalidation/no-cache for HTML, the worker and `version.json`, and immutable
caching for hashed `/assets/*`. Do not inject third-party scripts or relax the
checked-in content-security policy. Retain the prior release's hashed assets
through the rollout so already-open tabs can finish safely.

No verified frontend host/account is recorded in this repository. The GitHub
verification artifact is a tested build, not a deployed website. Never assume
`garma.app`, a development preview URL or a successful GitHub push is the family's
actual frontend. Use the owner's confirmed host and align `GARMA_ALLOWED_ORIGINS`.

## 3. Enroll and install the web messenger

The owner's initial enrollment uses the configured invitation in the URL
fragment (`/#invite=<private-code>`) or the invitation field. Thereafter use
**کپی پیوند دعوت خانواده** in the app and send it privately to each parent.
The app removes the consumed fragment from the address bar. Each parent chooses
a name and grants camera/microphone permissions when needed. Enable notifications
from inside the app and install/add it to the home screen through the browser.

Use a normal persistent browser profile, not private browsing. Device identity
and unsent text live in that browser's storage. Clearing site data, changing
browser profiles or losing the device does not recover the old identity merely
by entering the same name. A new invitation creates a new identity; it is not
an account-recovery operation. Do not instruct parents to clear storage to fix
a temporary network problem.

## 4. Optional Android screen-sharing companion

Ordinary family chat and audio/video calls do not require this APK. For native
screen capture, create/retain **one persistent owner keystore outside Git** and
store these four repository Actions secrets:

```text
GARMA_ANDROID_KEYSTORE_BASE64
GARMA_ANDROID_STORE_PASSWORD
GARMA_ANDROID_KEY_ALIAS
GARMA_ANDROID_KEY_PASSWORD
```

The first is the base64 encoding of that keystore's bytes. Keep a secure backup
of the original keystore and passwords. Never use the two-day disposable key
from ordinary CI as the family's signing identity.

Run **Build signed family companion** on `main`. It builds/tests/lints the
release variant, verifies its signature and non-debuggable package identity,
and creates `signed-family-companion-<commit>`. The artifact contains
`garma-screenshare.apk`, `commit.txt` and `SHA256SUMS`, never the keystore.
Download it as the owner, verify the hash, and send the APK through the family's
trusted channel. Artifact retention is seven days; retain the verified signed
package in the owner's release storage. Repository artifact access follows
GitHub permissions; it is not a separate private distribution service.

Follow Android's installation prompts without disabling its security checks.
Subsequent updates must use the same signing identity; increment the native
`versionCode` for subsequent releases. Android asks for screen-capture consent
for every session. The custom launch scheme works without configuring the
optional `garma.app` App Link. No Play Store publication is required here.

## 5. Family acceptance and rollback

With the owner and both parents, verify a direct video call and a three-person
call, audible two-way speech, camera switching, hangup/redial, one image and
voice message, and a short Wi-Fi/mobile-data interruption. Separately verify
ringing/Answer/Decline while each phone is locked. For the companion, verify
moving screen content, notification STOP, hangup while sharing, and restart.
Record the commit and any device-specific limitation using the acceptance checklist.

Do not label a failed device case as passed because the browser CI uses synthetic
media. A restrictive OS or unreachable media/push service cannot be repaired by
a green unit test. Keep the existing family contact method available during rollout.

If rollout fails, restore the prior known frontend build and compatible backend
code/configuration using the recorded release; do not force-push Git history,
delete the database, rotate signing keys, or clear parents' browser storage.
