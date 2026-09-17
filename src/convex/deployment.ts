"use node";
import { createECDH } from "node:crypto";
import { action, env } from "./_generated/server";
import { v } from "convex/values";
import { API_VERSION, configuredWebOrigins, familyInviteCode, mediaEndpoint, webOrigin } from "./policy";

/** Configuration checks only. No user data, keys, invitation, URLs or network calls. */
export function configurationStatus(frontendOrigin: string) {
  const e = env as unknown as Record<string, string | undefined>;
  let privateEnrollment = false;
  let uploadSite = false;
  let livekit = false;
  let pushKeys = false;
  try { familyInviteCode(); privateEnrollment = true; } catch { /* fail closed */ }
  try {
    const site = e.CONVEX_SITE_URL ?? "";
    uploadSite = webOrigin(site) !== null && mediaEndpoint().startsWith("https://");
  } catch { /* fail closed */ }
  const origins = configuredWebOrigins();
  const allowedOrigins = origins.length > 0 && origins.every(origin => webOrigin(origin) !== null);
  const frontend = webOrigin(frontendOrigin);
  try {
    const url = new URL(e.LIVEKIT_URL ?? "");
    livekit = url.protocol === "wss:" && !url.username && !url.password && !url.search && !url.hash &&
      Boolean(e.LIVEKIT_API_KEY?.trim() && e.LIVEKIT_API_SECRET?.trim());
  } catch { /* malformed configuration is not an exception in a public report */ }
  try {
    const pub = e.VAPID_PUBLIC_KEY ?? "", priv = e.VAPID_PRIVATE_KEY ?? "";
    // web-push requires unpadded base64url, a 65-byte uncompressed P-256
    // public point and a 32-byte private scalar. Verify the pair, not just lengths.
    if (/^[A-Za-z0-9_-]{87}$/.test(pub) && /^[A-Za-z0-9_-]{43}$/.test(priv)) {
      const publicBytes = Buffer.from(pub, "base64url"), privateBytes = Buffer.from(priv, "base64url");
      if (publicBytes.length === 65 && publicBytes[0] === 4 && privateBytes.length === 32 &&
        publicBytes.toString("base64url") === pub && privateBytes.toString("base64url") === priv) {
        const pair = createECDH("prime256v1");
        pair.setPrivateKey(privateBytes);
        pushKeys = pair.getPublicKey().equals(publicBytes);
      }
    }
  } catch { /* never expose crypto exceptions or input key material */ }
  const checks = { privateEnrollment, uploadSite, allowedOrigins,
    frontendOrigin: frontend !== null && origins.includes(frontend), livekit, pushKeys };
  return { apiVersion: API_VERSION, ready: Object.values(checks).every(Boolean), checks };
}

/** Public, read-only and fixed-shape: safe for an unauthenticated release probe. */
export const readiness = action({
  args: { frontendOrigin: v.string() },
  handler: async (_ctx, { frontendOrigin }) => configurationStatus(frontendOrigin),
});
