"use node";
import { action, env } from "./_generated/server";
import { v } from "convex/values";
import webpush from "web-push";
import { api } from "./_generated/api";

/**
 * Web Push for incoming calls (Node runtime for the `web-push` library).
 *
 * Requires VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars (a matching pair).
 * While the app is closed Android/Chrome delivers the call as a system
 * notification and plays the phone's OWN default notification sound — a web
 * app cannot override that sound, which is exactly the desired behavior
 * ("whatever the default ringtone of the phone is").
 */

/** The VAPID public key for the browser's push subscription call. */
export const vapidPublicKey = action({
  args: {},
  handler: async () => {
    const e = env as unknown as Record<string, string | undefined>;
    return e.VAPID_PUBLIC_KEY ?? null;
  },
});

/**
 * Fire the "incoming call" push to every subscribed device of every callee.
 * Called by the client right after `calls.start` succeeds. Stale endpoints
 * (404/410) are pruned.
 */
export const notifyIncomingCall = action({
  args: {
    token: v.string(),
    callId: v.id("calls"),
    calleeIds: v.array(v.id("users")),
    kind: v.union(v.literal("audio"), v.literal("video")),
  },
  handler: async (ctx, args) => {
    const me = await ctx.runQuery(api.users.me, { token: args.token });
    if (!me) throw new Error("unauthorized");

    const e = env as unknown as Record<string, string | undefined>;
    const pub = e.VAPID_PUBLIC_KEY;
    const priv = e.VAPID_PRIVATE_KEY;
    if (!pub || !priv) return { sent: 0, skipped: "vapid_not_configured" };
    webpush.setVapidDetails("mailto:garma@freebuff.app", pub, priv);

    const callerName = me.displayName;
    const payload = JSON.stringify({
      type: "incoming_call",
      callId: args.callId,
      callerName,
      kind: args.kind,
      title: args.kind === "video" ? "تماس تصویری گرما" : "تماس صوتی گرما",
      body:
        args.kind === "video"
          ? `${callerName} می‌خواهد با تو گفتگوی تصویری کند`
          : `${callerName} می‌خواهد با تو حرف بزند`,
      vibrate: [500, 200, 500, 200, 500],
    });

    let sent = 0;
    for (const calleeId of args.calleeIds) {
      const subs = await ctx.runQuery(api.pushSubs.listSubscriptions, { userId: calleeId });
      for (const s of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            // High urgency = the OS may wake the device, play its default
            // notification sound, and vibrate even when the screen is off.
            { urgency: "high", TTL: 45 },
          );
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await ctx.runMutation(api.pushSubs.pruneSubscription, { endpoint: s.endpoint });
          }
        }
      }
    }
    return { sent };
  },
});
