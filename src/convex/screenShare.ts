import { internalMutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  callAllowsScreenPublish,
  handoffVerdict,
  shareSessionLive,
  HANDOFF_TTL_MS,
} from "../lib/screenShareProtocol";

/**
 * Screen-share handoff storage — the server side of the Android companion
 * handshake.
 *
 * The web client (which is the authenticated participant) asks the
 * `livekit:requestScreenShareHandoff` action for an opaque one-time code. That
 * action is the only place a code is minted, and it stores just the SHA-256 of
 * the code, so the database never contains a usable credential. The Android
 * companion then posts the raw code to `livekit:redeemScreenShareHandoff`,
 * which consumes it here — exactly once — and mints a restricted LiveKit grant
 * for the auxiliary `<userId>:screen` identity.
 *
 * Everything in this file fails CLOSED: unknown, expired, already-consumed,
 * wrong-call, wrong-user, departed-user and finished-call cases all return
 * null and the caller refuses to mint anything.
 */

/** Hard TTL, capped so a handoff can never be a long-lived credential. */
const MAX_TTL_MS = 60_000;

/**
 * Create the handoff row for a user+call. Called only by the action that
 * already verified (a) the caller's session and (b) that they are a live,
 * publish-allowed participant of that call.
 */
export const insertHandoff = internalMutation({
  args: {
    codeHash: v.string(),
    userId: v.id("users"),
    callId: v.id("calls"),
    ttlMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Drop this user's dead rows opportunistically so the table cannot grow
    // without bound (there is no scheduler in this app) — and, more
    // importantly, so a previous code can never be resurrected later.
    const mine = await ctx.db
      .query("screenShareHandoffs")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of mine) {
      if (row.consumedAt != null || row.expiresAt <= now) await ctx.db.delete(row._id);
    }
    const ttl = Math.min(Math.max(args.ttlMs ?? HANDOFF_TTL_MS, 1_000), MAX_TTL_MS);
    return await ctx.db.insert("screenShareHandoffs", {
      codeHash: args.codeHash,
      userId: args.userId,
      callId: args.callId,
      createdAt: now,
      expiresAt: now + ttl,
    });
  },
});

export type ConsumedHandoff = {
  sessionId: Id<"screenShareHandoffs">;
  userId: Id<"users">;
  callId: Id<"calls">;
  displayName: string;
  themeColor: string;
};

/**
 * Atomically consume one handoff code and resolve the identity it authorizes.
 *
 * A Convex mutation is a serializable transaction, so "check then mark
 * consumed" is genuinely single-use: two racing redemptions of the same code
 * cannot both succeed.
 */
export const consumeHandoff = internalMutation({
  args: { codeHash: v.string() },
  handler: async (ctx, args): Promise<ConsumedHandoff | null> => {
    const now = Date.now();
    const row = await ctx.db
      .query("screenShareHandoffs")
      .withIndex("by_code_hash", (q) => q.eq("codeHash", args.codeHash))
      .first();
    if (handoffVerdict(row, now) !== "ok") return null;
    const r = row!;
    const call = await ctx.db.get(r.callId);
    if (!callAllowsScreenPublish(call?.status)) return null;
    const participant = await ctx.db
      .query("callParticipants")
      .withIndex("by_call_user", (q) => q.eq("callId", r.callId).eq("userId", r.userId))
      .first();
    if (
      !shareSessionLive({
        callStatus: call?.status,
        participantLeftAt: participant?.leftAt ?? null,
        acceptedAt: participant?.acceptedAt ?? null,
        isInitiator: call?.initiatorId === r.userId,
      })
    ) {
      return null;
    }
    const user = await ctx.db.get(r.userId);
    if (!user) return null;
    await ctx.db.patch(r._id, { consumedAt: now });
    return {
      sessionId: r._id,
      userId: r.userId,
      callId: r.callId,
      displayName: user.displayName,
      themeColor: user.themeColor,
    };
  },
});

/**
 * Is this MediaProjection session still allowed to publish? The companion
 * polls this (there is no Convex credential on the device), so a hangup on the
 * web side ends the capture even if the LiveKit stop message is lost.
 * The session id is unguessable and reveals nothing but a boolean.
 */
export const sessionState = query({
  args: { sessionId: v.id("screenShareHandoffs") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sessionId);
    if (!row) return { live: false };
    const call = await ctx.db.get(row.callId);
    const participant = await ctx.db
      .query("callParticipants")
      .withIndex("by_call_user", (q) => q.eq("callId", row.callId).eq("userId", row.userId))
      .first();
    return {
      live: shareSessionLive({
        callStatus: call?.status,
        participantLeftAt: participant?.leftAt ?? null,
        acceptedAt: participant?.acceptedAt ?? null,
        isInitiator: call?.initiatorId === row.userId,
      }),
    };
  },
});

/** Housekeeping hook used by tests and the heartbeat path. */
export async function pruneExpiredHandoffs(ctx: MutationCtx): Promise<void> {
  const now = Date.now();
  const rows = await ctx.db.query("screenShareHandoffs").take(50);
  for (const row of rows) {
    if (row.consumedAt != null || row.expiresAt <= now) await ctx.db.delete(row._id);
  }
}
