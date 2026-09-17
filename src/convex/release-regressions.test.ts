// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { validPushSubscription } from "../lib/pushValidation";
import { listSubscriptions, pruneSubscription } from "./pushSubs";
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*s"]);
const setup = () => convexTest(schema, modules);
type Harness = ReturnType<typeof setup>;
async function person(t: Harness, label: string) {
  const token = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const result = await t.mutation(api.users.register, { inviteCode: "test-family-invite-code-for-automated-tests",  token, displayName: label });
  return { token, id: result.user._id };
}
async function family() {
  const t=setup(), a=await person(t,"A"), b=await person(t,"B"), outsider=await person(t,"C");
  const conversationId=await t.mutation(api.conversations.startDM,{token:a.token,otherId:b.id});
  return {t,a,b,outsider,conversationId};
}
afterEach(() => vi.restoreAllMocks());
describe("private conversations", () => {
  it("does not expose the directory to an unknown session",async()=> {
    const {t}=await family(); expect(await t.query(api.users.directory,{})).toEqual([]);
    expect(await t.query(api.users.directory,{token:"invalid"})).toEqual([]);
  });
  it("does not reveal another family's call by ID", async()=> {
    const {t,a,b,outsider,conversationId}=await family();
    const callId=await t.mutation(api.calls.start,{token:a.token,conversationId,kind:"video"});
    expect(await t.query(api.calls.details,{token:outsider.token,callId})).toBeNull();
    expect((await t.query(api.calls.details,{token:b.token,callId})).isMine).toBe(true);
  });
  it("rejects reactions by a non-member", async()=> {
    const {t,a,b,outsider,conversationId}=await family();
    const messageId=await t.mutation(api.messages.send,{token:a.token,conversationId,body:"private"});
    await expect(t.mutation(api.messages.toggleReaction,{token:outsider.token,messageId,emoji:"❤️"})).rejects.toThrow("not_member");
    await t.mutation(api.messages.toggleReaction,{token:b.token,messageId,emoji:"❤️"});
    expect((await t.query(api.messages.list,{token:b.token,conversationId}))[0].reactions).toEqual([{emoji:"❤️",count:1}]);
  });
  it("rejects nonexistent contacts rather than creating a phantom chat",async()=> {
    const {t,a,b}=await family(); await t.run(async(ctx)=>{await ctx.db.delete(b.id);});
    await expect(t.mutation(api.conversations.startDM,{token:a.token,otherId:b.id})).rejects.toThrow("user_not_found");
  });
  it("does not return deleted message text or quote contents",async()=> {
    const {t,a,b,conversationId}=await family();
    const messageId=await t.mutation(api.messages.send,{token:a.token,conversationId,body:"secret"});
    await t.mutation(api.messages.send,{token:b.token,conversationId,body:"reply",replyToId:messageId});
    await t.mutation(api.messages.remove,{token:a.token,messageId});
    const messages=await t.query(api.messages.list,{token:b.token,conversationId});
    expect(messages.find((m:{_id:string})=>m._id===messageId).body).toBe("");
    expect(messages.find((m:{replyToId?:string})=>m.replyToId===messageId).reply.body).toBe("");
  });
  it("returns a search/quote window in chronological order",async()=> {
    const {t,a,conversationId}=await family(); const now=Date.now(); const clock=vi.spyOn(Date,"now");
    const ids=[]; for(let i=0;i<5;i++){clock.mockReturnValue(now+i*1000);
      ids.push(await t.mutation(api.messages.send,{token:a.token,conversationId,body:String(i)}));}
    const rows=await t.query(api.messages.listAround,{token:a.token,conversationId,anchorId:ids[2]});
    expect(rows.map((r:{body:string})=>r.body)).toEqual(["0","1","2","3","4"]);
  });
  it("deduplicates same-chat retries but rejects a reused ID in a different chat",async()=> {
    const {t,a,b,outsider,conversationId}=await family();
    const id=await t.mutation(api.messages.send,{token:a.token,conversationId,body:"once",clientMessageId:"stable"});
    expect(await t.mutation(api.messages.send,{token:a.token,conversationId,body:"once",clientMessageId:"stable"})).toBe(id);
    const other=await t.mutation(api.conversations.startDM,{token:a.token,otherId:outsider.id});
    await expect(t.mutation(api.messages.send,{token:a.token,conversationId:other,body:"not here",clientMessageId:"stable"})).rejects.toThrow("client_id_conflict");
    expect(await t.query(api.messages.list,{token:b.token,conversationId:other})).toEqual([]);
  });
});
describe("real screen-share session lifetime",()=> {
  async function shared() {
    const f=await family(); const {t,a,b,conversationId}=f;
    const callId=await t.mutation(api.calls.start,{token:a.token,conversationId,kind:"video"});
    await t.mutation(api.calls.answer,{token:b.token,callId});
    const sessionId=await t.mutation(internal.screenShare.insertHandoff,{codeHash:"hash",userId:a.id,callId});
    return {...f,callId,sessionId};
  }
  it("unconsumed handoffs cannot masquerade as live captures",async()=> {
    const {t,sessionId}=await shared(); expect(await t.query(api.screenShare.sessionState,{sessionId})).toEqual({live:false});
  });
  it("a consumed live session survives both housekeeping and the 60-second code expiry",async()=> {
    const {t,a,callId,sessionId}=await shared(); const now=Date.now();
    expect(await t.mutation(internal.screenShare.consumeHandoff,{codeHash:"hash"})).not.toBeNull();
    vi.spyOn(Date,"now").mockReturnValue(now+120_000);
    await t.mutation(api.calls.cleanupStale,{token:a.token});
    expect(await t.query(api.screenShare.sessionState,{sessionId})).toEqual({live:true});
    await t.mutation(internal.screenShare.insertHandoff,{codeHash:"new",userId:a.id,callId});
    expect(await t.query(api.screenShare.sessionState,{sessionId})).toEqual({live:true});
    expect(await t.mutation(internal.screenShare.consumeHandoff,{codeHash:"hash"})).toBeNull();
  });
  it("hangup invalidates the consumed session and permits cleanup",async()=> {
    const {t,a,callId,sessionId}=await shared(); await t.mutation(internal.screenShare.consumeHandoff,{codeHash:"hash"});
    await t.mutation(api.calls.end,{token:a.token,callId,status:"ended"});
    expect(await t.query(api.screenShare.sessionState,{sessionId})).toEqual({live:false});
    await t.mutation(api.calls.cleanupStale,{token:a.token});
    expect(await t.run(ctx=>ctx.db.get(sessionId))).toBeNull();
  });
  it("fails closed if the participant row disappeared, including the initiator",async()=> {
    const {t,a,callId}=await shared();
    await t.run(async(ctx)=>{const row=await ctx.db.query("callParticipants").withIndex("by_call_user",q=>q.eq("callId",callId).eq("userId",a.id)).first();await ctx.db.delete(row!._id);});
    expect(await t.mutation(internal.screenShare.consumeHandoff,{codeHash:"hash"})).toBeNull();
    await expect(t.mutation(internal.screenShare.insertHandoff,{codeHash:"other",userId:a.id,callId})).rejects.toThrow("not_active_participant");
  });
});
describe("push endpoint boundary",()=> {
  it("keeps subscription listing and server pruning internal",()=> {
    expect(listSubscriptions.isInternal).toBe(true); expect(pruneSubscription.isInternal).toBe(true);
  });
  it.each(["http://fcm.googleapis.com/fcm/send/123","https://127.0.0.1/admin","https://fcm.googleapis.com.evil.test/","https://fcm.googleapis.com:444/","https://user:password@fcm.googleapis.com/"])("rejects %s",url=>{
    expect(validPushSubscription(url,"A".repeat(87),"B".repeat(22))).toBe(false);
  });
  it("accepts known HTTPS push providers and validates key sizes",()=> {
    for(const host of ["fcm.googleapis.com","updates.push.services.mozilla.com","web.push.apple.com"]){
      expect(validPushSubscription(`https://${host}/send/123`,"A".repeat(87),"B".repeat(22))).toBe(true);}
    expect(validPushSubscription("https://fcm.googleapis.com/send","invalid","invalid")).toBe(false);
  });
});

beforeEach(() => vi.stubEnv("GARMA_FAMILY_INVITE_CODE", "test-family-invite-code-for-automated-tests"));
afterEach(() => vi.unstubAllEnvs());
