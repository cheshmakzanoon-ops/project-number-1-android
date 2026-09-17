import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { putStorageFile, startRecording } from "./media";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class Recorder {
  static isTypeSupported = vi.fn(() => false);
  static instances: Recorder[] = [];
  static fails = false;
  mimeType = "audio/mp4";
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) }); this.onstop?.(); });
  constructor(_stream: unknown, readonly options?: unknown) {
    if (Recorder.fails) throw new Error("constructor_failed");
    Recorder.instances.push(this);
  }
}
const tick = () => Promise.resolve().then(() => Promise.resolve());
beforeEach(() => { vi.useFakeTimers(); Recorder.instances = []; Recorder.fails = false;
  vi.stubGlobal("MediaRecorder", Recorder); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function microphone() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const request = deferred<MediaStream>();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => request.promise) } });
  return { track, stream, request };
}
describe("uploads", () => {
  it("POSTs the blob and returns only a valid storage ID", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ storageId: "stored-file" }) });
    vi.stubGlobal("fetch", fetch);
    const blob = new Blob(["photo"], { type: "image/jpeg" });
    expect(await putStorageFile("https://example.test/upload", blob)).toBe("stored-file");
    expect(fetch).toHaveBeenCalledWith("https://example.test/upload", expect.objectContaining({ method: "POST", body: blob, signal: expect.any(AbortSignal) }));
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([null, {}, {storageId: 7}, {storageId: ""}])("rejects malformed success: %j", async (json) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => json }));
    await expect(putStorageFile("https://example.test/upload", new Blob(["x"]))).rejects.toThrow("no_storage_id");
  });
  it("aborts an upload that never completes", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const upload = putStorageFile("https://example.test/upload", new Blob(["x"]));
    const assertion = expect(upload).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(120_000); await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects empty files before making a network request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(putStorageFile("https://example.test/upload", new Blob())).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
describe("microphone ownership", () => {
  it("cancels permission-pending capture and closes a later grant without recording", async () => {
    const mic = microphone(); const error = vi.fn(); const handle = startRecording({ onError: error });
    handle.cancel(); mic.request.resolve(mic.stream); await tick();
    expect(mic.track.stop).toHaveBeenCalledOnce(); expect(Recorder.instances).toHaveLength(0);
    await expect(handle.stop()).rejects.toThrow("cancelled"); expect(error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stop before permission settles rather than opening an orphan microphone", async () => {
    const mic = microphone(); const handle = startRecording();
    await expect(handle.stop()).rejects.toThrow("recording_not_started");
    mic.request.resolve(mic.stream); await tick(); expect(mic.track.stop).toHaveBeenCalledOnce();
    expect(Recorder.instances).toHaveLength(0);
  });
  it("uses the browser default MIME and measures recording time, not permission wait", async () => {
    const mic = microphone(); const handle = startRecording();
    await vi.advanceTimersByTimeAsync(10_000); mic.request.resolve(mic.stream); await tick();
    expect(Recorder.instances[0].options).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000); const recording = await handle.stop();
    expect(recording.mimeType).toBe("audio/mp4"); expect(recording.durationMs).toBe(2_000);
    expect(recording.blob.size).toBeGreaterThan(0); expect(mic.track.stop).toHaveBeenCalledOnce();
    expect(await handle.stop()).toBe(recording); expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up after recorder construction fails", async () => {
    Recorder.fails = true; const mic = microphone(); const error = vi.fn();
    const handle = startRecording({ onError: error }); mic.request.resolve(mic.stream); await tick();
    await expect(handle.stop()).rejects.toThrow("constructor_failed");
    expect(mic.track.stop).toHaveBeenCalledOnce(); expect(error).toHaveBeenCalledOnce();
  });
  it("permission failure is reported even without a stop caller", async () => {
    const mic = microphone(); const error = vi.fn(); startRecording({ onError: error });
    mic.request.reject(new DOMException("Denied", "NotAllowedError")); await tick();
    expect(error).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("cancelling live capture is idempotent and releases all timers", async () => {
    const mic = microphone(); const handle = startRecording(); mic.request.resolve(mic.stream); await tick();
    handle.cancel(); handle.cancel(); expect(mic.track.stop).toHaveBeenCalledOnce();
    expect(Recorder.instances[0].stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it("times out unanswered permission and releases a subsequent grant", async () => {
    const mic = microphone(); const handle = startRecording();
    await vi.advanceTimersByTimeAsync(30_000); await expect(handle.stop()).rejects.toThrow("microphone_timeout");
    mic.request.resolve(mic.stream); await tick(); expect(mic.track.stop).toHaveBeenCalledOnce();
  });
});
