/**
 * Screen-share handoff protocol — the ONE place the security-relevant rules
 * live, shared verbatim by the Convex backend and the web client.
 *
 * Why a native companion at all:
 * `navigator.mediaDevices.getDisplayMedia()` is not available in the Android
 * Chrome/WebView environment (there is no web API that can force it to exist).
 * Android's only real screen-capture path is MediaProjection, which requires a
 * native app with a foreground service and per-session system consent. So the
 * call UI has two genuine paths, never a fake one:
 *
 *  1. browsers that really expose display capture  → web capture (LiveKit)
 *  2. Android browsers that do not                 → the companion app joins
 *     the SAME LiveKit room as an auxiliary participant and publishes the
 *     screen with MediaProjection
 *
 * Handing LiveKit credentials to that companion must never put a Convex token,
 * a LiveKit JWT, a room credential or an API secret in a reusable URL. Instead
 * the browser asks the server for a SHORT-LIVED, SINGLE-USE, RANDOM code and
 * passes only that opaque code to the companion, which exchanges it
 * server-side (once) for the restricted LiveKit grant it needs.
 *
 * This module is intentionally free of DOM/Node APIs so both runtimes can
 * import it.
 */

/** A handoff code is only accepted for this long after it was created. */
export const HANDOFF_TTL_MS = 60_000;

/**
 * LiveKit identity suffix marking the auxiliary MediaProjection publisher for
 * a user. The identity is minted by the server inside a signed JWT, so a
 * client can neither choose it nor impersonate another user with it.
 */
export const SCREEN_PARTICIPANT_SUFFIX = ":screen";

/** How long the companion's restricted LiveKit token is valid. */
export const SCREEN_TOKEN_TTL = "1h";

/** 32 random bytes, base64url encoded (no padding). */
export const HANDOFF_CODE_BYTES = 32;
/** base64url of 32 bytes is always 43 characters. */
export const HANDOFF_CODE_LENGTH = 43;
const HANDOFF_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/** The auxiliary LiveKit identity for one user's screen-share companion. */
export function auxScreenIdentity(userId: string): string {
  return `${userId}${SCREEN_PARTICIPANT_SUFFIX}`;
}

/** True when an identity is the auxiliary screen-share participant. */
export function isAuxScreenIdentity(identity: string): boolean {
  return identity.length > SCREEN_PARTICIPANT_SUFFIX.length && identity.endsWith(SCREEN_PARTICIPANT_SUFFIX);
}

/**
 * The real user behind a LiveKit identity, or `null` for a normal participant
 * (a plain user id is returned unchanged only through {@link screenOwnerOf}).
 */
export function baseIdentityOf(identity: string): string {
  return isAuxScreenIdentity(identity) ? identity.slice(0, -SCREEN_PARTICIPANT_SUFFIX.length) : identity;
}

/**
 * Map a LiveKit identity onto the RemotePeer it belongs to, or `null` when the
 * participant must not be rendered at all.
 *
 * Rules (requirement: "never render a fake mystery participant", "never let
 * client-provided metadata impersonate another user"):
 * - a normal identity is its own owner when it is a known call participant;
 * - an auxiliary `<user>:screen` identity only maps onto a user this client
 *   already knows is on the call (or onto me myself, for my own companion);
 * - anything else — including an identity that claims a suffix for a user who
 *   is not on this call — is ignored.
 */
export function screenOwnerOf(
  identity: string,
  myUserId: string,
  knownUserIds: ReadonlySet<string> | readonly string[],
): string | null {
  const known = Array.isArray(knownUserIds) ? knownUserIds : Array.from(knownUserIds);
  const isKnown = (id: string) => id === myUserId || known.includes(id);
  if (!isAuxScreenIdentity(identity)) return isKnown(identity) ? identity : null;
  const base = baseIdentityOf(identity);
  return isKnown(base) ? base : null;
}

/** Only a well-formed, opaque code is worth hashing or forwarding. */
export function isHandoffCodeWellFormed(code: unknown): code is string {
  return typeof code === "string" && HANDOFF_CODE_RE.test(code);
}

/** Lifecycle verdict for one stored handoff row. */
export type HandoffVerdict = "ok" | "expired" | "consumed";

/**
 * Can this handoff row be redeemed right now? Fails closed on everything:
 * unknown/consumed rows are dead, and an expired row can never be reused.
 */
export function handoffVerdict(
  row: { expiresAt: number; consumedAt?: number } | null | undefined,
  now: number,
): HandoffVerdict {
  if (!row) return "consumed";
  if (row.consumedAt != null) return "consumed";
  if (!(row.expiresAt > now)) return "expired";
  return "ok";
}

/**
 * Is the call still in a state where a screen may be published into it?
 * A call that ended (or that was never ringing/active) cannot be joined by a
 * companion, however fresh the code is.
 */
export function callAllowsScreenPublish(
  status: string | null | undefined,
): boolean {
  return status === "ringing" || status === "active";
}

/**
 * May this participant publish a screen into the call? Same rule the normal
 * token action applies: still present, and either the initiator (who is in the
 * room waiting for answers) or someone who already answered.
 */
export function participantMayPublishScreen(
  row: { acceptedAt?: number; leftAt?: number } | null | undefined,
  isInitiator: boolean,
): boolean {
  if (!row) return false;
  if (row.leftAt != null) return false;
  return row.acceptedAt != null || isInitiator;
}

/**
 * A MediaProjection session the companion may still publish for. The companion
 * polls this so a hangup on the web side always ends the capture even when the
 * stop message never arrives.
 */
export function shareSessionLive(args: {
  callStatus: string | null | undefined;
  participantLeftAt?: number | null;
  acceptedAt?: number | null;
  isInitiator: boolean;
}): boolean {
  if (!callAllowsScreenPublish(args.callStatus)) return false;
  return participantMayPublishScreen(
    { acceptedAt: args.acceptedAt ?? undefined, leftAt: args.participantLeftAt ?? undefined },
    args.isInitiator,
  );
}
