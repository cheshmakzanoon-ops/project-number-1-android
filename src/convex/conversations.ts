import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { userIdFromToken } from "./auth";
import type { Id } from "./_generated/dataModel";
import type { Doc } from "./_generated/dataModel";

type UserDoc = Doc<"users">;

/** All conversations a user belongs to, richest payload for the lobby. */
export const myConversations = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];

    const memberships = await ctx.db
      .query("conversationMembers")
      .withIndex("by_user", (q) => q.eq("userId", me))
      .order("desc")
      .collect();

    const now = Date.now();
    type Row = {
      _id: Id<"conversations">;
      kind: "dm" | "group";
      name: string | undefined;
      lastMessageAt: number;
      unread: number;
      lastMessage: string | null;
      lastMessageSender: string | null;
      lastMessageAt_: number | null;
      members: Array<{ user: UserDoc; online: boolean }>;
    };

    // Build every conversation row concurrently instead of one slow serial
    // pass — the lobby renders as soon as the slowest conversation resolves.
    const rows = await Promise.all(
      memberships.map(async (m): Promise<Row | null> => {
        const conv = await ctx.db.get(m.conversationId);
        if (!conv) return null;

        // members + newest message + unread window in parallel
        const [memberRows, lastMsg, sinceCursor] = await Promise.all([
          ctx.db
            .query("conversationMembers")
            .withIndex("by_conversation", (q) => q.eq("conversationId", conv._id))
            .collect(),
          ctx.db
            .query("messages")
            .withIndex("by_conversation_created", (q) =>
              q.eq("conversationId", conv._id),
            )
            .order("desc")
            .first(),
          ctx.db
            .query("messages")
            .withIndex("by_conversation_created", (q) =>
              q.eq("conversationId", conv._id).gt("createdAt", m.lastReadAt),
            )
            .take(101),
        ]);

        const memberUsers = await Promise.all(
          memberRows.map(async (r) => {
            const u = await ctx.db.get(r.userId);
            return u ? { user: u, online: now - u.lastSeenAt < 60_000 } : null;
          }),
        );
        const members = memberUsers.filter(Boolean) as Array<{ user: UserDoc; online: boolean }>;

        let lastMessage: string | null = null;
        let lastMessageSender: string | null = null;
        let lastMessageAt: number | null = null;
        if (lastMsg) {
          lastMessage = lastMsg.deletedAt ? "پیام حذف شد" : lastMsg.body;
          const sender = await ctx.db.get(lastMsg.senderId);
          lastMessageSender = sender?.displayName ?? null;
          lastMessageAt = lastMsg.createdAt;
        }

        // unread: every message from the other side newer than my read cursor
        // (capped at 100 for the badge).
        let unread = 0;
        for (const msg of sinceCursor) {
          if (!msg.deletedAt && msg.senderId !== me) unread += 1;
        }

        // dm display name
        let name = conv.name;
        if (conv.kind === "dm") {
          const other = members.find((mm) => mm.user._id !== me);
          name = other?.user.displayName ?? "گفتگو";
        }

        return {
          _id: conv._id,
          kind: conv.kind,
          name,
          lastMessageAt: conv.lastMessageAt,
          unread,
          lastMessage,
          lastMessageSender,
          lastMessageAt_: lastMessageAt,
          members,
        };
      }),
    );

    const out = rows.filter((r): r is Row => r !== null);
    out.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return out;
  },
});

export const conversation = query({
  args: { conversationId: v.id("conversations"), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return null;
    return {
      id: args.conversationId,
      canAccess: !!(await ctx.db
        .query("conversationMembers")
        .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
        .filter((q) => q.eq(q.field("userId"), me))
        .first()),
    };
  },
});

/** Start (or return existing) a 1:1 DM with another user. */
export const startDM = mutation({
  args: { otherId: v.id("users"), token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) throw new Error("unauthorized");
    if (me === args.otherId) throw new Error("self");

    const both = [me, args.otherId].sort();
    const dmCandidates = await ctx.db
      .query("conversationMembers")
      .withIndex("by_user", (q) => q.eq("userId", both[0]))
      .collect();
    for (const cand of dmCandidates) {
      const conv = await ctx.db.get(cand.conversationId);
      if (!conv || conv.kind !== "dm") continue;
      const otherMembership = await ctx.db
        .query("conversationMembers")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conv._id))
        .filter((q) => q.eq(q.field("userId"), both[1]))
        .first();
      if (otherMembership) return conv._id; // DM already exists
    }

    const now = Date.now();
    const convId = await ctx.db.insert("conversations", {
      kind: "dm",
      createdBy: me,
      createdAt: now,
      lastMessageAt: now,
    });
    for (const uid of both) {
      await ctx.db.insert("conversationMembers", {
        conversationId: convId,
        userId: uid,
        joinedAt: now,
        lastReadAt: now,
      });
    }
    return convId;
  },
});

export const markRead = mutation({
  args: { conversationId: v.id("conversations"), token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    const membership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.eq(q.field("userId"), me))
      .first();
    if (membership) {
      await ctx.db.patch(membership._id, { lastReadAt: Date.now() });
    }
  },
});