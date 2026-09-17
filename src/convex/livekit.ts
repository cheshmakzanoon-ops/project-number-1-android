"use node";
import { action, env } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";
import { AccessToken } from "livekit-server-sdk";
import { TrackSource } from "@livekit/protocol";
import { createHash, randomBytes } from "node:crypto";
import {
  HANDOFF_CODE_BYTES,
  HANDOFF_TTL_MS,
  SCREEN_PARTICIPANT_SUFFIX,
  SCREEN_TOKEN_TTL,
  auxScreenIdentity,
  isHandoffCodeWellFormed,
} from "../lib/screenShareProtocol";

/** Resolve the LiveKit deployment config, or throw the terminal error. */
function livekitEnv() {
  const e = env as unknown as Record<string, string | undefined>;
  const url = e.LIVEKIT_URL;
  const apiKey = e.LIVEKIT_API_KEY;
  const apiSecret = e.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) throw new Error("livekit_not_configured");
  const parsed = new URL(url);
  if (parsed.protocol !== "wss:" || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error("livekit_not_configured");
  }
  return { url, apiKey, apiSecret };
}

/** sha256 hex of a handoff code — the only form ever stored or compared. */
function handoffHash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/**
 * Mint a short-lived LiveKit room token for the calling device.
 * Requires LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in env.
 */
export const getToken = action({
  args: { token: v.string(), callId: v.id("calls") },
  handler: async (ctx, args) => {
    const { url, apiKey, apiSecret } = livekitEnv();

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
    if (status === "ringing" && Date.now() - details.call.startedAt >= 75_000) throw new Error("call_not_live");
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

/**
 * Create a one-time handoff code so the Android companion can publish the
 * user's screen into THIS call.
 *
 * The browser is already an authenticated, live participant of the call, and
 * that is exactly what this action re-verifies before minting anything: the
 * code is useless to anyone else, and it authorizes only the auxiliary
 * screen-share identity — never the user's own participant identity, so the
 * companion can never evict/replace the browser's connection.
 *
 * No credential travels through the deep link: only the opaque code does.
 */
export const requestScreenShareHandoff = action({
  args: { token: v.string(), callId: v.id("calls") },
  handler: async (ctx, args) => {
    livekitEnv(); // fail early with the terminal "not configured" error
    const me = await ctx.runQuery(api.users.me, { token: args.token });
    if (!me) throw new Error("unauthorized");
    const details = await ctx.runQuery(api.calls.details, {
      callId: args.callId,
      token: args.token,
    });
    if (!details || !details.isMine) throw new Error("unauthorized");
    const status = details.call.status;
    if (status !== "ringing" && status !== "active") throw new Error("call_not_live");
    // Same publish rule as getToken: the initiator may publish while waiting,
    // a ringee must have actually answered.
    if (!details.meIsInitiator && !details.meAccepted) throw new Error("unauthorized");

    const code = randomBytes(HANDOFF_CODE_BYTES).toString("base64url");
    await ctx.runMutation(internal.screenShare.insertHandoff, {
      codeHash: handoffHash(code),
      userId: me._id,
      callId: args.callId,
      ttlMs: HANDOFF_TTL_MS,
    });
    return { code, expiresInMs: HANDOFF_TTL_MS };
  },
});

/**
 * Exchange a one-time code (sent by the Android companion over the deep link)
 * for the restricted LiveKit grant the companion needs.
 *
 * Fails closed: a malformed, unknown, expired, replayed, foreign or
 * call-already-over code mints nothing. The identity and its metadata mapping
 * back to the real user are derived SERVER-SIDE, never from client input.
 */
export const redeemScreenShareHandoff = action({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const { url, apiKey, apiSecret } = livekitEnv();
    if (!isHandoffCodeWellFormed(args.code)) throw new Error("handoff_invalid");
    const consumed = await ctx.runMutation(internal.screenShare.consumeHandoff, {
      codeHash: handoffHash(args.code),
    });
    if (!consumed) throw new Error("handoff_invalid");

    const room = `call-${consumed.callId}`;
    const identity = auxScreenIdentity(consumed.userId);
    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name: consumed.displayName,
      ttl: SCREEN_TOKEN_TTL,
      // Server-controlled mapping from the auxiliary participant to the real
      // user. The identity itself already carries it (and identities are
      // signed by us), so a client cannot impersonate another user.
      metadata: JSON.stringify({
        role: "screen-share",
        forUserId: consumed.userId,
        callId: consumed.callId,
        sessionId: consumed.sessionId,
      }),
    });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      // Screen only. The companion is a capture pipe, not a second phone: it
      // cannot send camera/mic (PII the user never consented to share) and it
      // cannot subscribe to anyone's media.
      canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
      canSubscribe: false,
      canPublishData: false,
      roomRecord: false,
    });

    return {
      url,
      room,
      identity,
      token: await at.toJwt(),
      sessionId: consumed.sessionId,
      displayName: consumed.displayName,
      /** Suffix the browser strips to attribute this participant to its user. */
      identitySuffix: SCREEN_PARTICIPANT_SUFFIX,
    };
  },
});