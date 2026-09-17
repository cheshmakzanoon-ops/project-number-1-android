import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/** Shared media must survive deletion of just one referencing message/status. */
export async function deleteUnreferencedStorage(ctx: MutationCtx, storageId: Id<"_storage"> | undefined) {
  if (!storageId) return;
  const [message, status] = await Promise.all([
    ctx.db.query("messages").withIndex("by_storage", q => q.eq("storageId", storageId))
      .filter(q => q.eq(q.field("deletedAt"), undefined)).first(),
    ctx.db.query("statuses").withIndex("by_storage", q => q.eq("storageId", storageId)).first(),
  ]);
  if (!message && !status && await ctx.db.system.get(storageId)) await ctx.storage.delete(storageId);
}
