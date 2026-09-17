// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
// Execute the shipped worker, not a reimplementation of its handlers.
function worker(clients: object[] = []) {
  const listeners: Record<string,(event: any)=>void> = {};
  const self={ addEventListener:(name:string,fn:(event:any)=>void)=>{listeners[name]=fn;},
    location:{origin:"https://garma.test"}, skipWaiting:vi.fn(),
    clients:{matchAll:vi.fn().mockResolvedValue(clients),claim:vi.fn(),openWindow:vi.fn()},
    registration:{showNotification:vi.fn().mockResolvedValue(undefined)} };
  const caches={keys:vi.fn().mockResolvedValue(["unrelated-cache","garma-shell-v5","garma-shell-v6","garma-shell-dev"]),delete:vi.fn(),match:vi.fn(),open:vi.fn()};
  caches.open.mockResolvedValue({ match:caches.match, put:vi.fn(), addAll:vi.fn() });
  const fetch=vi.fn().mockRejectedValue(new Error("offline"));
  vm.runInNewContext(readFileSync(resolve("public/sw.js"),"utf8"),{self,caches,fetch,URL,Response,Date,AbortController,setTimeout,clearTimeout});
  async function fire(name:string,props:object={}) {
    const tasks:Promise<unknown>[]=[]; const event={...props,waitUntil:(p:Promise<unknown>)=>tasks.push(p),respondWith:(p:Promise<unknown>)=>tasks.push(p)};
    listeners[name](event); return await Promise.all(tasks);
  }
  return {self,caches,fetch,fire};
}
describe("notification actions",()=> {
  it.each(["accept","decline"])("reads event.action=%s and delivers once, not to every tab",async action=> {
    const one={focus:vi.fn(),postMessage:vi.fn()},two={focus:vi.fn(),postMessage:vi.fn()};
    const {fire,self}=worker([one,two]);
    await fire("notificationclick",{action,notification:{data:{callId:"call-123"},close:vi.fn()}});
    expect(one.postMessage).toHaveBeenCalledWith({type:"call-action",callId:"call-123",action});
    expect(two.postMessage).not.toHaveBeenCalled(); expect(self.clients.openWindow).not.toHaveBeenCalled();
  });
  it("cold-launches with the decline command intact",async()=> {
    const {fire,self}=worker(); await fire("notificationclick",{action:"decline",notification:{data:{callId:"call-123"},close:vi.fn()}});
    expect(self.clients.openWindow).toHaveBeenCalledWith("https://garma.test/?call=call-123&callAction=decline");
  });
  it("falls back to opening the app when an existing window has gone away",async()=> {
    const {fire,self}=worker([{focus:vi.fn(),postMessage:()=>{throw new Error("closed");}}]);
    await fire("notificationclick",{action:"accept",notification:{data:{callId:"call-123"},close:vi.fn()}});
    expect(self.clients.openWindow).toHaveBeenCalledOnce();
  });
  it("does not ring for stale queued pushes",async()=> {
    const {fire,self}=worker();await fire("push",{data:{json:()=>({type:"incoming_call",callId:"c",timestamp:Date.now()-76_000})}});
    expect(self.registration.showNotification).not.toHaveBeenCalled();
  });
});
it("activation does not delete other apps' caches",async()=> {
  const {fire,caches}=worker();await fire("activate");expect(caches.delete).toHaveBeenCalledExactlyOnceWith("garma-shell-v5");
});
it("an uncached offline navigation returns a response, never undefined",async()=> {
  const {fire}=worker();const result=await fire("fetch",{request:{method:"GET",url:"https://garma.test/",mode:"navigate"}});
  expect(result.at(-1)).toBeInstanceOf(Response);expect((result.at(-1) as Response).status).toBe(503);
});
it("does not intercept private same-origin API requests",async()=> {
  const {fire,fetch}=worker();expect(await fire("fetch",{request:{method:"GET",url:"https://garma.test/api/private",mode:"cors"}})).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it("continues to the network when Cache Storage is unavailable",async()=>{
  const {fire,caches,fetch}=worker();caches.open.mockRejectedValue(new Error("denied"));
  fetch.mockResolvedValue(new Response("online"));
  const [response]=await fire("fetch",{request:{method:"GET",url:"https://garma.test/",mode:"navigate"}});
  expect(await (response as Response).text()).toBe("online");
});
it("does not let a corrupt cache abort a successful navigation",async()=>{
  const {fire,caches,fetch}=worker();caches.match.mockRejectedValue(new Error("evicted"));
  fetch.mockResolvedValue(new Response("retry",{status:502}));
  const [response]=await fire("fetch",{request:{method:"GET",url:"https://garma.test/",mode:"navigate"}});
  expect((response as Response).status).toBe(502);
});
it("never writes notification URL commands into the shell cache",async()=>{
  const {fire,caches,fetch}=worker();const cache=await caches.open();
  fetch.mockResolvedValue(new Response("shell"));
  await fire("fetch",{request:{method:"GET",url:"https://garma.test/?call=secret&callAction=accept",mode:"navigate"}});
  expect(cache.put).not.toHaveBeenCalled();
});
it("uses the cached shell for an offline deep navigation",async()=>{
  const {fire,caches}=worker();caches.match.mockResolvedValue(new Response("offline shell"));
  const [response]=await fire("fetch",{request:{method:"GET",url:"https://garma.test/screen-share",mode:"navigate"}});
  expect(await (response as Response).text()).toBe("offline shell");
});
it("rejects incomplete shell installation instead of activating a broken update",async()=>{
  const {fire,caches,self}=worker();const cache=await caches.open();
  cache.addAll.mockRejectedValue(new Error("one asset failed"));
  await expect(fire("install")).rejects.toThrow();expect(self.skipWaiting).not.toHaveBeenCalled();
});

it("serves a retained immutable chunk to an already-open old tab while offline", async () => {
  const { fire, caches, fetch } = worker();
  const oldRequest = { method: "GET", url: "https://garma.test/assets/old-release-Bf2s0x.js", mode: "cors" };
  const previous = { match: vi.fn().mockResolvedValue(new Response("old chunk")) };
  caches.open.mockImplementation(async (key: string) => key === "garma-shell-v6" ? previous : { match: vi.fn(), put: vi.fn() });
  const [response] = await fire("fetch", { request: oldRequest });
  expect(response).toBeInstanceOf(Response);
  expect(await (response as Response).text()).toBe("old chunk");
  expect(previous.match).toHaveBeenCalledWith(oldRequest);
  expect(fetch).not.toHaveBeenCalled();
});
it("never replaces a revision's pinned offline HTML with a newer network page", async () => {
  const { fire, caches, fetch } = worker(); const cache = await caches.open();
  caches.match.mockResolvedValue(new Response("installed shell"));
  fetch.mockResolvedValue(new Response("new deployment shell"));
  const request = { method: "GET", url: "https://garma.test/", mode: "navigate" };
  const [online] = await fire("fetch", { request });
  expect(await (online as Response).text()).toBe("new deployment shell");
  expect(cache.put).not.toHaveBeenCalled();
  fetch.mockRejectedValue(new Error("offline"));
  const [offline] = await fire("fetch", { request });
  expect(await (offline as Response).text()).toBe("installed shell");
});
it("does not serve the HTML shell for a missing old JavaScript chunk", async () => {
  const { fire } = worker();
  const [response] = await fire("fetch", { request: { method: "GET", url: "https://garma.test/assets/old-release-Bf2s0x.js", mode: "cors" } });
  expect(response).toBeInstanceOf(Response);
  expect((response as Response).status).toBe(503);
  expect((response as Response).headers.get("Content-Type")).toContain("text/plain");
});
it("does not copy unlisted assets from the network into a revision cache", async () => {
  const { fire, caches, fetch } = worker(); const cache = await caches.open();
  fetch.mockResolvedValue(new Response("newly requested chunk"));
  const [response] = await fire("fetch", { request: { method: "GET", url: "https://garma.test/assets/new-release-Bf2s0x.js", mode: "cors" } });
  expect(response).toBeInstanceOf(Response);
  expect(await (response as Response).text()).toBe("newly requested chunk");
  expect(cache.put).not.toHaveBeenCalled();
});
it("ignores query-string assets and unrelated cache namespaces", async () => {
  const { fire, caches } = worker();
  expect(await fire("fetch", { request: { method: "GET", url: "https://garma.test/assets/private.js?token=secret", mode: "cors" } })).toEqual([]);
  caches.open.mockImplementation(async (key: string) => ({ match: vi.fn().mockResolvedValue(key === "unrelated-cache" ? new Response("private") : undefined) }));
  const [response] = await fire("fetch", { request: { method: "GET", url: "https://garma.test/assets/old-release-Bf2s0x.js", mode: "cors" } });
  expect((response as Response).status).toBe(503);
  expect(caches.open).not.toHaveBeenCalledWith("unrelated-cache");
});
