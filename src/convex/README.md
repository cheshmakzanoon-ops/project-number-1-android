# Family backend

This directory contains the Convex schema, server authorization, conversations,
messages, statuses, calls, upload ownership and push actions. The runtime code is
in `.ts` files; `_generated/` is synchronized by the Convex CLI during deployment.

New device enrollment requires `GARMA_FAMILY_INVITE_CODE`. Existing identities
are preserved; names are not authentication credentials. Uploads require an
allowed frontend origin, an authenticated session and byte/type validation.
Call tokens and native handoffs require current call membership.

Deploy only to the canonical backend shared by `src/main.tsx` and the Android
build. Use the guarded **Deploy verified backend** workflow and follow
[the family release procedure](../../docs/family-release.md). Do not commit
server secrets or run throwaway-user tests against the real family deployment.

Local regression tests use `convex-test`; the browser verification workflow also
deploys these functions to fresh disposable real Convex instances. Its synthetic
accounts are isolated from the family. Passing those tests does not publish the
functions to production.
