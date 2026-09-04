import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { userIdFromToken } from "./auth";

/** Web Push subscription storage (plain queries/mutations — no Node APIs). */

export const saveSubscription = mutation({
  args: {
    token: v.string(),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
  },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) throw new Error("unauthorized");
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        userId: me,
        p256dh: args.p256dh,
        auth: args.auth,
        createdAt: Date.now(),
      });
      return existing._id;
    }
    return await ctx.db.insert("pushSubscriptions", {
      userId: me,
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      createdAt: Date.now(),
    });
  },
});

export const removeSubscription = mutation({
  args: { token: v.string(), endpoint: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing && existing.userId === me) await ctx.db.delete(existing._id);
  },
});

/** All push endpoints registered for one user. */
export const listSubscriptions = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

/** Delete a dead endpoint. */
export const pruneSubscription = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});
