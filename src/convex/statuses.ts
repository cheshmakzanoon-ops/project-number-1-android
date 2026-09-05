import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { userIdFromToken } from "./auth";
import type { Id } from "./_generated/dataModel";

/**
 * Statuses (وضعیت): ephemeral 24h updates, text or image.
 *
 * Shape of every row returned to the client (the deployed UI reads exactly
 * these fields — verified against the production bundle):
 *   _id, kind ("text" | "image"), body, url, mimeType, createdAt, expiresAt,
 *   viewers[{userId, displayName, themeColor, viewedAt}],
 *   ownerId, ownerName, ownerColor
 */
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BODY = 300;
const MAX_CAPTION = 200;
const MAX_VIEWERS = 100;

type StatusRow = {
  _id: Id<"statuses">;
  userId: Id<"users">;
  body: string;
  createdAt: number;
  kind?: "text" | "image";
  storageId?: Id<"_storage">;
  mimeType?: string;
  viewers?: Array<{ userId: Id<"users">; displayName: string; themeColor: string; viewedAt: number }>;
};

type StatusOwner = { displayName: string; themeColor: string; lastSeenAt: number } | null;

/** Project a raw statuses row into the client-facing shape. */
async function statusView(ctx: QueryCtx, row: StatusRow, owner: StatusOwner) {
  const url =
    row.kind === "image" && row.storageId ? await ctx.storage.getUrl(row.storageId) : null;
  return {
    _id: row._id,
    kind: row.kind ?? "text",
    body: row.body,
    url: url ?? undefined,
    mimeType: row.mimeType,
    storageId: row.storageId,
    createdAt: row.createdAt,
    expiresAt: row.createdAt + STATUS_TTL_MS,
    viewers: row.viewers ?? [],
    ownerId: row.userId,
    ownerName: owner?.displayName ?? "…",
    ownerColor: owner?.themeColor ?? "#8a6340",
  };
}

/** Rows newer than the TTL, freshest first (bounded scan via the by_created index). */
async function liveRows(ctx: QueryCtx) {
  const now = Date.now();
  return await ctx.db
    .query("statuses")
    .withIndex("by_created", (q) => q.gte("createdAt", now - STATUS_TTL_MS))
    .order("desc")
    .take(200);
}

/** Delete everything I posted that has already expired (housekeeping). */
async function pruneMine(ctx: { db: MutationCtx["db"] }, me: Id<"users">) {
  const now = Date.now();
  const mine = await ctx.db
    .query("statuses")
    .withIndex("by_user", (q) => q.eq("userId", me))
    .collect();
  for (const s of mine) {
    if (now - s.createdAt > STATUS_TTL_MS) await ctx.db.delete(s._id);
  }
}

/**
 * Post a status. Two kinds:
 *  - text: { kind:"text", body } — replaces my previous text status (WhatsApp
 *    keeps a single editable text update; images stack).
 *  - image: { kind:"image", storageId, body?, mimeType? } — caption optional.
 */
export const post = mutation({
  args: {
    token: v.string(),
    kind: v.optional(v.union(v.literal("text"), v.literal("image"))),
    body: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    mimeType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) throw new Error("unauthorized");
    await pruneMine(ctx, me);
    const now = Date.now();
    const kind = args.kind ?? "text";

    // One text status per person: retire any of my still-live text rows
    // before inserting the new one (image rows stay until they expire).
    const mine = await ctx.db
      .query("statuses")
      .withIndex("by_user", (q) => q.eq("userId", me))
      .collect();

    if (kind === "text") {
      const body = (args.body ?? "").trim();
      if (!body) throw new Error("empty_status");
      if (body.length > MAX_BODY) throw new Error("status_too_long");
      for (const s of mine) {
        if ((s.kind ?? "text") !== "image") await ctx.db.delete(s._id);
      }
      return await ctx.db.insert("statuses", {
        userId: me,
        body,
        kind: "text",
        createdAt: now,
        viewers: [],
      });
    }

    if (!args.storageId) throw new Error("storage_required");
    const body = (args.body ?? "").trim().slice(0, MAX_CAPTION);
    return await ctx.db.insert("statuses", {
      userId: me,
      body,
      kind: "image",
      storageId: args.storageId,
      mimeType: args.mimeType,
      createdAt: now,
      viewers: [],
    });
  },
});

/** Delete one of my own statuses (tap ➜ delete). Frees the stored image. */
export const remove = mutation({
  args: { token: v.string(), statusId: v.id("statuses") },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    const row = await ctx.db.get(args.statusId);
    if (!row || row.userId !== me) return;
    if (row.storageId) {
      try {
        await ctx.storage.delete(row.storageId);
      } catch {
        /* already gone — the row itself is what matters */
      }
    }
    await ctx.db.delete(args.statusId);
  },
});

/**
 * Everyone's live statuses, newest first, EXCLUDING mine (the client fetches
 * those separately via `mine` and prepends the "me" ring itself).
 */
export const feed = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];
    const rows = await liveRows(ctx);
    const out: Awaited<ReturnType<typeof statusView>>[] = [];
    for (const row of rows) {
      if (row.userId === me) continue;
      out.push(await statusView(ctx, row, await ctx.db.get(row.userId)));
    }
    return out;
  },
});

/** My live statuses (the "me" ring / my own story viewer). */
export const mine = query({
  args: { token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];
    const rows = await liveRows(ctx);
    const out: Awaited<ReturnType<typeof statusView>>[] = [];
    for (const row of rows) {
      if (row.userId !== me) continue;
      out.push(await statusView(ctx, row, await ctx.db.get(row.userId)));
    }
    return out;
  },
});

/** One person's live statuses (opened from the ring). */
export const forOwner = query({
  args: { token: v.optional(v.string()), ownerId: v.id("users") },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return [];
    const rows = await liveRows(ctx);
    const out: Awaited<ReturnType<typeof statusView>>[] = [];
    for (const row of rows) {
      if (row.userId !== args.ownerId) continue;
      out.push(await statusView(ctx, row, await ctx.db.get(row.userId)));
    }
    return out;
  },
});

/** Mark someone's status as seen (idempotent per viewer; owner sees the list). */
export const view = mutation({
  args: { token: v.string(), statusId: v.id("statuses") },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    const row = await ctx.db.get(args.statusId);
    if (!row || row.userId === me) return;
    if (Date.now() - row.createdAt > STATUS_TTL_MS) return;
    const meDoc = await ctx.db.get(me);
    if (!meDoc) return;
    const viewers = (row.viewers ?? []).filter((v) => v.userId !== me);
    viewers.push({
      userId: me,
      displayName: meDoc.displayName,
      themeColor: meDoc.themeColor,
      viewedAt: Date.now(),
    });
    await ctx.db.patch(row._id, { viewers: viewers.slice(-MAX_VIEWERS) });
  },
});

/** Mints a signed Convex storage upload URL for image statuses. */
export const uploadUrl = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) throw new Error("unauthorized");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Housekeeping for statuses nobody is around to delete. There is no scheduler
 * in this app, so it piggybacks on the presence heartbeat every open client
 * already sends (see users.heartbeat), exactly like calls.cleanupStale.
 */
export const cleanupExpired = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const me = await userIdFromToken(ctx, args.token);
    if (!me) return;
    await pruneMine(ctx, me);
    const now = Date.now();
    const expired = await ctx.db
      .query("statuses")
      .withIndex("by_created", (q) => q.lt("createdAt", now - STATUS_TTL_MS))
      .order("asc")
      .take(30);
    for (const s of expired) await ctx.db.delete(s._id);
  },
});
