import { env } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export const MAX_FAMILY_USERS = 100;
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const API_VERSION = "2026-09-17.2";

/** Configuration has no permissive production default. Existing sessions survive. */
export function familyInviteCode(): string {
  const expected = (env as unknown as Record<string, string | undefined>).GARMA_FAMILY_INVITE_CODE;
  if (!expected || !/^[A-Za-z0-9_-]{32,128}$/.test(expected)) throw new Error("registration_not_configured");
  return expected;
}

export async function requireFamilyInvite(invite: string | undefined): Promise<void> {
  const expected = familyInviteCode();
  if (!invite || !/^[A-Za-z0-9_-]{32,128}$/.test(invite)) throw new Error("invite_required");
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(expected), digest(invite)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  if (difference !== 0) throw new Error("invite_invalid");
}

/** Atomic fixed-window budgets. Call AFTER authorization and retry deduplication. */
export async function rateLimit(ctx: MutationCtx, userId: Id<"users">, scope: string, limit: number, windowMs = 60_000) {
  const now = Date.now();
  const row = await ctx.db.query("rateLimits").withIndex("by_user_scope", q => q.eq("userId", userId).eq("scope", scope)).unique();
  if (!row || row.resetAt <= now) {
    if (row) await ctx.db.patch(row._id, { count: 1, resetAt: now + windowMs });
    else await ctx.db.insert("rateLimits", { userId, scope, count: 1, resetAt: now + windowMs });
    return;
  }
  if (row.count >= limit) throw new Error("rate_limited");
  await ctx.db.patch(row._id, { count: row.count + 1 });
}

export function mediaEndpoint(): string {
  const site = (env as unknown as Record<string, string | undefined>).CONVEX_SITE_URL;
  if (!site) throw new Error("upload_not_configured");
  const url = new URL(site);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("upload_not_configured");
  return url.origin + "/media/upload";
}
