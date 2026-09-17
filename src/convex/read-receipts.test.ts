// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*s"]);
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000); });
afterEach(() => vi.restoreAllMocks());
async function family() {
  const t = convexTest(schema, modules);
  const a = await t.mutation(api.users.register, {token: "read-a", displayName: "A"});
  const b = await t.mutation(api.users.register, {token: "read-b", displayName: "B"});
  const cid = await t.mutation(api.conversations.startDM, {token: "read-a", otherId: b.user._id});
  const send = (body: string, token = "read-a") => t.mutation(api.messages.send, {conversationId: cid, token, body});
  const cursor = () => t.run(async ctx => (await ctx.db.query("conversationMembers")
    .withIndex("by_conversation", q => q.eq("conversationId", cid))
    .filter(q => q.eq(q.field("userId"), b.user._id)).first())!.lastReadAt);
  const read = (throughId?: Id<"messages">) => t.mutation(api.conversations.markRead,
    {conversationId: cid, token: "read-b", throughId});
  return {t, a: a.user, b: b.user, cid, send, cursor, read};
}
describe("receipts acknowledge only a displayed snapshot", () => {
  it("an offline-delayed receipt never acknowledges a newer unseen message", async () => {
    const f = await family(); const seen = await f.send("seen"); const unseen = await f.send("unseen");
    await f.read(seen);
    const rows = await f.t.query(api.messages.list, {token:"read-a", conversationId:f.cid});
    expect(rows.find((r:any) => r._id===seen).read).toBe(true);
    expect(rows.find((r:any) => r._id===unseen).read).toBe(false);
    expect((await f.t.query(api.conversations.myConversations, {token:"read-b"}))[0].unread).toBe(1);
  });
  it("out-of-order receipts never move the cursor backwards", async () => {
    const f=await family(); const first=await f.send("first"), last=await f.send("last");
    await f.read(last); const before=await f.cursor(); await f.read(first);
    expect(await f.cursor()).toBe(before);
  });
  it("sending from an older chat view does not mark incoming messages as read", async () => {
    const f=await family(); await f.send("unseen incoming"); await f.send("reply from old view", "read-b");
    expect((await f.t.query(api.conversations.myConversations,{token:"read-b"}))[0].unread).toBe(1);
  });
  it("many own messages cannot hide a later unread incoming message", async () => {
    const f=await family();
    await f.t.run(async ctx => { for(let n=0;n<110;n++) await ctx.db.insert("messages", {
      conversationId:f.cid, senderId:f.b._id, body:`own-${n}`, createdAt:Date.now()+1}); });
    await f.send("incoming");
    expect((await f.t.query(api.conversations.myConversations,{token:"read-b"}))[0].unread).toBe(1);
  });
  it("caps the unread badge at 100 after excluding deleted and own messages", async () => {
    const f=await family();
    await f.t.run(async ctx => { for(let n=0;n<120;n++) await ctx.db.insert("messages", {
      conversationId:f.cid, senderId:f.a._id, body:`incoming-${n}`, createdAt:Date.now()+1}); });
    expect((await f.t.query(api.conversations.myConversations,{token:"read-b"}))[0].unread).toBe(100);
  });
  it("cannot acknowledge a message from a different conversation", async () => {
    const f=await family();
    const c=await f.t.mutation(api.users.register,{token:"read-c",displayName:"C"});
    const other=await f.t.mutation(api.conversations.startDM,{token:"read-a",otherId:c.user._id});
    const message=await f.t.mutation(api.messages.send,{token:"read-a",conversationId:other,body:"private"});
    const before=await f.cursor(); await f.read(message); expect(await f.cursor()).toBe(before);
  });
  it("keeps older clients without a snapshot argument compatible", async () => {
    const f=await family(); await f.send("latest"); await f.read();
    expect((await f.t.query(api.conversations.myConversations,{token:"read-b"}))[0].unread).toBe(0);
  });
});
describe("message windows", () => {
  it("includes both neighbors when messages share the exact createdAt millisecond", async () => {
    const f=await family(); const ids=[];
    for(let n=0;n<5;n++) ids.push(await f.send(String(n)));
    const rows=await f.t.query(api.messages.listAround,{token:"read-a",conversationId:f.cid,anchorId:ids[2]});
    expect(rows.map((r:any)=>r.body)).toEqual(["0","1","2","3","4"]);
  });
  it.each([0,-1,0.5,201,1_000_000])("rejects invalid requested limit %s", async limit => {
    const f=await family();
    await expect(f.t.query(api.messages.list,{token:"read-a",conversationId:f.cid,limit})).rejects.toThrow("invalid_limit");
  });
});
