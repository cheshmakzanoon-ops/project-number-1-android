import { StrictMode, type ReactElement } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteVideoTrack } from "livekit-client";
import { RemoteVideoFeed } from "./RemoteVideoFeed";

/**
 * Controlled SDK-track double: records attach/detach element arguments and
 * keeps a live registry so we can assert real registrations (Strict Mode,
 * shared-track independence). SDK fixture casts stay at the test boundary.
 */
class FakeRemoteVideoTrack {
  readonly label: string;
  attachCalls: HTMLVideoElement[] = [];
  detachCalls: HTMLVideoElement[] = [];
  private registry = new Set<HTMLVideoElement>();
  private onAttach?: (el: HTMLVideoElement) => void;
  statsImpl: () => Promise<unknown> = async () => undefined;
  statsCalls = 0;
  stopCalls = 0;

  constructor(label: string, onAttach?: (el: HTMLVideoElement) => void) {
    this.label = label;
    this.onAttach = onAttach;
  }

  get attachedElements(): HTMLVideoElement[] {
    return [...this.registry];
  }

  attach(element: HTMLVideoElement): HTMLVideoElement {
    this.attachCalls.push(element);
    if (this.onAttach) this.onAttach(element);
    this.registry.add(element);
    return element;
  }

  detach(element: HTMLVideoElement): HTMLVideoElement {
    this.detachCalls.push(element);
    this.registry.delete(element);
    return element;
  }

  getReceiverStats(): Promise<unknown> {
    this.statsCalls += 1;
    return this.statsImpl();
  }

  stop(): void {
    this.stopCalls += 1;
  }
}

const toSdk = (fake: FakeRemoteVideoTrack): RemoteVideoTrack =>
  fake as unknown as RemoteVideoTrack;

function installMediaMethodStubs() {
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  for (const [name, impl] of [
    [
      "play",
      function play(this: HTMLMediaElement) {
        return Promise.resolve();
      },
    ],
    ["pause", function pause() {}],
  ] as const) {
    try {
      Object.defineProperty(proto, name, { configurable: true, writable: true, value: impl });
    } catch {
      // jsdom's native stub stays; per-test behavior comes from vi.spyOn.
    }
  }
}

/** Replace the (absent in JSDOM) video-frame-callback API with a recorder. */
function stubFrameCallbacks() {
  type Entry = { element: HTMLVideoElement; cb: () => void; id: number };
  const entries: Entry[] = [];
  Object.defineProperty(HTMLVideoElement.prototype, "requestVideoFrameCallback", {
    configurable: true,
    value(this: HTMLVideoElement, cb: () => void) {
      entries.push({ element: this, cb, id: entries.length + 1 });
      return entries.length;
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, "cancelVideoFrameCallback", {
    configurable: true,
    value() {
      /* no-op recorder */
    },
  });
  return entries;
}

beforeEach(() => {
  installMediaMethodStubs();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function renderFeed(
  ui: ReactElement,
): { container: HTMLElement; video: HTMLVideoElement; unmount: () => void; rerender: (el: ReactElement) => void } {
  const view = render(ui);
  const video = view.container.querySelector("video") as HTMLVideoElement;
  if (!video) throw new Error("expected a rendered <video>");
  return { container: view.container, video, unmount: view.unmount, rerender: view.rerender };
}

describe("RemoteVideoFeed binding", () => {
  it("1. visible mount attaches the rendered video with muted inline autoplay set first", async () => {
    const fake = new FakeRemoteVideoTrack("A", (el) => {
      // Properties must be configured BEFORE attach() is called.
      expect(el.muted).toBe(true);
      expect(el.autoplay).toBe(true);
      expect(el.playsInline).toBe(true);
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const { video, unmount } = renderFeed(
      <RemoteVideoFeed track={toSdk(fake)} source="camera" visible />,
    );

    expect(fake.attachCalls).toHaveLength(1);
    expect(fake.attachCalls[0]).toBe(video);
    expect(video.muted).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.dataset.callVideo).toBe("remote-camera");
    expect(play).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(video.dataset.callVideoPlay).toBe("playing"));
    unmount();
    expect(fake.detachCalls).toHaveLength(1);
    expect(fake.detachCalls[0]).toBe(video);
    expect(fake.stopCalls).toBe(0);
  });

  it("2. an unrelated rerender with the same track does not rebuild attachment", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const fake = new FakeRemoteVideoTrack("A");
    const { video, rerender, unmount } = renderFeed(
      <RemoteVideoFeed track={toSdk(fake)} source="camera" visible className="h-full" />,
    );
    expect(fake.attachCalls).toHaveLength(1);
    await waitFor(() => expect(video.dataset.callVideoPlay).toBe("playing"));

    // Unrelated rerender (className/style) — same track, same visibility.
    rerender(<RemoteVideoFeed track={toSdk(fake)} source="camera" visible className="w-full" />);
    rerender(<RemoteVideoFeed track={toSdk(fake)} source="camera" visible />);

    expect(fake.attachCalls).toHaveLength(1);
    expect(fake.detachCalls).toHaveLength(0);
    unmount();
  });

  it("3. replacement detaches A from its element, then attaches B and B stays usable", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const fakeA = new FakeRemoteVideoTrack("A");
    const fakeB = new FakeRemoteVideoTrack("B");
    const { video, rerender, unmount } = renderFeed(
      <RemoteVideoFeed track={toSdk(fakeA)} source="camera" visible />,
    );
    expect(fakeA.attachCalls).toHaveLength(1);

    rerender(<RemoteVideoFeed track={toSdk(fakeB)} source="camera" visible />);

    expect(fakeA.detachCalls).toHaveLength(1);
    expect(fakeA.detachCalls[0]).toBe(video);
    expect(fakeB.attachCalls).toHaveLength(1);
    expect(fakeB.attachCalls[0]).toBe(video);
    // A late A-frame must not touch B: fire nothing, B remains attached.
    expect(fakeB.attachedElements).toEqual([video]);
    await waitFor(() => expect(video.dataset.callVideoPlay).toBe("playing"));
    unmount();
    expect(fakeB.detachCalls).toHaveLength(1);
  });

  it("4. hiding detaches without stopping capture; restoring reattaches", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const fake = new FakeRemoteVideoTrack("A");
    const { video, rerender, unmount } = renderFeed(
      <RemoteVideoFeed track={toSdk(fake)} source="camera" visible />,
    );
    expect(fake.attachCalls).toHaveLength(1);

    // Hidden: same component stays mounted, but no remote element remains.
    rerender(<RemoteVideoFeed track={toSdk(fake)} source="camera" visible={false} />);
    expect(fake.detachCalls).toHaveLength(1);
    expect(fake.detachCalls[0]).toBe(video);
    expect(fake.attachedElements).toEqual([]);
    expect(fake.stopCalls).toBe(0);

    // Restored: attach the SAME track to the SAME rendered element again.
    rerender(<RemoteVideoFeed track={toSdk(fake)} source="camera" visible />);
    expect(fake.attachCalls).toHaveLength(2);
    expect(fake.attachCalls[1]).toBe(video);
    await waitFor(() => expect(video.dataset.callVideoPlay).toBe("playing"));
    unmount();
  });

  it("5. two elements sharing one track stay independent when one unmounts", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const fake = new FakeRemoteVideoTrack("shared");
    const view = render(
      <div data-testid="pair">
        <RemoteVideoFeed track={toSdk(fake)} source="camera" visible className="one" />
        <RemoteVideoFeed track={toSdk(fake)} source="camera" visible className="two" />
      </div>,
    );
    const videos = view.container.querySelectorAll("video");
    expect(videos).toHaveLength(2);
    expect(fake.attachCalls).toHaveLength(2);
    expect(new Set(fake.attachCalls)).toEqual(new Set([...videos]));
    expect(fake.attachedElements).toHaveLength(2);

    // Unmount the first feed only.
    view.rerender(
      <div data-testid="pair">
        <RemoteVideoFeed track={toSdk(fake)} source="camera" visible className="two" />
      </div>,
    );
    const remaining = view.container.querySelectorAll("video");
    expect(remaining).toHaveLength(1);
    const removed = [...videos].find((v) => v !== remaining[0]);
    expect(fake.detachCalls).toEqual([removed]);
    expect(fake.attachedElements).toEqual([remaining[0]]);
    view.unmount();
    expect(fake.attachedElements).toEqual([]);
  });

  it("6. Strict Mode settles to one active registration and none after unmount", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const fake = new FakeRemoteVideoTrack("A");
    const view = render(
      <StrictMode>
        <RemoteVideoFeed track={toSdk(fake)} source="screen" visible />
      </StrictMode>,
    );
    await waitFor(() => expect(fake.attachCalls.length).toBeGreaterThanOrEqual(1));
    // After setup/cleanup/setup exactly one element registration remains.
    expect(fake.attachedElements).toHaveLength(1);
    const video = view.container.querySelector("video") as HTMLVideoElement;
    expect(video.dataset.callVideo).toBe("remote-screen");
    view.unmount();
    expect(fake.attachedElements).toHaveLength(0);
  });

  it("7a. a NotAllowedError play rejection shows the retry action which plays on click", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    play.mockRejectedValueOnce(new DOMException("autoplay blocked", "NotAllowedError"));
    const fake = new FakeRemoteVideoTrack("A");
    const view = render(<RemoteVideoFeed track={toSdk(fake)} source="camera" visible />);
    const video = view.container.querySelector("video") as HTMLVideoElement;

    const retry = await waitFor(() => {
      const btn = view.getByRole("button", { name: "پخش تصویر" });
      return btn;
    });
    expect(video.dataset.callVideoPlay).toBe("failed");
    expect(video.dataset.callVideoFrame).toBe("none");

    fireEvent.click(retry);
    await waitFor(() => expect(video.dataset.callVideoPlay).toBe("playing"));
    expect(view.queryByRole("button", { name: "پخش تصویر" })).toBeNull();
    expect(fake.stopCalls).toBe(0);
  });

  it("7b. an obsolete rejection from track A cannot poison replacement B", async () => {
    let rejectA: ((err: unknown) => void) | null = null;
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    play.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    const fakeA = new FakeRemoteVideoTrack("A");
    const fakeB = new FakeRemoteVideoTrack("B");
    const view = render(<RemoteVideoFeed track={toSdk(fakeA)} source="camera" visible />);
    const video = view.container.querySelector("video") as HTMLVideoElement;
    await waitFor(() => expect(rejectA).toBeTruthy());
    // A is replaced by B before A's play ever settles.
    view.rerender(<RemoteVideoFeed track={toSdk(fakeB)} source="camera" visible />);
    await waitFor(() => expect(video.dataset.callVideoPlay).toBe("playing"));

    await act(async () => {
      rejectA?.(new DOMException("too late", "NotAllowedError"));
    });
    // B's playback state must remain untouched.
    expect(video.dataset.callVideoPlay).toBe("playing");
    expect(view.queryByRole("button", { name: "پخش تصویر" })).toBeNull();
    view.unmount();
  });

  it("8. a partial attach failure cleans up and never throws through the call UI", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const fake = new FakeRemoteVideoTrack("A", () => {
      throw new Error("boom");
    });
    const view = render(<RemoteVideoFeed track={toSdk(fake)} source="camera" visible />);
    const video = view.container.querySelector("video") as HTMLVideoElement;
    await waitFor(() => expect(video.dataset.callVideoPlay).toBe("failed"));
    // Failed binding leaves no registration behind even though dispose runs.
    expect(fake.attachedElements).toEqual([]);
    view.unmount();
    expect(fake.detachCalls.length).toBeLessThanOrEqual(1);
    expect(fake.stopCalls).toBe(0);
  });

  it("9. stats sampling is bounded, at most one request, and stops on unmount", async () => {
    vi.stubEnv("VITE_CALL_VIDEO_DEBUG", "1");
    vi.useFakeTimers();
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.resetModules();
    const { RemoteVideoFeed: RVF } = await import("./RemoteVideoFeed");

    const fake = new FakeRemoteVideoTrack("A");
    const pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
    fake.statsImpl = () =>
      new Promise<unknown>((resolve, reject) => {
        pending.push({ resolve: () => resolve(undefined), reject });
      });

    const entries = stubFrameCallbacks();
    const view = render(<RVF track={toSdk(fake)} source="camera" visible />);
    const video = view.container.querySelector("video") as HTMLVideoElement;
    // First (immediate) sample issued while previous is still pending.
    expect(fake.statsCalls).toBe(1);

    // While a sample is in flight, interval ticks must not overlap.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(fake.statsCalls).toBe(1);

    // Complete it → the next tick may sample again.
    await act(async () => {
      pending[0]?.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(fake.statsCalls).toBe(2);

    // Disposal: a late frame callback and a late stats result change nothing.
    view.unmount();
    const debugCallsBefore = debugSpy.mock.calls.length;
    await act(async () => {
      entries.forEach((e) => e.cb());
    });
    await act(async () => {
      pending[1]?.reject(new Error("late"));
      pending[1]?.resolve();
    });
    const callsBefore = fake.statsCalls;
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(fake.statsCalls).toBe(callsBefore); // interval cleared on unmount
    // No new diagnostics after disposal — the late result was ignored.
    expect(debugSpy.mock.calls.length).toBe(debugCallsBefore);
    expect(video.dataset.callVideoFrame).toBe("none");
  });

  it("10. an attached track without an observed frame stays distinguishable from playback", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const entries = stubFrameCallbacks();
    const fake = new FakeRemoteVideoTrack("A");
    const view = render(<RemoteVideoFeed track={toSdk(fake)} source="camera" visible />);
    const video = view.container.querySelector("video") as HTMLVideoElement;
    await waitFor(() => expect(video.dataset.callVideoPlay).toBe("playing"));
    // Playing but no presented frame yet — the element must still be laid out.
    expect(video.dataset.callVideoFrame).toBe("none");
    expect(fake.attachCalls[0]).toBe(video);

    await act(async () => {
      entries[0]?.cb();
    });
    await waitFor(() => expect(video.dataset.callVideoFrame).toBe("rvfc"));
    expect(video.dataset.callVideoPlay).toBe("playing");
    view.unmount();
  });
});
