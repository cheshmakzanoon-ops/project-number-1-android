import { mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { userIdFromToken } from "./auth";
import { rateLimit } from "./policy";

import { validPushSubscription } from "../lib/pushValidation";

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
    if (!validPushSubscription(args.endpoint, args.p256dh, args.auth)) throw new Error("invalid_push_subscription");
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing) {
      if (existing.userId !== me) throw new Error("subscription_not_owned");
      if (existing.p256dh === args.p256dh && existing.auth === args.auth) return existing._id;
      await rateLimit(ctx, me, "push-subscription", 20);
      await ctx.db.patch(existing._id, {
        userId: me,
        p256dh: args.p256dh,
        auth: args.auth,
        createdAt: Date.now(),
      });
      return existing._id;
    }
    await rateLimit(ctx, me, "push-subscription", 20);
    const devices = await ctx.db.query("pushSubscriptions").withIndex("by_user", (q) => q.eq("userId", me)).take(10);
    if (devices.length >= 10) throw new Error("too_many_push_devices");
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
export const listSubscriptions = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .take(10);
  },
});

/** Delete a dead endpoint. */
export const pruneSubscription = internalMutation({
  args: { endpoint: v.string(), p256dh: v.string(), auth: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing && existing.p256dh === args.p256dh && existing.auth === args.auth) {
      await ctx.db.delete(existing._id);
    }
  },
});

/** Claim one bounded ring attempt atomically across retries and concurrent tabs. */
export const claimIncoming = internalMutation({
  args: { token: v.string(), callId: v.id("calls") },
  handler: async (ctx, { token, callId }) => {
    const me = await userIdFromToken(ctx, token);
    if (!me) throw new Error("unauthorized");
    const call = await ctx.db.get(callId);
    if (!call || call.initiatorId !== me) throw new Error("unauthorized");
    const participant = await ctx.db.query("callParticipants").withIndex("by_call_user", q => q.eq("callId", callId).eq("userId", me)).first();
    if (!participant || participant.leftAt !== undefined) throw new Error("unauthorized");
    const now = Date.now();
    if (call.status !== "ringing" || now - call.startedAt >= 75_000) return false;
    if (call.lastPushAt !== undefined && now - call.lastPushAt < 15_000) return false;
    await ctx.db.patch(callId, { lastPushAt: now });
    return true;
  },
});
