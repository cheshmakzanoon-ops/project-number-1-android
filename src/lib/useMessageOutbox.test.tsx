import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { useMessageOutbox } from "./useMessageOutbox";
import { loadOutbox, appendOutbox } from "./outbox";
const cid = "conversation-test" as Id<"conversations">;
const reply = "message-test" as Id<"messages">;
const tick = () => Promise.resolve().then(() => Promise.resolve());
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("durably records text, ID and reply BEFORE invoking a hanging send", async () => {
  const send = vi.fn(() => { expect(loadOutbox(cid)[0]).toMatchObject({ body: "سلام", replyToId: reply }); return new Promise(() => {}); });
  const {result} = renderHook(() => useMessageOutbox(cid, "token", send));
  act(() => { expect(result.current.enqueue("سلام", reply)).toBe(true); });
  expect(result.current.pending).toHaveLength(1); expect(send).toHaveBeenCalledOnce();
  const id = loadOutbox(cid)[0].clientMsgId;
  await act(async () => { await vi.advanceTimersByTimeAsync(17_000); });
  expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(loadOutbox(cid)[0].clientMsgId).toBe(id);
});
it("does not lose a newly queued message while an older send resolves", async () => {
  let finish!: (value: unknown) => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise((r) => { finish = r; })).mockResolvedValue("ok");
  const {result} = renderHook(() => useMessageOutbox(cid, "token", send));
  act(() => { result.current.enqueue("one"); result.current.enqueue("two"); });
  expect(loadOutbox(cid)).toHaveLength(2);
  await act(async () => { finish("ok"); await tick(); });
  expect(send).toHaveBeenCalledTimes(2); expect(result.current.pending).toHaveLength(0); expect(loadOutbox(cid)).toEqual([]);
});
it("preserves the draft contract when storage fails", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  const send = vi.fn(); const {result} = renderHook(() => useMessageOutbox(cid, "token", send));
  act(() => { expect(result.current.enqueue("keep me")).toBe(false); });
  expect(send).not.toHaveBeenCalled(); expect(result.current.pending).toEqual([]);
});
it("does not silently truncate older queued work at capacity", () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  const {result} = renderHook(() => useMessageOutbox(cid, "token", vi.fn()));
  act(() => { for(let i=0;i<50;i++) expect(result.current.enqueue(`message-${i}`)).toBe(true);
    expect(result.current.enqueue("too many")).toBe(false); });
  expect(loadOutbox(cid)[0].body).toBe("message-0"); expect(loadOutbox(cid)).toHaveLength(50);
});
it("a late acknowledgment from an unmounted chat preserves a new mount's work", async () => {
  let finish!: (value: unknown) => void;
  const send = vi.fn(() => new Promise((r) => { finish = r; }));
  const {result,unmount} = renderHook(() => useMessageOutbox(cid, "token", send));
  act(() => { result.current.enqueue("old"); }); unmount();
  appendOutbox(cid, { body: "new", clientMsgId: "new-id", queuedAt: Date.now() });
  finish("ok"); await tick(); expect(loadOutbox(cid).map(x=>x.body)).toEqual(["new"]);
});
it("keeps offline text across remount and retries with the same reply and ID", async () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  const first = renderHook(() => useMessageOutbox(cid, "token", vi.fn()));
  act(() => { first.result.current.enqueue("offline",reply); }); const original=loadOutbox(cid)[0]; first.unmount();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  const send=vi.fn().mockResolvedValue("ok"); renderHook(() => useMessageOutbox(cid,"token",send));
  await act(tick); expect(send).toHaveBeenCalledWith(expect.objectContaining({clientMessageId:original.clientMsgId, replyToId:reply}));
  expect(loadOutbox(cid)).toEqual([]);
});
it("two open chat instances preserve each other's offline messages", () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  const a = renderHook(() => useMessageOutbox(cid, "token", vi.fn()));
  const b = renderHook(() => useMessageOutbox(cid, "token", vi.fn()));
  act(() => { a.result.current.enqueue("from first tab"); });
  act(() => { b.result.current.enqueue("from second tab"); });
  expect(loadOutbox(cid).map(x => x.body)).toEqual(["from first tab", "from second tab"]);
  expect(a.result.current.pending).toHaveLength(2);
  expect(b.result.current.pending).toHaveLength(2);
});
it("switching conversations never sends the old conversation's queue to the new one", async () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  const send = vi.fn().mockResolvedValue("ok");
  const other = "another-conversation" as Id<"conversations">;
  const hook = renderHook(({id}) => useMessageOutbox(id, "token", send), {initialProps:{id:cid}});
  act(() => { hook.result.current.enqueue("private to original"); });
  hook.rerender({id:other});
  expect(hook.result.current.pending).toEqual([]);
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  await act(async () => { window.dispatchEvent(new Event("online")); await tick(); });
  expect(send).not.toHaveBeenCalled();
  expect(loadOutbox(cid)[0].body).toBe("private to original");
});
it("migrates legacy records without resurrecting acknowledged text", async () => {
  localStorage.setItem(`garma.outbox.${cid}`,JSON.stringify([
    {body:"legacy first",clientMsgId:"legacy-first",queuedAt:1,replyToId:reply},
    {body:"legacy second",clientMsgId:"legacy-second",queuedAt:2},
  ]));
  let finish!: (v:unknown) => void;
  const send=vi.fn().mockResolvedValueOnce("ok").mockImplementationOnce(()=>new Promise(r=>{finish=r;}));
  const hook=renderHook(()=>useMessageOutbox(cid,"token",send));
  await act(tick);
  expect(loadOutbox(cid).map(x=>x.body)).toEqual(["legacy second"]);
  expect(send.mock.calls[0][0].replyToId).toBe(reply);
  await act(async()=>{finish("ok");await tick();});
  expect(hook.result.current.pending).toEqual([]);
  expect(localStorage.getItem(`garma.outbox.${cid}`)).toBeNull();
});
it("refreshes another browser tab's new records on storage events", () => {
  Object.defineProperty(navigator,"onLine",{configurable:true,value:false});
  const hook=renderHook(()=>useMessageOutbox(cid,"token",vi.fn()));
  const key=`garma.outbox.v2.${cid}.external`;
  act(()=>{
    localStorage.setItem(key,JSON.stringify({body:"other browser tab",clientMsgId:"external",queuedAt:1}));
    window.dispatchEvent(new StorageEvent("storage",{key}));
  });
  expect(hook.result.current.pending[0].body).toBe("other browser tab");
});
it("an unreadable record cannot discard other durable messages", () => {
  localStorage.setItem(`garma.outbox.v2.${cid}.corrupt`,"{bad json");
  appendOutbox(cid,{body:"valid",clientMsgId:"valid",queuedAt:1});
  expect(loadOutbox(cid).map(x=>x.body)).toEqual(["valid"]);
});
it("a late old-chat acknowledgment does not clear a new chat's records", async () => {
  let finish!: (v:unknown)=>void;
  const other="other-chat" as Id<"conversations">;
  const send=vi.fn(()=>new Promise(r=>{finish=r;}));
  const hook=renderHook(({id})=>useMessageOutbox(id,"token",send),{initialProps:{id:cid}});
  act(()=>{hook.result.current.enqueue("original");});
  hook.rerender({id:other});
  Object.defineProperty(navigator,"onLine",{configurable:true,value:false});
  act(()=>{hook.result.current.enqueue("new chat");});
  await act(async()=>{finish("ok");await tick();});
  expect(loadOutbox(cid)).toEqual([]);
  expect(hook.result.current.pending[0].body).toBe("new chat");
  expect(loadOutbox(other)[0].body).toBe("new chat");
});
