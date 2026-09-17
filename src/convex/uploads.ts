import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { userIdFromToken } from "./auth";
import { MAX_MEDIA_BYTES, rateLimit } from "./policy";
import { deleteUnreferencedStorage } from "./storageCleanup";

export const authorize = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await userIdFromToken(ctx, token);
    if (!userId) throw new Error("unauthorized");
    await rateLimit(ctx, userId, "upload", 12);
    await rateLimit(ctx, userId, "upload-day", 120, 24 * 60 * 60_000);
    return userId;
  },
});

/** Called only by the authenticated HTTP upload handler, never by the client. */
export const record = internalMutation({
  args: { token: v.string(), storageId: v.id("_storage"), mimeType: v.string() },
  handler: async (ctx, { token, storageId, mimeType }) => {
    const userId = await userIdFromToken(ctx, token);
    if (!userId) throw new Error("unauthorized");
    const file = await ctx.db.system.get(storageId);
    if (!file || file.size <= 0 || file.size > MAX_MEDIA_BYTES) throw new Error("invalid_file");
    const existing = await ctx.db.query("uploads").withIndex("by_storage", q => q.eq("storageId", storageId)).unique();
    if (existing) {
      if (existing.userId !== userId) throw new Error("file_not_owned");
      return;
    }
    await ctx.db.insert("uploads", { userId, storageId, mimeType, createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60_000 });
  },
});

/** Metadata and provenance are checked in the SAME transaction as attachment. */
export async function requireOwnedMedia(ctx: MutationCtx, userId: Id<"users">, storageId: Id<"_storage">, kind: "image" | "voice") {
  const file = await ctx.db.system.get(storageId);
  if (!file || file.size <= 0 || file.size > MAX_MEDIA_BYTES) throw new Error("invalid_file");
  const receipt = await ctx.db.query("uploads").withIndex("by_storage", q => q.eq("storageId", storageId)).unique();
  const mime = (file.contentType ?? receipt?.mimeType ?? "").split(";")[0].trim().toLowerCase();
  const supported = kind === "image" ? ["image/jpeg", "image/png", "image/webp"] : ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav"];
  if (!supported.includes(mime)) throw new Error("invalid_media_type");
  if (receipt) {
    if (receipt.userId !== userId) throw new Error("file_not_owned");
    if (receipt.expiresAt !== undefined && receipt.expiresAt <= Date.now()) throw new Error("upload_expired");
    if (receipt.expiresAt !== undefined) await ctx.db.patch(receipt._id, { expiresAt: undefined });
  } else {
    // Upgrade path: existing own attachments remain reusable, but a storage
    // identifier from another person's private chat is never ownership proof.
    const ownMessage = await ctx.db.query("messages").withIndex("by_storage", q => q.eq("storageId", storageId))
      .filter(q => q.and(q.eq(q.field("senderId"), userId), q.eq(q.field("deletedAt"), undefined))).first();
    const ownStatus = await ctx.db.query("statuses").withIndex("by_storage", q => q.eq("storageId", storageId))
      .filter(q => q.eq(q.field("userId"), userId)).first();
    if (!ownMessage && !ownStatus) throw new Error("file_not_owned");
    await ctx.db.insert("uploads", { userId, storageId, mimeType: mime, createdAt: Date.now() });
  }
  return mime;
}

export const cleanup = internalMutation({
  args: {},
  handler: async ctx => {
    const stale = await ctx.db.query("uploads").withIndex("by_expiry", q => q.gt("expiresAt", 0).lte("expiresAt", Date.now())).take(50);
    for (const upload of stale) await deleteUnreferencedStorage(ctx, upload.storageId);
    const limits = await ctx.db.query("rateLimits").withIndex("by_reset", q => q.lt("resetAt", Date.now() - 24 * 60 * 60_000)).take(100);
    for (const limit of limits) await ctx.db.delete(limit._id);
  },
});
