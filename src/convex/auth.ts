import { query } from "./_generated/server";
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/** Deterministic hash of the device token so we never store the raw token. */
export function hashToken(token: string): string {
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

/** Resolve the user id for a device token, or null. */
export async function userIdFromToken(ctx: QueryCtx, token: string | undefined | null): Promise<Id<"users"> | null> {
  if (!token) return null;
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", hashToken(token)))
    .first();
  return session?.userId ?? null;
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
    if (!args.throwIfNone) return null;
    if (!userId) throw new Error("unauthorized");
    return userId;
  },
});