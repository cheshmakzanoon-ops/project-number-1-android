import { query } from "./_generated/server";
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/** Compatibility reader for sessions created before the SHA-256 migration. */
export function legacyHashToken(token: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < token.length; i++) {
    const ch = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** A domain-separated cryptographic digest; raw bearer tokens never enter storage. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`garma.session.v2:${token}`));
  return "sha256:" + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function validNewToken(token: string): boolean {
  return /^[a-f0-9]{64}$/.test(token);
}

export async function sessionFromToken(ctx: QueryCtx, token: string | undefined | null) {
  if (!token || token.length > 256) return null;
  const strong = await hashToken(token);
  // A migrated record has its legacy digest REMOVED, not retained as an
  // alternative credential. Ambiguous/colliding old records fail closed.
  for (const digest of [strong, legacyHashToken(token)]) {
    const matches = await ctx.db.query("sessions")
      .withIndex("by_token_hash", q => q.eq("tokenHash", digest)).take(2);
    if (matches.length > 1) return null;
    if (matches[0]) return await ctx.db.get(matches[0].userId) ? matches[0] : null;
  }
  return null;
}

/** Resolve only an extant identity. A dangling session cannot authorize writes. */
export async function userIdFromToken(ctx: QueryCtx, token: string | undefined | null): Promise<Id<"users"> | null> {
  return (await sessionFromToken(ctx, token))?.userId ?? null;
}

/** Mutations opportunistically replace old hashes without changing device tokens. */
export async function migrateSession(ctx: import("./_generated/server").MutationCtx, token: string) {
  const session = await sessionFromToken(ctx, token);
  if (session && !session.tokenHash.startsWith("sha256:")) {
    await ctx.db.patch(session._id, { tokenHash: await hashToken(token) });
  }
  return session;
}

/** A safe public projection of a user. */
export function publicUser(u: {
  _id: Id<"users">;
  username: string;
  displayName: string;
  themeColor: string;
  createdAt: number;
  lastSeenAt: number;
}) {
  return {
    _id: u._id,
    username: u.username,
    displayName: u.displayName,
    themeColor: u.themeColor,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
  };
}

export const authQuery = query({
  args: { token: v.optional(v.string()), throwIfNone: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await userIdFromToken(ctx, args.token);
    if (!userId && args.throwIfNone) throw new Error("unauthorized");
    return userId;
  },
});