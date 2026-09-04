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

        // dm display name / group title (members except me, so every person
        // in the group sees the others' names — no custom names in this app)
        let name = conv.name;
        if (conv.kind === "dm") {
          const other = members.find((mm) => mm.user._id !== me);
          name = other?.user.displayName ?? "گفتگو";
        } else if (!name) {
          const others = members.filter((mm) => mm.user._id !== me);
          name =
            others.length > 0
              ? others.map((mm) => mm.user.displayName).join("， ")
              : "گروه";
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
    const conv = await ctx.db.get(args.conversationId);
    if (!conv) return null;
    const memberRows = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .collect();
    const mine = memberRows.find((r) => r.userId === me);
    if (!mine) {
      return { id: args.conversationId, canAccess: false };
    }
    const members: Array<{
      userId: Id<"users">;
      displayName: string;
      themeColor: string;
      online: boolean;
    }> = [];
    const now = Date.now();
    for (const r of memberRows) {
      const u = await ctx.db.get(r.userId);
      if (u) {
        members.push({
          userId: u._id,
          displayName: u.displayName,
          themeColor: u.themeColor,
          online: now - u.lastSeenAt < 60_000,
        });
      }
    }
    let name = conv.name;
    if (conv.kind === "dm") {
      name = members.find((m) => m.userId !== me)?.displayName ?? "گفتگو";
    } else if (!name) {
      const others = members.filter((m) => m.userId !== me);
      name = others.length > 0 ? others.map((m) => m.displayName).join("， ") : "گروه";
    }
    return {
      id: args.conversationId,
      canAccess: true,
      kind: conv.kind,
      name,
      createdAt: conv.createdAt,
      members,
    };
  },
});

/**
 * Create a group conversation with the given members (or return an existing
 * group with the exact same membership, so taps never pile up duplicate
 * groups). Groups power family-wide chats and 3+-person calls.
 */
export const startGroup = mutation({
  args: { memberIds: v.array(v.id("users")), token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) throw new Error("unauthorized");
    const ids = [...new Set(args.memberIds)];
    if (ids.length < 2) throw new Error("need_two_others");
    if (ids.length > 7) throw new Error("too_many");
    if (ids.includes(me)) throw new Error("self");
    const memberSet = new Set([me, ...ids]);

    // All invitees must actually exist (never phantom members).
    for (const id of ids) {
      if (!(await ctx.db.get(id))) throw new Error("no_such_user");
    }

    // Dedupe: if a group with exactly this membership already exists, reuse it.
    const mine = await ctx.db
      .query("conversationMembers")
      .withIndex("by_user", (q) => q.eq("userId", me))
      .collect();
    for (const m of mine) {
      const conv = await ctx.db.get(m.conversationId);
      if (!conv || conv.kind !== "group" || conv.name) continue;
      const rows = await ctx.db
        .query("conversationMembers")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conv._id))
        .collect();
      if (rows.length !== memberSet.size) continue;
      if (rows.every((r) => memberSet.has(r.userId))) return conv._id;
    }

    const now = Date.now();
    const convId = await ctx.db.insert("conversations", {
      kind: "group",
      createdBy: me,
      createdAt: now,
      lastMessageAt: now,
    });
    for (const uid of memberSet) {
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