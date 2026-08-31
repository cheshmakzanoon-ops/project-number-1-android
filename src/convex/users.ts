import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { hashToken, userIdFromToken, publicUser } from "./auth";
import type { Id } from "./_generated/dataModel";

const PALETTE = [
  "#ea8a3e",
  "#5d9c73",
  "#4f7cac",
  "#b45b6e",
  "#8a63b4",
  "#c9823c",
  "#3f8f7d",
  "#a05f8f",
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * Sign up with just a name (or restore an existing device identity).
 * Returns { user, isNew } given a device token + chosen display name.
 */
export const register = mutation({
  args: {
    token: v.string(),
    displayName: v.string(),
    whoami: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await userIdFromToken(ctx, args.token);
    if (existing) {
      // Device already has an identity.
      const u = await ctx.db.get(existing);
      if (!u) throw new Error("no_user");
      return { user: publicUser(u), isNew: false };
    }

    const name = args.displayName.trim().slice(0, 40);
    if (!name) throw new Error("name_required");

    const now = Date.now();

    // Username: a short, unique handle so names need not be unique.
    let username = slugify(args.whoami || name);
    if (!username) username = "user";
    // Ensure uniqueness.
    for (let attempt = 0; ; attempt++) {
      const candidate = attempt === 0 ? username : `${username}${attempt}`;
      const dup = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", candidate))
        .first();
      if (!dup) {
        username = candidate;
        break;
      }
    }

    const userId: Id<"users"> = await ctx.db.insert("users", {
      username,
      displayName: name,
      themeColor: PALETTE[hashString(name) % PALETTE.length],
      createdAt: now,
      lastSeenAt: now,
    });

    await ctx.db.insert("sessions", {
      userId,
      tokenHash: hashToken(args.token),
      createdAt: now,
    });

    const u = await ctx.db.get(userId);
    return { user: publicUser(u!), isNew: true };
  },
});

/** Resolve who this device is. */
export const me = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await userIdFromToken(ctx, args.token);
    if (!userId) return null;
    const u = await ctx.db.get(userId);
    if (!u) return null;
    return publicUser(u);
  },
});

/** Presence heartbeat. */
export const heartbeat = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const userId = await userIdFromToken(ctx, args.token);
    if (!userId) return;
    await ctx.db.patch(userId, { lastSeenAt: Date.now() });
  },
});

const ONLINE_WINDOW = 60_000;

/** Everyone in the family except me, with presence. */
export const directory = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    const all = await ctx.db.query("users").order("asc").collect();
    const now = Date.now();
    return all
      .filter((u) => u._id !== me)
      .map((u) => ({
        ...publicUser(u),
        online: now - u.lastSeenAt < ONLINE_WINDOW,
        isMe: u._id === me,
      }));
  },
});

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u0600-\u06FF\uFB8A\u0670]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 24);
}