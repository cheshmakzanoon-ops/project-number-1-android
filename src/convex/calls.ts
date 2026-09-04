import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { userIdFromToken } from "./auth";
import type { Id } from "./_generated/dataModel";

type ParticipantRowDoc = {
  _id: Id<"callParticipants">;
  callId: Id<"calls">;
  userId: Id<"users">;
  joinedAt: number;
  acceptedAt?: number;
  leftAt?: number;
};

type UserDoc = {
  _id: Id<"users">;
  username: string;
  displayName: string;
  themeColor: string;
  createdAt: number;
  lastSeenAt: number;
};

/** A compact public view of one participant for call UIs. */
function peerView(p: ParticipantRowDoc, u: UserDoc | null) {
  return {
    userId: p.userId,
    displayName: u?.displayName ?? "…",
    themeColor: u?.themeColor ?? "#8a6340",
    joined: p.acceptedAt != null,
  };
}

/** Everyone still on/invited to a call (rows are never deleted). */
async function participantsOf(
  ctx: { db: QueryCtx["db"] },
  callId: Id<"calls">,
): Promise<ParticipantRowDoc[]> {
  return await ctx.db
    .query("callParticipants")
    .withIndex("by_call", (q) => q.eq("callId", callId))
    .collect();
}

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
    // \"myCalls\" query sees the ringing call and can answer it (LiveKit
    // provides the actual media path). acceptedAt stays unset until the
    // member actually answers.
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
    const participants = await participantsOf(ctx, args.callId);
    // Per-member mute state (from their conversationMembership row) so call
    // push can skip people who muted this conversation.
    const memberRows = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", call.conversationId))
      .collect();
    const mutedByUserId = new Map<string, boolean>();
    for (const r of memberRows) mutedByUserId.set(r.userId, r.mutedAt != null);
    const members: Array<{
      userId: Id<"users">;
      displayName: string;
      themeColor: string;
      online: boolean;
      joined: boolean;
      muted: boolean;
    }> = [];
    for (const p of participants) {
      if (p.leftAt) continue;
      const u = await ctx.db.get(p.userId);
      if (!u) continue;
      members.push({
        userId: u._id,
        displayName: u.displayName,
        themeColor: u.themeColor,
        online: Date.now() - u.lastSeenAt < 60_000,
        joined: p.acceptedAt != null,
        muted: mutedByUserId.get(u._id) ?? false,
      });
    }
    const mine = participants.find((p) => p.userId === me);
    const isMine = !!mine && !mine.leftAt;
    return {
      call,
      members,
      isMine,
      meIsInitiator: call.initiatorId === me,
      meAccepted: mine?.acceptedAt != null || (call.initiatorId === me && call.status === "active"),
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

    type Peer = {
      userId: Id<"users">;
      displayName: string;
      themeColor: string;
      joined: boolean;
    };
    type Caller = { userId: Id<"users">; displayName: string; themeColor: string };
    const out: Array<{
      callId: Id<"calls">;
      conversationId: Id<"conversations">;
      kind: "audio" | "video";
      status: "ringing" | "active" | "ended" | "declined" | "missed";
      initiatorId: Id<"users">;
      startedAt: number;
      initiatedByMe: boolean;
      acceptedByMe: boolean;
      caller: Caller | null;
      peers: Peer[];
    }> = [];

    for (const p of parts) {
      if (p.leftAt) continue;
      const call = await ctx.db.get(p.callId);
      if (!call) continue;
      if (call.status !== "ringing" && call.status !== "active") continue;
      // A ring nobody answered ages out server-side ~75s after it started
      // (see cleanupStale below). Don't surface those ghosts here — the
      // client's ring timers end at 45s/60s, so without this filter a screen
      // reopened later could briefly re-present a ring that is already over.
      if (call.status === "ringing" && now - call.startedAt > 75_000) continue;

      const myRow = p;
      const acceptedByMe = myRow.acceptedAt != null;
      // Pull the real per-call rows for everyone else.
      const allRows = await participantsOf(ctx, call._id);
      const initiatorUser = await ctx.db.get(call.initiatorId);

      const peers: Peer[] = [];
      for (const r of allRows) {
        if (r.userId === me || r.leftAt) continue;
        const u = await ctx.db.get(r.userId);
        if (u) peers.push(peerView(r, u));
      }

      const caller: Caller | null = initiatorUser
        ? {
            userId: initiatorUser._id,
            displayName: initiatorUser.displayName,
            themeColor: initiatorUser.themeColor,
          }
        : null;

      out.push({
        callId: call._id,
        conversationId: call.conversationId,
        kind: call.kind,
        status: call.status,
        initiatorId: call.initiatorId,
        startedAt: call.startedAt,
        initiatedByMe: call.initiatorId === me,
        acceptedByMe: acceptedByMe || (call.initiatorId === me && call.status === "active"),
        caller,
        peers,
      });
    }
    // Newest first: the client reconciles from index 0, and a stale row from
    // a crashed call must never shadow a fresh ring.
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  },
});

/** Send a hangup signal to every still-present member except `exceptMe`. */
async function notifyHangup(
  ctx: { db: MutationCtx["db"] },
  callId: Id<"calls">,
  exceptMe: Id<"users">,
) {
  const rows = await participantsOf(ctx, callId);
  const now = Date.now();
  for (const r of rows) {
    if (r.userId === exceptMe || r.leftAt) continue;
    await ctx.db.insert("callSignals", {
      callId,
      fromUserId: exceptMe,
      toUserId: r.userId,
      type: "hangup",
      createdAt: now,
    });
  }
}

/** Mark everyone still present as left (end of the whole call). */
async function retireCall(
  ctx: { db: MutationCtx["db"] },
  callId: Id<"calls">,
  status: "ended" | "declined" | "missed",
) {
  const now = Date.now();
  const rows = await participantsOf(ctx, callId);
  for (const r of rows) {
    if (!r.leftAt) await ctx.db.patch(r._id, { leftAt: now });
  }
  await ctx.db.patch(callId, { status, endedAt: now });
}

/** A member answers: they join the media room (and open it for everyone). */
export const answer = mutation({
  args: { callId: v.id("calls"), token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    const call = await ctx.db.get(args.callId);
    if (!call) return;
    if (call.status !== "ringing" && call.status !== "active") return;
    const myRow = await ctx.db
      .query("callParticipants")
      .withIndex("by_call_user", (q) => q.eq("callId", args.callId).eq("userId", me))
      .first();
    if (!myRow || myRow.leftAt || myRow.acceptedAt) return;
    const now = Date.now();
    await ctx.db.patch(myRow._id, { acceptedAt: now });
    if (call.status === "ringing") {
      // First answer opens the call for everyone; the initiator is already in
      // the media room, so count them as joined too.
      const initRow = await ctx.db
        .query("callParticipants")
        .withIndex("by_call_user", (q) =>
          q.eq("callId", args.callId).eq("userId", call.initiatorId),
        )
        .first();
      if (initRow && !initRow.acceptedAt) {
        await ctx.db.patch(initRow._id, { acceptedAt: now });
      }
      await ctx.db.patch(args.callId, { status: "active" });
    }
  },
});

/**
 * End, decline, miss, or LEAVE a call.
 *
 * A call is a little conference room now: every member of the conversation
 * gets rung, and each may answer independently (group calls). So ending is
 * per-participant whenever possible, and only retires the whole call when
 * nobody is left in it:
 *  - the CALLER cancelling while nobody has answered → whole call over.
 *  - the last ringing callee declining an unanswered call → whole call over.
 *  - a participant leaving an ACTIVE call that still has someone joined and
 *    someone still able to join → only they leave.
 *  - a participant leaving an ACTIVE call that would be left empty (or down
 *    to one joined person with nobody still able to join) → whole call over.
 * 1:1 calls behave exactly like before (either side leaving ends it).
 */
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
    const rows = await participantsOf(ctx, args.callId);
    const myRow = rows.find((r) => r.userId === me);
    if (!myRow || myRow.leftAt) return;
    const now = Date.now();

    const ringing = call.status === "ringing";

    // Caller cancels / ring times out while nobody answered: whole call over
    // with the requested status (keeps "missed"/"declined" honest).
    if (ringing && call.initiatorId === me) {
      await retireCall(ctx, args.callId, wanted);
      await notifyHangup(ctx, args.callId, me);
      return;
    }

    // Everyone else: leave the call (decline / hang up / ring timeout).
    await ctx.db.patch(myRow._id, { leftAt: now });

    if (ringing) {
      // A still-unanswered call: if only the caller remains, it is over for
      // everyone; otherwise the ring simply continues for the rest.
      const stillHere = rows.filter((r) => r.userId !== me && !r.leftAt);
      if (stillHere.length <= 1) {
        await retireCall(ctx, args.callId, wanted);
        await notifyHangup(ctx, args.callId, me);
      }
      return;
    }

    // Active call. Let the media room decide: it dies when nobody is joined
    // anymore, or when it would be down to a single joined person with no one
    // left who can still answer.
    const joinedOthers = rows.filter(
      (r) => r.userId !== me && !r.leftAt && r.acceptedAt,
    );
    const ringingOthers = rows.filter(
      (r) => r.userId !== me && !r.leftAt && !r.acceptedAt,
    );
    if (joinedOthers.length === 0 || (joinedOthers.length === 1 && ringingOthers.length === 0)) {
      await retireCall(ctx, args.callId, "ended");
      await notifyHangup(ctx, args.callId, me);
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
 * already sends every ~20s (see users.heartbeat).
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
        await retireCall(ctx, call._id, "missed");
      }
    }

    const active = await ctx.db
      .query("calls")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(10);
    for (const call of active) {
      // Fast path: a recent call can't have stale participants yet.
      if (now - call.startedAt < 10 * 60_000) continue;
      const rows = await participantsOf(ctx, call._id);
      const present = rows.filter((r) => !r.leftAt);
      let everyoneGone = present.length > 0;
      for (const r of present) {
        const u = await ctx.db.get(r.userId);
        if (!u || now - u.lastSeenAt < 10 * 60_000) {
          everyoneGone = false;
          break;
        }
      }
      if (everyoneGone) {
        await retireCall(ctx, call._id, "ended");
      }
    }
  },
});
