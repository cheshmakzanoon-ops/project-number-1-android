import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { userIdFromToken } from "./auth";
import type { Id } from "./_generated/dataModel";

/** Recent messages for an open conversation, newest last, with reactions. */
export const list = query({
  args: { conversationId: v.id("conversations"), token: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];

    const canonical = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.eq(q.field("userId"), me))
      .first();
    if (!canonical) return [];

    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_created", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .take(args.limit ?? 100);

    // The peer's read cursor: a message I sent counts as "read" once the
    // other participant's lastReadAt has passed its createdAt (WhatsApp ticks).
    const members = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .collect();
    const other = members.find((m) => m.userId !== me);
    const otherReadAt = other?.lastReadAt ?? 0;

    const out: Array<{
      _id: Id<"messages">;
      senderId: Id<"users">;
      body: string;
      createdAt: number;
      editedAt: number | undefined;
      deletedAt: number | undefined;
      isMine: boolean;
      read: boolean;
      reactions: Record<string, number>;
      usersReacted: boolean;
      // Lets the client match a queued/optimistic send against the real row.
      clientMessageId: string | undefined;
    }> = [];

    const ordered = msgs.reverse();
    // Fetch reactions for every message in parallel — resolving them one by
    // one turned every chat open into ~100 serial round trips (a real, felt
    // delay on slower backends).
    const reactionsFor = await Promise.all(
      ordered.map((m) =>
        ctx.db
          .query("reactions")
          .withIndex("by_message", (q) => q.eq("messageId", m._id))
          .collect(),
      ),
    );
    ordered.forEach((m, i) => {
      const reactions = reactionsFor[i];
      const counts: Record<string, number> = {};
      let usersReacted = false;
      for (const r of reactions) {
        counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
        if (r.userId === me) usersReacted = true;
      }
      out.push({
        _id: m._id,
        senderId: m.senderId,
        body: m.body,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        deletedAt: m.deletedAt,
        isMine: m.senderId === me,
        read: m.senderId === me && !m.deletedAt && m.createdAt <= otherReadAt,
        reactions: counts,
        usersReacted,
        clientMessageId: m.clientMessageId,
      });
    });
    return out;
  },
});

export const send = mutation({
  args: {
    conversationId: v.id("conversations"),
    body: v.string(),
    token: v.string(),
    // Optional; the client sends it when retrying a message that failed on a
    // flaky connection so the server can recognize (and skip) a duplicate.
    clientMessageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) throw new Error("unauthorized");
    const text = args.body.trim();
    if (!text) throw new Error("empty");

    const membership = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.eq(q.field("userId"), me))
      .first();
    if (!membership) throw new Error("not_member");

    // Dedupe: the same logical message (same client id) can be re-sent by an
    // automatic outbox retry after the first attempt's response was lost.
    if (args.clientMessageId) {
      const dup = await ctx.db
        .query("messages")
        .withIndex("by_sender_client", (q) =>
          q.eq("senderId", me).eq("clientMessageId", args.clientMessageId),
        )
        .first();
      if (dup) return dup._id;
    }

    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      senderId: me,
      body: text.slice(0, 4000),
      createdAt: now,
      clientMessageId: args.clientMessageId,
    });
    await ctx.db.patch(args.conversationId, { lastMessageAt: now });
    // update my read cursor so own messages don't show as unread
    await ctx.db.patch(membership._id, { lastReadAt: now });
    return messageId;
  },
});

export const edit = mutation({
  args: { messageId: v.id("messages"), body: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    const msg = await ctx.db.get(args.messageId);
    if (!me || !msg || msg.senderId !== me) throw new Error("unauthorized");
    const text = args.body.trim();
    if (!text || msg.deletedAt) throw new Error("invalid");
    await ctx.db.patch(args.messageId, { body: text.slice(0, 4000), editedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { messageId: v.id("messages"), token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    const msg = await ctx.db.get(args.messageId);
    if (!me || !msg || msg.senderId !== me || msg.deletedAt) throw new Error("unauthorized");
    await ctx.db.patch(args.messageId, { deletedAt: Date.now() });
  },
});

/** Toggle a reaction for the current user. */
export const toggleReaction = mutation({
  args: { messageId: v.id("messages"), emoji: v.string(), token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) throw new Error("unauthorized");
    const msg = await ctx.db.get(args.messageId);
    if (!msg || msg.deletedAt) throw new Error("gone");

    const existing = await ctx.db
      .query("reactions")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .filter((q) => q.eq(q.field("userId"), me))
      .filter((q) => q.eq(q.field("emoji"), args.emoji))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    } else {
      // cap distinct reactions per message
      const all = await ctx.db
        .query("reactions")
        .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
        .collect();
      if (all.length < 24) {
        await ctx.db.insert("reactions", {
          messageId: args.messageId,
          userId: me,
          emoji: args.emoji,
        });
      }
    }
  },
});
