import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { userIdFromToken } from "./auth";
import type { Id } from "./_generated/dataModel";

/** Start an outbound call to a conversation (rings every member but us). */
export const start = mutation({
  args: {
    conversationId: v.id("conversations"),
    token: v.string(),
    kind: v.union(v.literal("audio"), v.literal("video")),
  },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) throw new Error("unauthorized");

    // must be a member
    const membership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.eq(q.field("userId"), me))
      .first();
    if (!membership) throw new Error("not_member");

    // One live call per person, enforced server-side: if this user already
    // participates in a ringing or active call (a double-tap that raced past
    // the client guard, a second device, or a call left open before a
    // reload), refuse to stack another ringing row on top of it.
    const myLive = await ctx.db
      .query("callParticipants")
      .withIndex("by_user", (q) => q.eq("userId", me))
      .collect();
    for (const p of myLive) {
      const live = await ctx.db.get(p.callId);
      if (live && (live.status === "ringing" || live.status === "active")) {
        throw new Error("already_in_call");
      }
    }

    const now = Date.now();
    const members = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .collect();
    const callId = await ctx.db.insert("calls", {
      conversationId: args.conversationId,
      initiatorId: me,
      kind: args.kind,
      status: "ringing",
      startedAt: now,
    });
    // Every ringed member becomes a participant so each device's
    // "myCalls" query sees the ringing call and can answer it (LiveKit
    // provides the actual media path).
    for (const m of members) {
      await ctx.db.insert("callParticipants", {
        callId,
        userId: m.userId,
        joinedAt: now,
      });
      if (m.userId !== me) {
        await ctx.db.insert("callSignals", {
          callId,
          fromUserId: me,
          toUserId: m.userId,
          type: "ring",
          createdAt: now,
        });
      }
    }
    return callId;
  },
});

export const details = query({
  args: { callId: v.id("calls"), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return null;
    const call = await ctx.db.get(args.callId);
    if (!call) return null;
    const participants = await ctx.db
      .query("callParticipants")
      .withIndex("by_call", (q) => q.eq("callId", args.callId))
      .collect();
    const members = [];
    for (const p of participants) {
      const u = await ctx.db.get(p.userId);
      if (u) members.push({ userId: u._id, displayName: u.displayName, themeColor: u.themeColor, online: Date.now() - u.lastSeenAt < 60_000 });
    }
    const isMine = participants.some((p) => p.userId === me);
    return {
      call,
      members,
      isMine,
      meIsInitiator: call.initiatorId === me,
    };
  },
});

/** Everything I'm currently ringing about or an active participant of. */
export const myCalls = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];

    const parts = await ctx.db
      .query("callParticipants")
      .withIndex("by_user", (q) => q.eq("userId", me))
      .collect();

    const now = Date.now();

    const out: Array<{
      callId: Id<"calls">;
      conversationId: Id<"conversations">;
      kind: "audio" | "video";
      status: "ringing" | "active" | "ended" | "declined" | "missed";
      initiatorId: Id<"users">;
      startedAt: number;
      otherName: string;
      otherColor: string;
      initiatedByMe: boolean;
    }> = [];

    for (const p of parts) {
      const call = await ctx.db.get(p.callId);
      if (!call) continue;
      if (call.status !== "ringing" && call.status !== "active") continue;
      // A ring nobody answered ages out server-side ~75s after it started
      // (see cleanupStale below). Don't surface those ghosts here — the
      // client's ring timers end at 45s/60s, so without this filter a screen
      // reopened later could briefly re-present a ring that is already over.
      if (call.status === "ringing" && now - call.startedAt > 75_000) continue;

      // find a member who isn't me
      const otherParts = await ctx.db
        .query("callParticipants")
        .withIndex("by_call", (q) => q.eq("callId", call._id))
        .collect();
      const otherId = otherParts.find((o) => o.userId !== me)?.userId;
      let otherName = "…";
      let otherColor = "#8a6340";
      if (otherId) {
        const u = await ctx.db.get(otherId);
        if (u) {
          otherName = u.displayName;
          otherColor = u.themeColor;
        }
      }
      out.push({
        callId: call._id,
        conversationId: call.conversationId,
        kind: call.kind,
        status: call.status,
        initiatorId: call.initiatorId,
        startedAt: call.startedAt,
        otherName,
        otherColor,
        initiatedByMe: call.initiatorId === me,
      });
    }
    // Newest first: the client reconciles from index 0, and a stale row from
    // a crashed call must never shadow a fresh ring.
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  },
});

/** Set the call active (callee answering / caller confirming). */
export const answer = mutation({
  args: { callId: v.id("calls"), token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    const call = await ctx.db.get(args.callId);
    if (!call) return;
    // Only a still-ringing call may be answered. Without this guard a late
    // accept after the caller hung up would resurrect the call into a room
    // with nobody in it.
    if (call.status !== "ringing") return;
    await ctx.db.patch(args.callId, { status: "active" });
  },
});

/** End, decline, or mark missed. */
export const end = mutation({
  args: {
    callId: v.id("calls"),
    token: v.string(),
    status: v.optional(
      v.union(v.literal("ended"), v.literal("declined"), v.literal("missed")),
    ),
  },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    const call = await ctx.db.get(args.callId);
    if (!call) return;
    if (call.status === "ended") return;
    const wanted = args.status ?? "ended";
    // A call that has been ANSWERED may only be terminated by an explicit
    // "ended". Stale "missed"/"declined" signals — a ring timeout that fired
    // on a second device, a busy-decline that raced an accept, an app that
    // was reopened after the call connected — must never kill a live call.
    if (call.status === "active" && wanted !== "ended") return;
    await ctx.db.patch(args.callId, {
      status: wanted,
      endedAt: Date.now(),
    });
    const parts = await ctx.db
      .query("callParticipants")
      .withIndex("by_call", (q) => q.eq("callId", args.callId))
      .collect();
    for (const part of parts) {
      await ctx.db.patch(part._id, { leftAt: Date.now() });
      if (part.userId === me) continue;
      await ctx.db.insert("callSignals", {
        callId: args.callId,
        fromUserId: me,
        toUserId: part.userId,
        type: "hangup",
        createdAt: Date.now(),
      });
    }
  },
});

export const ackSignals = mutation({
  args: { callId: v.id("calls"), token: v.string(), cutoff: v.number() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    const mine = await ctx.db
      .query("callSignals")
      .withIndex("by_call_to", (q) => q.eq("callId", args.callId).eq("toUserId", me))
      .filter((q) => q.lte(q.field("createdAt"), args.cutoff))
      .collect();
    for (const s of mine) {
      if (!s.deliveredAt) await ctx.db.patch(s._id, { deliveredAt: Date.now() });
    }
  },
});

/** Signals addressed to me for a call that haven't been acked yet. */
export const pendingSignals = query({
  args: { callId: v.id("calls"), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];
    const sigs = await ctx.db
      .query("callSignals")
      .withIndex("by_call_to", (q) => q.eq("callId", args.callId).eq("toUserId", me))
      .filter((q) => q.eq(q.field("deliveredAt"), undefined))
      .order("asc")
      .collect();
    return sigs.map((s) => ({
      _id: s._id,
      fromUserId: s.fromUserId,
      toUserId: s.toUserId,
      type: s.type,
      payload: s.payload,
      createdAt: s.createdAt,
    }));
  },
});

export const sendSignal = mutation({
  args: {
    callId: v.id("calls"),
    token: v.string(),
    toUserId: v.id("users"),
    type: v.union(
      v.literal("offer"),
      v.literal("answer"),
      v.literal("ice"),
      v.literal("ring"),
      v.literal("hangup"),
      v.literal("screen"),
      v.literal("camera"),
      v.literal("mic"),
    ),
    payload: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    if (me === args.toUserId) return;
    await ctx.db.insert("callSignals", {
      callId: args.callId,
      fromUserId: me,
      toUserId: args.toUserId,
      type: args.type,
      payload: args.payload,
      createdAt: Date.now(),
    });
  },
});

/**
 * Housekeeping for calls nobody is around to end. There is no scheduler in
 * this app, so it piggybacks on the presence heartbeat that every open client
 * already sends every ~20s (see users.heartbeat) — mutations can run other
 * mutations, queries cannot, and a heartbeat is the one cheap cadence we have.
 *
 *  - ringing calls unanswered for > 75s → missed. The clients' own ring
 *    timers end at 45s (callee) / 60s (caller); this is the safety net for
 *    when every screen died mid-ring, so a row can never ring forever or
 *    resurrect as a ghost ring on a later app open.
 *  - active calls where EVERY participant's presence went stale (> 10 min) →
 *    ended. Both phones were abandoned/died mid-call (the LiveKit room is
 *    empty by then), so the row should not keep "active" forever and block
 *    those users from ever starting a new call.
 */
export const cleanupStale = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    const now = Date.now();

    const staleRings = await ctx.db
      .query("calls")
      .withIndex("by_status", (q) => q.eq("status", "ringing"))
      .take(20);
    for (const call of staleRings) {
      if (now - call.startedAt > 75_000) {
        await ctx.db.patch(call._id, { status: "missed", endedAt: now });
      }
    }

    const active = await ctx.db
      .query("calls")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(10);
    for (const call of active) {
      // Fast path: a recent call can't have stale participants yet.
      if (now - call.startedAt < 10 * 60_000) continue;
      const parts = await ctx.db
        .query("callParticipants")
        .withIndex("by_call", (q) => q.eq("callId", call._id))
        .collect();
      let everyoneGone = parts.length > 0;
      for (const p of parts) {
        const u = await ctx.db.get(p.userId);
        if (!u || now - u.lastSeenAt < 10 * 60_000) {
          everyoneGone = false;
          break;
        }
      }
      if (everyoneGone) {
        await ctx.db.patch(call._id, { status: "ended", endedAt: now });
      }
    }
  },
});