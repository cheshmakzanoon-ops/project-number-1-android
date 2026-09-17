// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
const modules=import.meta.glob(["./**/*.*s","!./**/*.test.*s"]);
afterEach(()=>vi.restoreAllMocks());
async function setup() {
  const t=convexTest(schema,modules);
  const a=(await t.mutation(api.users.register,{ inviteCode: "test-family-invite-code-for-automated-tests", token:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",displayName:"A"})).user;
  const b=(await t.mutation(api.users.register,{ inviteCode: "test-family-invite-code-for-automated-tests", token:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",displayName:"B"})).user;
  const storageId=await t.run(ctx=>ctx.storage.store(new Blob(["image bytes"],{type:"image/jpeg"})));
  await t.mutation(internal.uploads.record, {token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", storageId, mimeType: "image/jpeg"});
  const first=await t.mutation(api.statuses.post,{token:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",kind:"image",storageId});
  return {t,a,b,storageId,first};
}
it("deleting a status does not destroy a photograph used in another person's status",async()=>{
  const {t,b,storageId,first}=await setup();
  // Historical shared reference from the previous release; new cross-owner attachments are denied.
  await t.run(ctx => ctx.db.insert("statuses", {userId:b._id,kind:"image",storageId,body:"legacy",createdAt:Date.now()}));
  await t.mutation(api.statuses.remove,{token:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",statusId:first});
  expect(await t.run(async ctx=>Boolean(await ctx.storage.get(storageId)))).toBe(true);
});
it("deleting a status does not destroy the same photograph in a conversation",async()=>{
  const {t,b,storageId,first}=await setup();
  const conversationId=await t.mutation(api.conversations.startDM,{token:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",otherId:b._id});
  await t.mutation(api.messages.send,{token:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",conversationId,kind:"image",storageId,body:"shared"});
  await t.mutation(api.statuses.remove,{token:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",statusId:first});
  expect(await t.run(async ctx=>Boolean(await ctx.storage.get(storageId)))).toBe(true);
});
it("deleting the last reference releases the image",async()=>{
  const {t,storageId,first}=await setup();
  await t.mutation(api.statuses.remove,{token:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",statusId:first});
  expect(await t.run(async ctx=>Boolean(await ctx.storage.get(storageId)))).toBe(false);
});
it("expiry housekeeping releases images after their final reference expires",async()=>{
  const {t,storageId}=await setup();
  vi.spyOn(Date,"now").mockReturnValue(Date.now()+24*60*60*1000+1);
  await t.mutation(api.statuses.cleanupExpired,{token:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"});
  expect(await t.run(async ctx=>Boolean(await ctx.storage.get(storageId)))).toBe(false);
});
it("a busy global feed cannot hide a person's own status",async()=>{
  const {t,b,first}=await setup();
  await t.run(async ctx=>{for(let n=0;n<205;n++) await ctx.db.insert("statuses",{
    userId:b._id,kind:"text",body:`other-${n}`,createdAt:Date.now()+n+1,viewers:[]});});
  expect((await t.query(api.statuses.mine,{token:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})).map((r:any)=>r._id)).toContain(first);
});
it("view receipts are idempotent rather than changing on every reactive delivery",async()=>{
  const {t,first}=await setup();
  await t.mutation(api.statuses.view,{token:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",statusId:first});
  const before=await t.run(ctx=>ctx.db.get(first));
  vi.spyOn(Date,"now").mockReturnValue(Date.now()+1000);
  await t.mutation(api.statuses.view,{token:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",statusId:first});
  expect(await t.run(ctx=>ctx.db.get(first))).toEqual(before);
});

beforeEach(() => vi.stubEnv("GARMA_FAMILY_INVITE_CODE", "test-family-invite-code-for-automated-tests"));
afterEach(() => vi.unstubAllEnvs());
