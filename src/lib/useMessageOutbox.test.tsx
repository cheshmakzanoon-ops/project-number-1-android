import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Id } from "../convex/_generated/dataModel";
import { useMessageOutbox } from "./useMessageOutbox";
import { loadOutbox, saveOutbox } from "./outbox";
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
  saveOutbox(cid, [...loadOutbox(cid), { body: "new", clientMsgId: "new-id", queuedAt: Date.now() }]);
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
