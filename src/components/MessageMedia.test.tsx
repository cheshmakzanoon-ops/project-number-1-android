import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceNoteBubble } from "./MessageMedia";

const deferred = () => {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const meta = (audio: HTMLAudioElement, duration: number) => {
  Object.defineProperty(audio, "duration", { configurable: true, value: duration });
  fireEvent.loadedMetadata(audio);
};
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    this.dispatchEvent(new Event("play")); return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("voice note playback", () => {
  it.each([NaN, Infinity, 0])("uses the recorded duration when browser metadata is %s", (duration) => {
    const { container } = render(<VoiceNoteBubble url="/voice.webm" durationMs={4200} mine />);
    meta(container.querySelector("audio")!, duration);
    expect(screen.getByRole("slider").getAttribute("aria-valuemax")).toBe("4200");
    expect(container.textContent).not.toMatch(/NaN|Infinity/);
  });
  it("updates duration on durationchange even after infinite streaming metadata", () => {
    const { container } = render(<VoiceNoteBubble url="/voice.webm" durationMs={4200} mine />);
    const audio = container.querySelector("audio")!; meta(audio, Infinity);
    Object.defineProperty(audio, "duration", { configurable: true, value: 7.25 });
    fireEvent.durationChange(audio);
    expect(screen.getByRole("slider").getAttribute("aria-valuemax")).toBe("7250");
  });
  it("does not pretend playback started after play is rejected", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    render(<VoiceNoteBubble url="/voice.webm" durationMs={2000} mine />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "پخش" })); });
    expect(screen.getByRole("button", { name: "پخش" })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
  it("does not open the parent message action menu when playing or seeking", async () => {
    const menu = vi.fn();
    render(<div onClick={menu}><VoiceNoteBubble url="/voice.webm" durationMs={4000} mine /></div>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "پخش" })); });
    fireEvent.click(screen.getByRole("slider"), { clientX: 0 });
    expect(menu).not.toHaveBeenCalled();
  });
  it("seeks using a finite duration fallback and prevents keyboard scrolling", () => {
    const { container } = render(<VoiceNoteBubble url="/voice.webm" durationMs={4200} mine />);
    const audio = container.querySelector("audio")!; meta(audio, Infinity);
    const slider = screen.getByRole("slider");
    expect(fireEvent.keyDown(slider, { key: "End" })).toBe(false);
    expect(audio.currentTime).toBe(4.2);
    fireEvent.keyDown(slider, { key: "Home" }); expect(audio.currentTime).toBe(0);
  });
  it("resets playback and duration state when the source changes", async () => {
    const { container, rerender } = render(<VoiceNoteBubble url="/one" durationMs={4000} mine />);
    const audio = container.querySelector("audio")!; meta(audio, 4);
    audio.currentTime = 2; fireEvent.timeUpdate(audio);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "پخش" })); });
    rerender(<VoiceNoteBubble url="/two" durationMs={8000} mine />);
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByRole("slider").getAttribute("aria-valuemax")).toBe("8000");
    expect(screen.getByRole("button", { name: "پخش" })).toBeTruthy();
  });
  it("pauses other voice notes but leaves call audio alone", async () => {
    const { container } = render(<><audio data-call-audio="true" /><VoiceNoteBubble url="/one" mine /><VoiceNoteBubble url="/two" mine /></>);
    const [call, one] = [...container.querySelectorAll("audio")];
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "پخش" })[0]); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "پخش" })); });
    expect(one.paused).toBe(true);
    expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts).not.toContain(call);
  });
  it("cleans up a pending playback request on unmount", async () => {
    const pending = deferred(); vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(pending.promise);
    const { unmount } = render(<VoiceNoteBubble url="/voice" mine />);
    fireEvent.click(screen.getByRole("button", { name: "پخش" })); unmount();
    await act(async () => { pending.resolve(); });
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
  it("bounds a stalled play promise and presents retry instead of an endless spinner", async () => {
    vi.useFakeTimers(); vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(new Promise(() => {}));
    render(<VoiceNoteBubble url="/voice" mine />);
    fireEvent.click(screen.getByRole("button", { name: "پخش" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("button", { name: "پخش" })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy(); expect(vi.getTimerCount()).toBe(0);
  });
});
