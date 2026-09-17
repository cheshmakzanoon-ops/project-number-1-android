import { internalMutation } from "./_generated/server";
import { cleanupCalls } from "./calls";
import { cleanupStatuses } from "./statuses";
export const sweep = internalMutation({
  args: {},
  handler: async ctx => {
    await cleanupCalls(ctx);
    await cleanupStatuses(ctx);
    const signals = await ctx.db.query("callSignals").withIndex("by_created", q => q.lt("createdAt", Date.now() - 120_000)).take(500);
    for (const signal of signals) await ctx.db.delete(signal._id);
    const typing = await ctx.db.query("typing").take(100);
    for (const row of typing) if (Date.now() - row.updatedAt > 60_000) await ctx.db.delete(row._id);
  },
});
