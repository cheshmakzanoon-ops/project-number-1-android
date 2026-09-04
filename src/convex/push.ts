"use node";
import { action, env } from "./_generated/server";
import { v } from "convex/values";
import webpush from "web-push";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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
 *
 * Callees are derived server-side from the call's participant rows — never
 * taken from the client — so a caller cannot push-spam arbitrary users with
 * fake rings, and group calls ring every member automatically.
 */
export const notifyIncomingCall = action({
  args: {
    token: v.string(),
    callId: v.id("calls"),
    kind: v.union(v.literal("audio"), v.literal("video")),
  },
  handler: async (ctx, args) => {
    const me = await ctx.runQuery(api.users.me, { token: args.token });
    if (!me) throw new Error("unauthorized");
    const details = await ctx.runQuery(api.calls.details, {
      callId: args.callId,
      token: args.token,
    });
    if (!details || !details.isMine || details.call.status !== "ringing") {
      throw new Error("unauthorized");
    }
    // runQuery results are untyped here, so pin the shape we need.
    const allMembers = (details.members as Array<{ userId: Id<"users">; displayName: string }>);
    const calleeIds = allMembers.map((m) => m.userId).filter((id) => id !== me._id);
    const isGroup = calleeIds.length > 1;

    const e = env as unknown as Record<string, string | undefined>;
    const pub = e.VAPID_PUBLIC_KEY;
    const priv = e.VAPID_PRIVATE_KEY;
    if (!pub || !priv) return { sent: 0, skipped: "vapid_not_configured" };
    webpush.setVapidDetails("mailto:garma@freebuff.app", pub, priv);

    const callerName = me.displayName;
    const kindWord = args.kind === "video" ? "تصویری" : "صوتی";
    const payload = JSON.stringify({
      type: "incoming_call",
      callId: args.callId,
      callerName,
      kind: args.kind,
      // Re-send on every ring: "renotify" in the service worker replaces
      // older identical-tag notifications and rings again.
      timestamp: Date.now(),
      title: isGroup
        ? args.kind === "video"
          ? "تماس گروهی تصویری گرما"
          : "تماس گروهی صوتی گرما"
        : args.kind === "video"
          ? "تماس تصویری گرما"
          : "تماس صوتی گرما",
      body: isGroup
        ? `${callerName} با ${allMembers.filter((m) => m.userId !== me._id).length} نفر تماس ${kindWord} گرفت`
        : args.kind === "video"
          ? `${callerName} می‌خواهد با تو گفتگوی تصویری کند`
          : `${callerName} می‌خواهد با تو حرف بزند`,
      vibrate: [500, 200, 500, 200, 500, 200, 900],
    });

    let sent = 0;
    for (const calleeId of calleeIds) {
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
