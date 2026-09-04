import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { userIdFromToken } from "./auth";

// How recent a typing row must be to count as "still typing".
const TYPING_WINDOW = 6_000;
// Rows older than this are garbage collected whenever someone types/stops.
const STALE_AFTER = 12_000;

export const startTyping = mutation({
  args: { conversationId: v.id("conversations"), token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    // Don't let a non-member plant typing rows in a conversation they can't
    // see — it would surface as a phantom "در حال نوشتن…" on members' screens.
    const member = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.eq(q.field("userId"), me))
      .first();
    if (!member) return;
    const now = Date.now();
    const existing = await ctx.db
      .query("typing")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { updatedAt: now });
    } else {
      await ctx.db.insert("typing", {
        conversationId: args.conversationId,
        userId: me,
        updatedAt: now,
      });
    }
  },
});

export const stopTyping = mutation({
  args: { conversationId: v.id("conversations"), token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    const member = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.eq(q.field("userId"), me))
      .first();
    if (!member) return;
    const existing = await ctx.db
      .query("typing")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversationId", args.conversationId).eq("userId", me),
      )
      .first();
    if (existing) await ctx.db.delete(existing._id);
    // Tidy any abandoned rows so the indicator never gets stuck.
    const cutoff = Date.now() - STALE_AFTER;
    const stale = await ctx.db
      .query("typing")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.lt(q.field("updatedAt"), cutoff))
      .collect();
    for (const s of stale) await ctx.db.delete(s._id);
  },
});

/** Other users currently typing in this conversation (just their ids). */
export const whoIsTyping = query({
  args: { conversationId: v.id("conversations"), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];
    // Typing presence is private to the conversation's members.
    const member = await ctx.db
      .query("conversationMembers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.eq(q.field("userId"), me))
      .first();
    if (!member) return [];
    const cutoff = Date.now() - TYPING_WINDOW;
    const rows = await ctx.db
      .query("typing")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .filter((q) => q.gt(q.field("updatedAt"), cutoff))
      .collect();
    return rows.filter((r) => r.userId !== me).map((r) => r.userId);
  },
});
