"use node";
import { action, env } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";
import { AccessToken } from "livekit-server-sdk";

/**
 * Mint a short-lived LiveKit room token for the calling device.
 * Requires LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in env.
 */
export const getToken = action({
  args: { token: v.string(), callId: v.id("calls") },
  handler: async (ctx, args) => {
    const e = env as unknown as Record<string, string | undefined>;
    const url = e.LIVEKIT_URL;
    const apiKey = e.LIVEKIT_API_KEY;
    const apiSecret = e.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !apiSecret) {
      throw new Error("livekit_not_configured");
    }

    // A device must have a valid session to get media access.
    const me = await ctx.runQuery(api.users.me, { token: args.token });
    if (!me) throw new Error("unauthorized");

    // ...and must actually be ON this call. Room names are guessable
    // (`call-<id>`), so without this check any signed-in user could mint a
    // token and eavesdrop on a room they were never invited to. Only
    // participants of a still-ringing/active call may join, and only once
    // they have answered (the initiator may always join to wait for the
    // others) — a ringing callee who has not accepted yet cannot sneak into
    // the room ahead of their "پاسخ" tap.
    const details = await ctx.runQuery(api.calls.details, {
      callId: args.callId,
      token: args.token,
    });
    if (!details || !details.isMine) throw new Error("unauthorized");
    const status = details.call.status;
    if (status !== "ringing" && status !== "active") throw new Error("unauthorized");
    if (!details.meIsInitiator && !details.meAccepted) throw new Error("unauthorized");

    const room = `call-${args.callId}`;
    const identity = me._id; // user id is a stable, unique LiveKit identity
    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      ttl: "1h",
    });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomRecord: false,
    });

    return {
      url,
      room,
      identity,
      token: await at.toJwt(),
    };
  },
});