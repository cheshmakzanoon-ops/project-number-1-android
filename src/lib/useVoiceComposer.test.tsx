import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("./media", () => ({ mediaRecorderSupported: () => true, startRecording: (...args: unknown[]) => mock.start(...args) }));
import { useVoiceComposer } from "./useVoiceComposer";
const recording = () => ({ blob: new Blob(["voice"], { type: "audio/webm" }), durationMs: 2100, mimeType: "audio/webm" });
function setup() {
  let resolve!: (value: ReturnType<typeof recording>) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<ReturnType<typeof recording>>((a,b) => { resolve = a; reject = b; });
  const handle = { stop: vi.fn(() => pending), cancel: vi.fn() };
  mock.start.mockReturnValue(handle);
  const onSend = vi.fn().mockResolvedValue(true), onError = vi.fn();
  const view = renderHook(({ scope, blocked }) => useVoiceComposer({ scope, blocked, busy: false, onSend, onError }),
    { initialProps: { scope: "one", blocked: false } });
  return { ...view, handle, onSend, onError, resolve, reject };
}
beforeEach(() => mock.start.mockReset());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("voice composer ownership", () => {
  it("suspends for a call, keeps the encoded draft, and sends only after an explicit retry", async () => {
    const r = setup(); act(() => r.result.current.start());
    r.rerender({ scope: "one", blocked: true });
    expect(r.handle.stop).toHaveBeenCalledOnce();
    await act(async () => r.resolve(recording()));
    expect(r.result.current.phase).toBe("retry"); expect(r.onSend).not.toHaveBeenCalled();
    await act(async () => r.result.current.finish()); expect(r.onSend).not.toHaveBeenCalled();
    r.rerender({ scope: "one", blocked: false });
    await act(async () => r.result.current.finish());
    expect(r.onSend).toHaveBeenCalledOnce(); expect(r.result.current.phase).toBe("idle");
  });
  it("does not start a microphone while the call is active", () => {
    const r = setup(); r.rerender({ scope: "one", blocked: true });
    act(() => r.result.current.start()); expect(mock.start).not.toHaveBeenCalled();
  });
  it("a call arriving during final encoding invalidates auto-send but preserves the recording", async () => {
    const r = setup(); act(() => r.result.current.start());
    let send!: Promise<void>; act(() => { send = r.result.current.finish(); });
    r.rerender({ scope: "one", blocked: true });
    await act(async () => { r.resolve(recording()); await send; });
    expect(r.onSend).not.toHaveBeenCalled(); expect(r.result.current.phase).toBe("retry");
  });
  it("can cancel a suspended pending recorder without resurrecting a late draft", async () => {
    const r = setup(); act(() => { r.result.current.start(); r.result.current.suspend(); r.result.current.cancel(); });
    await act(async () => r.resolve(recording()));
    expect(r.handle.cancel).toHaveBeenCalled(); expect(r.result.current.phase).toBe("idle");
    expect(r.onSend).not.toHaveBeenCalled();
  });
  it("old-scope completion cannot upload into a new conversation", async () => {
    const r = setup(); act(() => r.result.current.start());
    let send!: Promise<void>; act(() => { send = r.result.current.finish(); });
    r.rerender({ scope: "two", blocked: false });
    await act(async () => { r.resolve(recording()); await send; });
    expect(r.handle.cancel).toHaveBeenCalled(); expect(r.onSend).not.toHaveBeenCalled();
    expect(r.result.current.phase).toBe("idle");
  });
  it("retains the same blob for retry after a failed upload", async () => {
    const r = setup(); r.onSend.mockResolvedValueOnce(false);
    act(() => r.result.current.start()); const blob = recording(); r.resolve(blob);
    await act(async () => r.result.current.finish()); expect(r.result.current.phase).toBe("retry");
    await act(async () => r.result.current.finish());
    expect(r.onSend.mock.calls.map(call => call[0])).toEqual([blob,blob]);
    expect(r.handle.stop).toHaveBeenCalledOnce();
  });
  it("ignores a second Send while the first encoding/send is pending", async () => {
    const r = setup(); act(() => r.result.current.start());
    let send!: Promise<void>; act(() => { send = r.result.current.finish(); });
    await act(async () => r.result.current.finish());
    await act(async () => { r.resolve(recording()); await send; });
    expect(r.handle.stop).toHaveBeenCalledOnce(); expect(r.onSend).toHaveBeenCalledOnce();
  });
  it("drops a subsecond accidental recording and reports it rather than uploading", async () => {
    const r = setup(); act(() => r.result.current.start()); r.resolve({ ...recording(), durationMs: 500 });
    await act(async () => r.result.current.finish());
    expect(r.onSend).not.toHaveBeenCalled(); expect(r.onError).toHaveBeenCalled();
  });
  it("stops at the recording limit without sending unexpectedly", async () => {
    const r = setup(); act(() => r.result.current.start());
    act(() => mock.start.mock.calls[0][0].onTick(290_000));
    expect(r.handle.stop).toHaveBeenCalledOnce();
    await act(async () => r.resolve(recording()));
    expect(r.result.current.phase).toBe("retry"); expect(r.onSend).not.toHaveBeenCalled();
  });
  it("unmount disposes the capture and suppresses all late errors and uploads", async () => {
    const r = setup(); act(() => r.result.current.start()); r.unmount();
    act(() => mock.start.mock.calls[0][0].onError("late"));
    expect(r.handle.cancel).toHaveBeenCalledOnce(); expect(r.onError).not.toHaveBeenCalled();
  });
  it("stops when the document is hidden without automatically sending", async () => {
    const r = setup(); act(() => r.result.current.start());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => r.resolve(recording()));
    expect(r.handle.stop).toHaveBeenCalledOnce(); expect(r.onSend).not.toHaveBeenCalled();
  });
  it("a denied permission during call interruption returns the composer to idle", async () => {
    const r = setup(); act(() => r.result.current.start()); r.rerender({ scope: "one", blocked: true });
    await act(async () => r.reject(new Error("not started")));
    expect(r.result.current.phase).toBe("idle"); expect(r.onSend).not.toHaveBeenCalled();
  });
});
