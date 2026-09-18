// @vitest-environment edge-runtime
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { hashToken, legacyHashToken } from "./auth";
import { allowedOrigin, mediaSignatureMatches, readBoundedBody } from "./http";
import { MAX_MEDIA_BYTES } from "./policy";
import type { Id } from "./_generated/dataModel";
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*s"]);
const INVITE = "test-family-invite-code-for-automated-tests";
const ORIGIN = "https://family.example.test";
const SITE = "https://precise-ptarmigan-412.eu-west-1.convex.site";
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="), c => c.charCodeAt(0));
const setup = () => convexTest(schema, modules);
type Test = ReturnType<typeof setup>;
async function person(t: Test, char: string) {
  const token = char.repeat(64);
  const result = await t.mutation(api.users.register, { token, displayName: `Person ${char}`, inviteCode: INVITE });
  return { token, id: result.user._id as Id<"users"> };
}
async function family() {
  const t = setup(), a = await person(t,"a"), b = await person(t,"b"), c = await person(t,"c");
  const conversationId = await t.mutation(api.conversations.startDM,{ token:a.token, otherId:b.id });
  return {t,a,b,c,conversationId};
}
async function upload(t: Test, token: string, bytes: Uint8Array<ArrayBuffer> = PNG, mime = "image/png") {
  return t.fetch("/media/upload", { method:"POST", headers:{Origin:ORIGIN, Authorization:`Bearer ${token}`, "Content-Type":mime}, body:bytes });
}
async function receipt(t: Test, token: string, mime = "image/png") {
  const storageId = await t.run(ctx => ctx.storage.store(new Blob([PNG],{type:mime})));
  await t.mutation(internal.uploads.record,{token,storageId,mimeType:mime});
  return storageId;
}
beforeEach(() => {
  vi.stubEnv("GARMA_FAMILY_INVITE_CODE",INVITE);
  vi.stubEnv("GARMA_ALLOWED_ORIGINS",ORIGIN);
  vi.stubEnv("CONVEX_SITE_URL",SITE);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("device credentials and private enrollment",()=> {
  it("stores a SHA-256 digest, never a raw token or the legacy hash", async()=> {
    const t=setup(),a=await person(t,"a");
    const sessions=await t.run(ctx=>ctx.db.query("sessions").collect());
    expect(sessions).toHaveLength(1);
    expect(sessions[0].tokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sessions[0].tokenHash).toBe(await hashToken(a.token));
    expect(JSON.stringify(sessions)).not.toContain(a.token);
    expect(sessions[0].tokenHash).not.toBe(legacyHashToken(a.token));
  });
  it("matches a known cryptographic digest including its domain separation",async()=> {
    expect(await hashToken("test-vector")).toBe("sha256:21d7e9f98f8f126c250edec192889008727f42989955f8df7d9af38e64b1c513");
    expect(await hashToken("test-vector")).not.toBe(await hashToken("test-vector-2"));
  });
  it.each(["", "short", "f".repeat(63), "f".repeat(65), "Z".repeat(64), "x".repeat(10000)])("refuses invalid new token case %#",async token=> {
    const t=setup();
    await expect(t.mutation(api.users.register,{token,displayName:"Dad",inviteCode:INVITE})).rejects.toThrow("invalid_device_token");
    expect(await t.run(ctx=>ctx.db.query("users").collect())).toHaveLength(0);
  });
  it.each([undefined,"", "wrong", "x".repeat(40)])("does not enroll without the correct invite (%s)",async inviteCode=> {
    const t=setup();
    await expect(t.mutation(api.users.register,{token:"a".repeat(64),displayName:"Dad",inviteCode})).rejects.toThrow(/invite_(required|invalid)/);
    expect(await t.run(ctx=>ctx.db.query("sessions").collect())).toHaveLength(0);
  });
  it("accepts the family's short permanent code and still rejects a near miss",async()=> {
    vi.stubEnv("GARMA_FAMILY_INVITE_CODE","2258432"); const t=setup();
    const result=await t.mutation(api.users.register,{token:"a".repeat(64),displayName:"Dad",inviteCode:"2258432"});
    expect(result.isNew).toBe(true);
    await expect(t.mutation(api.users.register,{token:"b".repeat(64),displayName:"Mum",inviteCode:"2258433"})).rejects.toThrow("invite_invalid");
    expect(await t.run(ctx=>ctx.db.query("users").collect())).toHaveLength(1);
  });
  it("fails closed when the operator has not configured private enrollment",async()=> {
    vi.stubEnv("GARMA_FAMILY_INVITE_CODE",""); const t=setup();
    await expect(t.mutation(api.users.register,{token:"a".repeat(64),displayName:"Dad",inviteCode:INVITE})).rejects.toThrow("registration_not_configured");
  });
  it("restores an existing account without requiring the family invitation again",async()=> {
    const t=setup(),a=await person(t,"a"); vi.stubEnv("GARMA_FAMILY_INVITE_CODE","");
    const result=await t.mutation(api.users.register,{token:a.token,displayName:"Different name"});
    expect(result.isNew).toBe(false); expect(result.user._id).toBe(a.id); expect(result.user.displayName).toBe("Person a");
  });
  it("migrates a legacy device on heartbeat without changing its identity",async()=> {
    const t=setup(),a=await person(t,"a");
    await t.run(async ctx=>{const s=(await ctx.db.query("sessions").collect())[0]; await ctx.db.patch(s._id,{tokenHash:legacyHashToken(a.token)});});
    expect((await t.query(api.users.me,{token:a.token}))._id).toBe(a.id);
    await t.mutation(api.users.heartbeat,{token:a.token});
    expect((await t.run(ctx=>ctx.db.query("sessions").collect()))[0].tokenHash).toBe(await hashToken(a.token));
    expect(await t.run(ctx=>ctx.db.query("users").collect())).toHaveLength(1);
    expect(await t.run(ctx=>ctx.db.system.query("_scheduled_functions").collect())).toHaveLength(0);
  });
  it("does not authenticate an orphan session",async()=> {
    const t=setup(),a=await person(t,"a");await t.run(ctx=>ctx.db.delete(a.id));
    expect(await t.query(api.users.me,{token:a.token})).toBeNull();
    expect(await t.query(api.users.directory,{token:a.token})).toEqual([]);
    await expect(t.mutation(api.messages.uploadUrl,{token:a.token})).rejects.toThrow("unauthorized");
  });
  it("fails closed for ambiguous legacy hash records",async()=> {
    const t=setup(),a=await person(t,"a"),b=await person(t,"b");
    await t.run(async ctx=>{ for(const s of await ctx.db.query("sessions").collect()) await ctx.db.patch(s._id,{tokenHash:legacyHashToken(a.token)}); });
    expect(await t.query(api.users.me,{token:a.token})).toBeNull();
    expect(await t.query(api.users.me,{token:b.token})).toBeNull();
  });
  it("authQuery reports the identity and only throws when requested",async()=> {
    const t=setup(),a=await person(t,"a");
    expect(await t.query(api.auth.authQuery,{token:a.token})).toBe(a.id);
    expect(await t.query(api.auth.authQuery,{token:"invalid"})).toBeNull();
    await expect(t.query(api.auth.authQuery,{token:"invalid",throwIfNone:true})).rejects.toThrow("unauthorized");
  });
  it("enforces the bounded family size without affecting existing accounts",async()=> {
    const t=setup(),a=await person(t,"a");
    await t.run(async ctx=>{for(let i=0;i<99;i++) await ctx.db.insert("users",{username:`u${i}`,displayName:"Existing",themeColor:"#000",createdAt:Date.now(),lastSeenAt:Date.now()});});
    await expect(person(t,"b")).rejects.toThrow("family_full");
    expect((await t.mutation(api.users.register,{token:a.token,displayName:"Existing"})).user._id).toBe(a.id);
  });
});

describe("authenticated HTTP media upload",()=> {
  it("accepts only explicitly configured origins",()=> {
    expect(allowedOrigin(ORIGIN)).toBe(true);
    for(const o of [null,"null","https://evil.test",ORIGIN+".evil.test","http://family.example.test"]) expect(allowedOrigin(o)).toBe(false);
    vi.stubEnv("GARMA_ALLOWED_ORIGINS","");expect(allowedOrigin(ORIGIN)).toBe(false);
  });
  it("preflights without authentication and without a wildcard",async()=> {
    const res=await setup().fetch("/media/upload",{method:"OPTIONS",headers:{Origin:ORIGIN}});
    expect(res.status).toBe(204);expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
  it("rejects an untrusted origin before creating storage",async()=> {
    const t=setup(),a=await person(t,"a");
    const res=await t.fetch("/media/upload",{method:"POST",headers:{Origin:"https://evil.test",Authorization:`Bearer ${a.token}`},body:PNG});
    expect(res.status).toBe(403);expect(await t.run(ctx=>ctx.db.system.query("_storage").collect())).toHaveLength(0);
  });
  it.each([undefined,"Bearer invalid","Basic abc"])('rejects invalid authorization %s',async authorization=> {
    const headers:Record<string,string>={Origin:ORIGIN,"Content-Type":"image/png"}; if(authorization) headers.Authorization=authorization;
    const t=setup(),res=await t.fetch("/media/upload",{method:"POST",headers,body:PNG});
    expect(res.status).toBe(401); expect(await t.run(ctx=>ctx.db.system.query("_storage").collect())).toHaveLength(0);
  });
  it("uploads real PNG bytes and records the authenticated owner",async()=> {
    const {t,a,b,conversationId}=await family(); const res=await upload(t,a.token);
    expect(res.status).toBe(200); expect(res.headers.get("Cache-Control")).toBe("no-store");
    const {storageId}=await res.json(); const r=await t.run(ctx=>ctx.db.query("uploads").unique());
    expect(r?.userId).toBe(a.id);expect(r?.storageId).toBe(storageId);expect(r?.expiresAt).toBeGreaterThan(Date.now());
    await t.mutation(api.messages.send,{token:a.token,conversationId,kind:"image",storageId,mimeType:"text/html"});
    const messages=await t.query(api.messages.list,{token:b.token,conversationId});
    expect(messages[0].mimeType).toBe("image/png");expect(messages[0].url).toBeTruthy();
    expect((await t.run(ctx=>ctx.db.query("uploads").unique()))?.expiresAt).toBeUndefined();
  });
  it.each(["text/html","image/svg+xml","application/javascript","image/jpeg"])('rejects unsupported or forged MIME %s',async mime=> {
    const t=setup(),a=await person(t,"a");expect((await upload(t,a.token,PNG,mime)).status).toBe(415);
    expect(await t.run(ctx=>ctx.db.system.query("_storage").collect())).toHaveLength(0);
  });
  it("rejects HTML disguised as PNG",async()=> {
    const t=setup(),a=await person(t,"a"); expect((await upload(t,a.token,new TextEncoder().encode('<html><script>alert(1)</script></html>'))).status).toBe(415);
  });
  it("rejects an empty body",async()=> {
    const t=setup(),a=await person(t,"a");expect((await upload(t,a.token,new Uint8Array())).status).toBe(400);
  });
  it("rejects declared oversized files before reading them",async()=> {
    await expect(readBoundedBody(new Request(ORIGIN,{method:"POST",headers:{"Content-Length":String(MAX_MEDIA_BYTES+1)},body:PNG}))).rejects.toThrow("file_too_large");
  });
  it("enforces the byte limit without Content-Length and cancels the stream",async()=> {
    const cancelled=vi.fn(); let sent=false;
    const body=new ReadableStream<Uint8Array>({pull(controller){if(!sent){sent=true;controller.enqueue(new Uint8Array(MAX_MEDIA_BYTES+1));}},cancel:cancelled});
    await expect(readBoundedBody(new Request(ORIGIN,{method:"POST",body, duplex:"half"} as RequestInit))).rejects.toThrow("file_too_large");expect(cancelled).toHaveBeenCalled();
  });
  it("enforces the byte limit even when a client lies about Content-Length",async()=> {
    const req=new Request(ORIGIN,{method:"POST",headers:{"Content-Length":"1"},body:new Uint8Array(MAX_MEDIA_BYTES+1)});
    await expect(readBoundedBody(req)).rejects.toThrow("file_too_large");
  });
  it.each(["image/jpeg","image/png","image/webp","audio/webm","audio/mp4","audio/ogg","audio/wav"])('requires a real %s signature',mime=> {
    expect(mediaSignatureMatches(new Uint8Array(20),mime)).toBe(false);expect(mediaSignatureMatches(new Uint8Array(2),mime)).toBe(false);
  });
  it("does not allow storage IDs stolen from another user",async()=> {
    const {t,a,b,conversationId}=await family(); const storageId=await receipt(t,a.token);
    await expect(t.mutation(api.messages.send,{token:b.token,conversationId,kind:"image",storageId})).rejects.toThrow("file_not_owned");
    await expect(t.mutation(api.statuses.post,{token:b.token,kind:"image",storageId})).rejects.toThrow("file_not_owned");
  });
  it("does not allow an unrecorded storage ID to become a new attachment",async()=> {
    const {t,a,conversationId}=await family();const storageId=await t.run(ctx=>ctx.storage.store(new Blob([PNG],{type:"image/png"})));
    await expect(t.mutation(api.messages.send,{token:a.token,conversationId,kind:"image",storageId})).rejects.toThrow(/file_not_owned|invalid_media_type/);
  });
  it("cannot attach image bytes as a voice note",async()=> {
    const {t,a,conversationId}=await family(),storageId=await receipt(t,a.token);
    await expect(t.mutation(api.messages.send,{token:a.token,conversationId,kind:"voice",storageId})).rejects.toThrow("invalid_media_type");
  });
  it("cannot smuggle a storage attachment into a text message/status",async()=> {
    const {t,a,conversationId}=await family(),storageId=await receipt(t,a.token);
    await expect(t.mutation(api.messages.send,{token:a.token,conversationId,body:"text",storageId})).rejects.toThrow("invalid_media_type");
    await expect(t.mutation(api.statuses.post,{token:a.token,body:"text",storageId})).rejects.toThrow("invalid_media_type");
  });
  it("expires abandoned uploads but preserves adopted media",async()=> {
    const {t,a,conversationId}=await family(),keep=await receipt(t,a.token),discard=await receipt(t,a.token);
    await t.mutation(api.messages.send,{token:a.token,conversationId,kind:"image",storageId:keep});
    const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+25*60*60_000);
    await t.mutation(internal.uploads.cleanup,{});
    expect(await t.run(ctx=>ctx.db.system.get(discard))).toBeNull();expect(await t.run(ctx=>ctx.db.system.get(keep))).not.toBeNull();
  });
  it("rejects expired receipts even before the cleanup cron runs",async()=> {
    const {t,a,conversationId}=await family(),storageId=await receipt(t,a.token);
    const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+25*60*60_000);
    await expect(t.mutation(api.messages.send,{token:a.token,conversationId,kind:"image",storageId})).rejects.toThrow("upload_expired");
  });
  it("bounds upload requests and resets the window",async()=> {
    const t=setup(),a=await person(t,"a");for(let i=0;i<12;i++) await t.mutation(internal.uploads.authorize,{token:a.token});
    await expect(t.mutation(internal.uploads.authorize,{token:a.token})).rejects.toThrow("rate_limited");
    const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+60_001);await expect(t.mutation(internal.uploads.authorize,{token:a.token})).resolves.toBe(a.id);
  });
  it("duplicate message acknowledgements remain idempotent at the send budget",async()=> {
    const {t,a,conversationId}=await family();const id=await t.mutation(api.messages.send,{token:a.token,conversationId,body:"one",clientMessageId:"one"});
    for(let i=1;i<60;i++)await t.mutation(api.messages.send,{token:a.token,conversationId,body:String(i)});
    await expect(t.mutation(api.messages.send,{token:a.token,conversationId,body:"extra"})).rejects.toThrow("rate_limited");
    expect(await t.mutation(api.messages.send,{token:a.token,conversationId,body:"one",clientMessageId:"one"})).toBe(id);
  });
});

describe("call signaling and ring authorization",()=> {
  async function ringing(){const f=await family();const callId=await f.t.mutation(api.calls.start,{token:f.a.token,conversationId:f.conversationId,kind:"video"});return {...f,callId};}
  it("refuses signals injected by outsiders",async()=> {
    const {t,b,c,callId}=await ringing();await expect(t.mutation(api.calls.sendSignal,{token:c.token,callId,toUserId:b.id,type:"hangup"})).rejects.toThrow();
  });
  it("refuses signals sent to nonparticipants",async()=> {
    const {t,a,c,callId}=await ringing();await expect(t.mutation(api.calls.sendSignal,{token:a.token,callId,toUserId:c.id,type:"offer",payload:"private SDP"})).rejects.toThrow();
  });
  it("refuses signals after hangup",async()=> {
    const {t,a,b,callId}=await ringing();await t.mutation(api.calls.end,{token:a.token,callId});
    await expect(t.mutation(api.calls.sendSignal,{token:a.token,callId,toUserId:b.id,type:"offer"})).rejects.toThrow();
  });
  it("bounds payload bytes rather than JavaScript characters",async()=> {
    const {t,a,b,callId}=await ringing();await expect(t.mutation(api.calls.sendSignal,{token:a.token,callId,toUserId:b.id,type:"offer",payload:"🔥".repeat(17000)})).rejects.toThrow();
  });
  it("delivers valid participant signals and deletes acknowledged records",async()=> {
    const {t,a,b,callId}=await ringing();await t.mutation(api.calls.sendSignal,{token:a.token,callId,toUserId:b.id,type:"ice",payload:"candidate"});
    const pending=await t.query(api.calls.pendingSignals,{token:b.token,callId});expect(pending.some((s:{payload?:string})=>s.payload==="candidate")).toBe(true);
    await t.mutation(api.calls.ackSignals,{token:b.token,callId,cutoff:Date.now()+1000});expect(await t.query(api.calls.pendingSignals,{token:b.token,callId})).toEqual([]);
  });
  it("does not let a caller activate their own unanswered call",async()=> {
    const {t,a,callId}=await ringing();await t.mutation(api.calls.answer,{token:a.token,callId});
    expect((await t.query(api.calls.details,{token:a.token,callId})).call.status).toBe("ringing");
  });
  it("rejects a late answer and retires the expired ring",async()=> {
    const {t,a,b,callId}=await ringing(),now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+75_001);
    await t.mutation(api.calls.answer,{token:b.token,callId});expect((await t.query(api.calls.details,{token:a.token,callId})).call.status).toBe("missed");
  });
  it("allows redial after an expired outgoing ring",async()=> {
    const {t,a,conversationId,callId}=await ringing(),now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+75_001);
    const next=await t.mutation(api.calls.start,{token:a.token,conversationId,kind:"audio"});expect(next).not.toBe(callId);
    expect((await t.query(api.calls.details,{token:a.token,callId})).call.status).toBe("missed");
  });
  it("does not allow someone already connected to answer another call",async()=> {
    const {t,a,b,c,callId}=await ringing();await t.mutation(api.calls.answer,{token:b.token,callId});
    const other=await t.mutation(api.conversations.startDM,{token:c.token,otherId:b.id});
    const second=await t.mutation(api.calls.start,{token:c.token,conversationId:other,kind:"audio"});
    await expect(t.mutation(api.calls.answer,{token:b.token,callId:second})).rejects.toThrow("already_in_call");
    expect((await t.query(api.calls.details,{token:a.token,callId})).call.status).toBe("active");
  });
  it.each([0,-1,1.5,201,NaN,Infinity])("rejects invalid recent-call limit %s",async limit=> {
    const {t,a}=await ringing();await expect(t.query(api.calls.recent,{token:a.token,limit})).rejects.toThrow("invalid_limit");
  });
  it("throttles repeated push claims across retries and tabs",async()=> {
    const {t,a,callId}=await ringing();expect(await t.mutation(internal.pushSubs.claimIncoming,{token:a.token,callId})).toBe(true);
    expect(await t.mutation(internal.pushSubs.claimIncoming,{token:a.token,callId})).toBe(false);
    const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+15_001);expect(await t.mutation(internal.pushSubs.claimIncoming,{token:a.token,callId})).toBe(true);
  });
  it("never refreshes a stale ring by requesting another push",async()=> {
    const {t,a,callId}=await ringing(),now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+75_001);
    expect(await t.mutation(internal.pushSubs.claimIncoming,{token:a.token,callId})).toBe(false);
  });
  it("only the live initiator can claim a ring notification",async()=> {
    const {t,b,c,callId}=await ringing();for(const token of[b.token,c.token,"invalid"])await expect(t.mutation(internal.pushSubs.claimIncoming,{token,callId})).rejects.toThrow("unauthorized");
  });
});

describe("push device ownership and status retries",()=> {
  const endpoint="https://fcm.googleapis.com/fcm/send/device";
  const keys={p256dh:"A".repeat(87),auth:"B".repeat(22)};
  it("never transfers an existing push endpoint to another account",async()=> {
    const {t,a,b}=await family();const id=await t.mutation(api.pushSubs.saveSubscription,{token:a.token,endpoint,...keys});
    await expect(t.mutation(api.pushSubs.saveSubscription,{token:b.token,endpoint,...keys})).rejects.toThrow("subscription_not_owned");
    expect((await t.run(ctx=>ctx.db.get(id as Id<"pushSubscriptions">)))?.userId).toBe(a.id);
  });
  it("an old failed delivery cannot prune refreshed subscription keys",async()=> {
    const {t,a}=await family();await t.mutation(api.pushSubs.saveSubscription,{token:a.token,endpoint,...keys});
    await t.mutation(api.pushSubs.saveSubscription,{token:a.token,endpoint,...keys,auth:"C".repeat(22)});
    await t.mutation(internal.pushSubs.pruneSubscription,{endpoint,...keys});
    expect(await t.query(internal.pushSubs.listSubscriptions,{userId:a.id})).toHaveLength(1);
    await t.mutation(internal.pushSubs.pruneSubscription,{endpoint,...keys,auth:"C".repeat(22)});
    expect(await t.query(internal.pushSubs.listSubscriptions,{userId:a.id})).toEqual([]);
  });
  it("posting the same image status twice with one client ID yields one post",async()=> {
    const {t,a}=await family(),storageId=await receipt(t,a.token);
    const args={token:a.token,storageId,kind:"image" as const,clientPostId:"photo-attempt"};
    const id=await t.mutation(api.statuses.post,args);expect(await t.mutation(api.statuses.post,args)).toBe(id);
    expect(await t.query(api.statuses.mine,{token:a.token})).toHaveLength(1);
  });
  it("status-viewer identities are shown only to the owner or the viewer themselves",async()=> {
    const {t,a,b,c}=await family();const statusId=await t.mutation(api.statuses.post,{token:a.token,body:"hello"});
    await t.mutation(api.statuses.view,{token:b.token,statusId});
    expect((await t.query(api.statuses.mine,{token:a.token}))[0].viewers).toHaveLength(1);
    expect((await t.query(api.statuses.forOwner,{token:b.token,ownerId:a.id}))[0].viewers[0].userId).toBe(b.id);
    expect((await t.query(api.statuses.forOwner,{token:c.token,ownerId:a.id}))[0].viewers).toEqual([]);
    expect((await t.query(api.statuses.feed,{token:c.token}))[0].viewers).toEqual([]);
  });
});

it("only authenticated family members can obtain a usable invitation",async()=>{
  const t=setup(),a=await person(t,"a");
  await expect(t.query(api.users.familyInvite,{token:"e".repeat(64)})).rejects.toThrow("unauthorized");
  expect(await t.query(api.users.familyInvite,{token:a.token})).toBe(INVITE);
  vi.stubEnv("GARMA_FAMILY_INVITE_CODE","");
  await expect(t.query(api.users.familyInvite,{token:a.token})).rejects.toThrow("registration_not_configured");
});
