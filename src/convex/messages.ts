import { mutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { userIdFromToken } from "./auth";
import type { Doc, Id } from "./_generated/dataModel";

export type MessageKind = "text" | "image" | "voice";

/** The client-facing shape every message list endpoint returns. */
type MessageRow = {
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
  clientMessageId: string | undefined;
  kind: MessageKind;
  url: string | null;
  mimeType: string | undefined;
  durationMs: number | undefined;
  replyToId: Id<"messages"> | undefined;
  // Sender + excerpt of the quoted message, resolved server-side so the chat
  // can draw the quote chip without an extra round trip per message.
  reply: {
    senderName: string;
    senderColor: string;
    body: string;
    deleted: boolean;
    kind: MessageKind;
  } | null;
};

type MsgDoc = Doc<"messages">;

/**
 * Shared view builder: turns raw message docs (already newest-last or
 * anchor-window) into rows the chat renders — adding read state, reactions
 * and resolved media URLs + quote excerpts in parallel instead of one serial
 * round trip per message.
 */
async function enrich(ctx: Pick<QueryCtx, "db" | "storage">, msgs: MsgDoc[], me: Id<"users">): Promise<MessageRow[]> {
  if (msgs.length === 0) return [];

  const ordered = msgs.slice().reverse();

  // Read cursor of "the other side" for WhatsApp ticks (only meaningful in a
  // true 1:1 — group chats never claim a double tick).
  let isDM = false;
  let otherReadAt = 0;
  if (ordered.length > 0) {
    const members = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", ordered[0].conversationId))
      .collect();
    isDM = members.length === 2;
    const other = members.find((m) => m.userId !== me);
    otherReadAt = other?.lastReadAt ?? 0;
  }

  const [reactionsFor, urlMap, replyExcerpts] = await Promise.all([
    Promise.all(
      ordered.map((m) =>
        ctx.db.query("reactions").withIndex("by_message", (q) => q.eq("messageId", m._id)).collect(),
      ),
    ),
    (async () => {
      const ids = [...new Set(ordered.filter((m) => m.storageId).map((m) => m.storageId as Id<"_storage">))];
      const map = new Map<string, string | null>();
      await Promise.all(
        ids.map(async (sid) => {
          map.set(sid, (await ctx.storage.getUrl(sid)) ?? null);
        }),
      );
      return map;
    })(),
    (async () => {
      const replyIds = [...new Set(ordered.filter((m) => m.replyToId).map((m) => m.replyToId as Id<"messages">))];
      const map = new Map<string, { body: string; deleted: boolean; kind: MessageKind; senderName: string; senderColor: string }>();
      await Promise.all(
        replyIds.map(async (rid) => {
          const target = await ctx.db.get(rid);
          if (!target || target.conversationId !== ordered[0].conversationId) return;
          const sender = await ctx.db.get(target.senderId);
          map.set(rid, {
            body: target.body,
            deleted: !!target.deletedAt,
            kind: target.kind ?? "text",
            senderName: sender?.displayName ?? "…",
            senderColor: sender?.themeColor ?? "#8a6340",
          });
        }),
      );
      return map;
    })(),
  ]);

  return ordered.map((m, i) => {
    const reactions = reactionsFor[i];
    const counts: Record<string, number> = {};
    let usersReacted = false;
    for (const r of reactions) {
      counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
      if (r.userId === me) usersReacted = true;
    }
    const kind: MessageKind = m.kind ?? "text";
    const replyToId = m.replyToId;
    const excerpt = replyToId ? replyExcerpts.get(replyToId) : undefined;
    return {
      _id: m._id,
      senderId: m.senderId,
      body: m.body,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      deletedAt: m.deletedAt,
      isMine: m.senderId === me,
      read: isDM && m.senderId === me && !m.deletedAt && m.createdAt <= otherReadAt,
      reactions: counts,
      usersReacted,
      clientMessageId: m.clientMessageId,
      kind,
      url: m.storageId ? (urlMap.get(m.storageId) ?? null) : null,
      mimeType: m.mimeType,
      durationMs: m.durationMs,
      replyToId,
      reply: excerpt
        ? {
            senderName: excerpt.senderName,
            senderColor: excerpt.senderColor,
            body: excerpt.body,
            deleted: excerpt.deleted,
            kind: excerpt.kind,
          }
        : null,
    };
  });
}

async function membershipOf(ctx: Pick<QueryCtx, "db">, conversationId: Id<"conversations">, me: Id<"users">) {
  return await ctx.db
    .query("conversationMembers")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .filter((q) => q.eq(q.field("userId"), me))
    .first();
}

/** Recent messages for an open conversation, newest last, with reactions. */
export const list = query({
  args: { conversationId: v.id("conversations"), token: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];
    if (!(await membershipOf(ctx, args.conversationId, me))) return [];

    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_created", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(args.limit ?? 100);
    return await enrich(ctx, msgs, me);
  },
});

/**
 * A window of messages around one anchor message (for jump-to-message: the
 * anchor itself plus the ~35 before and after it), oldest first. Used when a
 * search hit or a tapped reply lives outside the loaded latest window.
 */
export const listAround = query({
  args: { conversationId: v.id("conversations"), anchorId: v.id("messages"), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];
    if (!(await membershipOf(ctx, args.conversationId, me))) return [];
    const anchor = await ctx.db.get(args.anchorId);
    if (!anchor || anchor.conversationId !== args.conversationId) return [];

    const [before, after] = await Promise.all([
      ctx.db
        .query("messages")
        .withIndex("by_conversation_created", (q) =>
          q.eq("conversationId", args.conversationId).lt("createdAt", anchor.createdAt),
        )
        .order("desc")
        .take(35),
      ctx.db
        .query("messages")
        .withIndex("by_conversation_created", (q) =>
          q.eq("conversationId", args.conversationId).gt("createdAt", anchor.createdAt),
        )
        .order("asc")
        .take(35),
    ]);
    const windowMsgs = [...before.slice().reverse(), anchor, ...after];
    return await enrich(ctx, windowMsgs, me);
  },
});

/**
 * Search the newest messages of a conversation (used by the in-chat search —
 * a bounded scan, since a family chat lives in the hundreds of messages).
 */
export const search = query({
  args: { conversationId: v.id("conversations"), q: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];
    if (!(await membershipOf(ctx, args.conversationId, me))) return [];
    const needle = args.q.trim().toLowerCase();
    if (!needle) return [];

    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_created", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(300);

    const hits: Array<{ _id: Id<"messages">; body: string; createdAt: number; kind: MessageKind; senderName: string; senderColor: string }> = [];
    for (const m of recent) {
      if (m.deletedAt) continue;
      if (!m.body.toLowerCase().includes(needle)) continue;
      const kind: MessageKind = m.kind ?? "text";
      if (kind !== "text" && !m.body) continue; // no caption, nothing searchable
      const sender = await ctx.db.get(m.senderId);
      hits.push({
        _id: m._id,
        body: m.body.slice(0, 120),
        createdAt: m.createdAt,
        kind,
        senderName: sender?.displayName ?? "…",
        senderColor: sender?.themeColor ?? "#8a6340",
      });
      if (hits.length >= 40) break;
    }
    return hits;
  },
});

export const send = mutation({
  args: {
    conversationId: v.id("conversations"),
    token: v.string(),
    body: v.optional(v.string()),
    clientMessageId: v.optional(v.string()),
    kind: v.optional(v.union(v.literal("text"), v.literal("image"), v.literal("voice"))),
    storageId: v.optional(v.id("_storage")),
    mimeType: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    replyToId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) throw new Error("unauthorized");
    const kind: MessageKind = args.kind ?? "text";

    const membership = await membershipOf(ctx, args.conversationId, me);
    if (!membership) throw new Error("not_member");

    const text = (args.body ?? "").trim();

    // Reply targets must exist and live in THIS conversation (a forged id from
    // another chat must never surface someone else's message as a quote).
    let replyToId: Id<"messages"> | undefined;
    if (args.replyToId) {
      const target = await ctx.db.get(args.replyToId);
      if (!target || target.conversationId !== args.conversationId) throw new Error("bad_reply");
      replyToId = args.replyToId;
    }

    // kind-specific validation
    if (kind === "text") {
      if (!text) throw new Error("empty");
    } else if (kind === "image") {
      if (!args.storageId) throw new Error("no_file");
    } else if (kind === "voice") {
      if (!args.storageId) throw new Error("no_file");
    }

    // Dedupe: the same logical message (same client id) can be re-sent by an
    // automatic outbox retry after the first attempt's response was lost.
    if (args.clientMessageId) {
      const dup = await ctx.db
        .query("messages")
        .withIndex("by_sender_client", (q) => q.eq("senderId", me).eq("clientMessageId", args.clientMessageId))
        .first();
      if (dup) return dup._id;
    }

    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      senderId: me,
      body: kind === "image" ? text.slice(0, 1000) : text.slice(0, 4000),
      createdAt: now,
      clientMessageId: args.clientMessageId,
      kind,
      storageId: args.storageId,
      mimeType: args.mimeType,
      durationMs: args.durationMs ? Math.min(Math.round(args.durationMs), 5 * 60_000) : undefined,
      replyToId,
    });
    await ctx.db.patch(args.conversationId, { lastMessageAt: now });
    // update my read cursor so own messages don't show as unread
    await ctx.db.patch(membership._id, { lastReadAt: now });
    return messageId;
  },
});

/** Client-side upload entry point: mints a signed Convex storage URL. */
export const uploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) throw new Error("unauthorized");
    return await ctx.storage.generateUploadUrl();
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
