// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Backend regression for the group-call `already_in_call` guard.
 *
 * A group call keeps running for the people still in it after someone hangs
 * up, so their `callParticipants` row survives with `leftAt` set. Counting
 * that row as "busy" locked a departed member out of their own next call —
 * the exact regression pinned down here:
 *
 *   A + B + C join call #1 → A leaves → B and C stay in call #1
 *   → A MUST be able to start call #2, and B must stay refused.
 *
 * Every module of `src/convex` is loaded (type-only files and tests
 * excluded), so these run the REAL mutations rather than a stand-in.
 */
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*s"]);

function setup() {
  return convexTest(schema, modules);
}
type Harness = ReturnType<typeof setup>;

let seq = 0;
/** A throwaway identity with a working device token. */
async function register(t: Harness, label: string) {
  seq += 1;
  const token = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const out = await t.mutation(api.users.register, { inviteCode: "test-family-invite-code-for-automated-tests",
    token,
    displayName: `Test ${label}`,
  });
  return { token, userId: out.user._id };
}

/** A group conversation whose members are the three throwaway identities. */
async function groupOf(
  t: Harness,
  a: { token: string; userId: Id<"users"> },
  b: { token: string; userId: Id<"users"> },
  c: { token: string; userId: Id<"users"> },
) {
  return await t.mutation(api.conversations.startGroup, {
    token: a.token,
    memberIds: [b.userId, c.userId],
  });
}

describe("already_in_call guard", () => {
  it("lets a member who LEFT a continuing group call start another call", async () => {
    const t = setup();
    const a = await register(t, "A");
    const b = await register(t, "B");
    const c = await register(t, "C");
    const conversationId = await groupOf(t, a, b, c);

    const call1 = await t.mutation(api.calls.start, {
      conversationId,
      token: a.token,
      kind: "audio",
    });
    await t.mutation(api.calls.answer, { callId: call1, token: a.token });
    await t.mutation(api.calls.answer, { callId: call1, token: b.token });
    await t.mutation(api.calls.answer, { callId: call1, token: c.token });

    // A hangs up. The group call stays live for B and C.
    await t.mutation(api.calls.end, { callId: call1, token: a.token, status: "ended" });
    const stillLive = await t.query(api.calls.details, { callId: call1, token: b.token });
    expect(stillLive?.call.status).toBe("active");
    expect(stillLive?.isMine).toBe(true);

    // THE REGRESSION: A's lingering participant row (leftAt set) must not read
    // as "already in a call", because A is not in call #1 any more.
    const call2 = await t.mutation(api.calls.start, {
      conversationId,
      token: a.token,
      kind: "video",
    });
    // `myCalls` is untyped through convex-test, so pin the one field asserted.
    const mine = (await t.query(api.calls.myCalls, { token: a.token })) as Array<{
      callId: string;
    }>;
    const myCallIds = mine.map((row) => row.callId);
    expect(myCallIds).toContain(call2);
    // The call A left must not be presented as theirs again.
    expect(myCallIds).not.toContain(call1);

    // …and B, who IS genuinely present in call #1, is still refused: one
    // person must never end up inside two live calls by accident.
    await expect(
      t.mutation(api.calls.start, { conversationId, token: b.token, kind: "audio" }),
    ).rejects.toThrow("already_in_call");

    await t.mutation(api.calls.end, { callId: call2, token: a.token, status: "ended" });
    await t.mutation(api.calls.end, { callId: call1, token: b.token, status: "ended" });
    await t.mutation(api.calls.end, { callId: call1, token: c.token, status: "ended" });
  });

  it("still refuses a present participant whose own call is only ringing", async () => {
    const t = setup();
    const a = await register(t, "A");
    const b = await register(t, "B");
    const c = await register(t, "C");
    const conversationId = await groupOf(t, a, b, c);

    // Nobody has answered yet: the initiator and every ringee are all present
    // in a live (ringing) call, so none of them may stack a second one.
    const call1 = await t.mutation(api.calls.start, {
      conversationId,
      token: a.token,
      kind: "audio",
    });
    await expect(
      t.mutation(api.calls.start, { conversationId, token: a.token, kind: "video" }),
    ).rejects.toThrow("already_in_call");
    await expect(
      t.mutation(api.calls.start, { conversationId, token: b.token, kind: "audio" }),
    ).rejects.toThrow("already_in_call");

    // Once the ring is retired for everyone (everyone declined), the same
    // identities are free again — the guard tracks real presence, not history.
    await t.mutation(api.calls.end, { callId: call1, token: a.token, status: "missed" });
    await t.mutation(api.calls.end, { callId: call1, token: b.token, status: "declined" });
    await t.mutation(api.calls.end, { callId: call1, token: c.token, status: "declined" });
    const again = await t.mutation(api.calls.start, {
      conversationId,
      token: a.token,
      kind: "audio",
    });
    expect(again).toBeTypeOf("string");
    await t.mutation(api.calls.end, { callId: again, token: a.token, status: "missed" });
  });
});

beforeEach(() => vi.stubEnv("GARMA_FAMILY_INVITE_CODE", "test-family-invite-code-for-automated-tests"));
afterEach(() => vi.unstubAllEnvs());
