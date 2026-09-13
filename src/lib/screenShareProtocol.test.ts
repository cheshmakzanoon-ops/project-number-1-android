import { describe, expect, it } from "vitest";
import {
  HANDOFF_CODE_BYTES,
  HANDOFF_TTL_MS,
  SCREEN_PARTICIPANT_SUFFIX,
  auxScreenIdentity,
  baseIdentityOf,
  callAllowsScreenPublish,
  handoffVerdict,
  isAuxScreenIdentity,
  isHandoffCodeWellFormed,
  participantMayPublishScreen,
  screenOwnerOf,
  shareSessionLive,
} from "./screenShareProtocol";

/**
 * These rules are the security core of the Android screen-share handoff: a
 * code must be usable exactly once, only inside its TTL, and only for the call
 * and user the server associated it with. They are pure so the backend and the
 * client provably share one implementation.
 */

/** A well-formed code: base64url of HANDOFF_CODE_BYTES random bytes. */
const CODE = "A".repeat(43);

describe("handoff code shape", () => {
  it("accepts only an opaque 43-char base64url code", () => {
    expect(HANDOFF_CODE_BYTES).toBe(32);
    expect(isHandoffCodeWellFormed(CODE)).toBe(true);
    expect(isHandoffCodeWellFormed("")).toBe(false);
    expect(isHandoffCodeWellFormed("short")).toBe(false);
    expect(isHandoffCodeWellFormed("A".repeat(44))).toBe(false);
    // Characters outside base64url (a JWT, a token, a URL…) never pass.
    expect(isHandoffCodeWellFormed("A".repeat(42) + ".")).toBe(false);
    expect(isHandoffCodeWellFormed("A".repeat(42) + "+")).toBe(false);
    expect(isHandoffCodeWellFormed(undefined)).toBe(false);
    expect(isHandoffCodeWellFormed(12345)).toBe(false);
  });

  it("treats a fresh, unconsumed, unexpired row as usable", () => {
    const now = 1_000_000;
    expect(handoffVerdict({ expiresAt: now + HANDOFF_TTL_MS }, now)).toBe("ok");
    expect(handoffVerdict({ expiresAt: now + 1 }, now)).toBe("ok");
  });

  it("rejects expired and replayed codes, and fails closed on unknown rows", () => {
    const now = 1_000_000;
    expect(handoffVerdict({ expiresAt: now - 1 }, now)).toBe("expired");
    // Exactly at expiry is already dead (no clock-skew grace).
    expect(handoffVerdict({ expiresAt: now }, now)).toBe("expired");
    expect(handoffVerdict({ expiresAt: now + 60_000, consumedAt: now - 5 }, now)).toBe("consumed");
    expect(handoffVerdict(null, now)).toBe("consumed");
    expect(handoffVerdict(undefined, now)).toBe("consumed");
  });
});

describe("call state a screen may be published into", () => {
  it("only ringing/active calls accept a companion", () => {
    expect(callAllowsScreenPublish("ringing")).toBe(true);
    expect(callAllowsScreenPublish("active")).toBe(true);
    for (const s of ["ended", "declined", "missed", undefined, null]) {
      expect(callAllowsScreenPublish(s)).toBe(false);
    }
  });

  it("requires a present participant who may publish", () => {
    expect(participantMayPublishScreen({ acceptedAt: 5 }, false)).toBe(true);
    expect(participantMayPublishScreen({}, true)).toBe(true);
    // Still ringing and not the initiator: the caller has not answered, so no.
    expect(participantMayPublishScreen({}, false)).toBe(false);
    // Left the call (a group call that continued without them): never.
    expect(participantMayPublishScreen({ acceptedAt: 5, leftAt: 9 }, true)).toBe(false);
    expect(participantMayPublishScreen({ leftAt: 9 }, true)).toBe(false);
    expect(participantMayPublishScreen(null, true)).toBe(false);
  });

  it("shareSessionLive is the single verdict the Android companion polls", () => {
    expect(
      shareSessionLive({ callStatus: "active", acceptedAt: 1, isInitiator: false }),
    ).toBe(true);
    expect(
      shareSessionLive({ callStatus: "ended", acceptedAt: 1, isInitiator: true }),
    ).toBe(false);
    // Hangup on the web side while the group call continues for others.
    expect(
      shareSessionLive({ callStatus: "active", acceptedAt: 1, participantLeftAt: 2, isInitiator: false }),
    ).toBe(false);
  });
});

describe("auxiliary screen-share participant identity", () => {
  it("derives a suffix-qualified identity that can never equal a user id", () => {
    const id = auxScreenIdentity("u1");
    expect(id).toBe("u1" + SCREEN_PARTICIPANT_SUFFIX);
    expect(id).not.toBe("u1");
    expect(isAuxScreenIdentity(id)).toBe(true);
    expect(isAuxScreenIdentity("u1")).toBe(false);
    expect(isAuxScreenIdentity(SCREEN_PARTICIPANT_SUFFIX)).toBe(false);
    expect(baseIdentityOf(id)).toBe("u1");
    expect(baseIdentityOf("u1")).toBe("u1");
  });

  it("maps an auxiliary track onto the real user's peer", () => {
    const known = ["u2", "u3"];
    expect(screenOwnerOf("u2", "u1", known)).toBe("u2");
    expect(screenOwnerOf("u2" + SCREEN_PARTICIPANT_SUFFIX, "u1", known)).toBe("u2");
    // My own companion is attributed to me (so it is never a remote person).
    expect(screenOwnerOf("u1" + SCREEN_PARTICIPANT_SUFFIX, "u1", known)).toBe("u1");
  });

  it("refuses to render a mystery participant or an impersonation", () => {
    const known = ["u2"];
    // An auxiliary identity for a user who is not on this call: ignored.
    expect(screenOwnerOf("ghost" + SCREEN_PARTICIPANT_SUFFIX, "u1", known)).toBeNull();
    // A plain unknown identity (someone in the room we do not know) is not a
    // screen-share owner either.
    expect(screenOwnerOf("ghost", "u1", known)).toBeNull();
    // Claiming a suffix does not let anyone impersonate a known user: the
    // identity is server-signed, and the base must match a real participant.
    expect(screenOwnerOf("u9" + SCREEN_PARTICIPANT_SUFFIX, "u1", known)).toBeNull();
    // An empty base is never "me".
    expect(screenOwnerOf(SCREEN_PARTICIPANT_SUFFIX, "u1", known)).toBeNull();
  });
});
