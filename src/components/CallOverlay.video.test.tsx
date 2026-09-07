import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteVideoTrack } from "livekit-client";
import { CallOverlay } from "./CallOverlay";
import type { CallPeer, CallSession, GarmaCallkit, RemotePeer } from "../lib/useCallkit";
import type { Id } from "../convex/_generated/dataModel";

/**
 * Controlled SDK-track double recording element registrations (same contract
 * as RemoteVideoFeed's own tests). Overlay assertions run on real DOM nodes.
 */
class FakeRemoteVideoTrack {
  readonly label: string;
  attachCalls: HTMLVideoElement[] = [];
  detachCalls: HTMLVideoElement[] = [];
  private registry = new Set<HTMLVideoElement>();

  constructor(label: string) {
    this.label = label;
  }

  get attachedElements(): HTMLVideoElement[] {
    return [...this.registry];
  }

  attach(element: HTMLVideoElement): HTMLVideoElement {
    this.attachCalls.push(element);
    this.registry.add(element);
    return element;
  }

  detach(element: HTMLVideoElement): HTMLVideoElement {
    this.detachCalls.push(element);
    this.registry.delete(element);
    return element;
  }

  getReceiverStats(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
}

/** Owned local browser stream (what LocalVideoFeed assigns to srcObject). */
class FakeLocalStream {
  readonly label: string;
  constructor(label: string) {
    this.label = label;
  }
}

const toSdk = (fake: FakeRemoteVideoTrack): RemoteVideoTrack =>
  fake as unknown as RemoteVideoTrack;
const toStream = (fake: FakeLocalStream): MediaStream =>
  fake as unknown as MediaStream;

const userId = (n: string) => n as Id<"users">;
const callId = (n: string) => n as Id<"calls">;

function peerRow(userIdStr: string, displayName: string, joined = true): CallPeer {
  return { userId: userId(userIdStr), displayName, themeColor: "#8a6340", joined };
}

function activeVideoSession(peers: CallPeer[]): CallSession {
  return {
    callId: callId("call-1"),
    phase: "active",
    kind: "video",
    initiatedByMe: true,
    joinOffer: false,
    callerId: userId("u1"),
    callerName: "من",
    callerColor: "#2f9e6e",
    peers,
  };
}

function remotePeer(overrides: Partial<RemotePeer>): RemotePeer {
  return {
    userId: "u2",
    displayName: "سارا",
    themeColor: "#8a6340",
    mic: null,
    cam: null,
    screen: null,
    micOn: true,
    camOn: false,
    screenOn: false,
    poor: false,
    ...overrides,
  };
}

function makeKit(overrides: Partial<GarmaCallkit> = {}): GarmaCallkit {
  const hangup = vi.fn(async () => {});
  const toggleShare = vi.fn(async () => {});
  const noop = async () => {};
  return {
    session: null,
    startCall: noop,
    accept: noop,
    decline: noop,
    hangup,
    toggleMic: noop,
    toggleCam: noop,
    switchCamera: noop,
    toggleShare,
    toggleSpeaker: () => {},
    micOn: true,
    camOn: true,
    speakerOn: true,
    sharing: false,
    shareStarting: false,
    shareError: null,
    clearShareError: () => {},
    camError: null,
    clearCamError: () => {},
    micError: null,
    clearMicError: () => {},
    canSwitchCamera: false,
    camFacing: "user",
    local: null,
    screenLocal: null,
    remotes: [],
    error: null,
    busy: false,
    reconnecting: false,
    camQuality: null,
    cycleQuality: () => {},
    ...overrides,
  };
}

function renderOverlay(kit: GarmaCallkit, hidden = false) {
  const onMinimize = vi.fn();
  const view = render(<CallOverlay kit={kit} onMinimize={onMinimize} hidden={hidden} />);
  return { view, onMinimize };
}

function overrideProtoMethod(name: string, impl: (...args: unknown[]) => unknown) {
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  try {
    Object.defineProperty(proto, name, { configurable: true, writable: true, value: impl });
  } catch {
    // jsdom's native stub stays; per-test behavior comes from vi.spyOn.
  }
}

function mediaMethodStubs() {
  overrideProtoMethod("play", function play(this: HTMLMediaElement) {
    return Promise.resolve();
  });
  overrideProtoMethod("pause", function pause() {});
  // LocalVideoFeed assigns owned streams; give srcObject a plain storage slot.
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject");
  if (!desc || desc.configurable === true) {
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get(this: HTMLMediaElement) {
        return (this as unknown as { __src?: unknown }).__src ?? null;
      },
      set(this: HTMLMediaElement, v: unknown) {
        (this as unknown as { __src?: unknown }).__src = v ?? null;
      },
    });
  }
}

beforeEach(() => {
  mediaMethodStubs();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const remoteVideos = (root: HTMLElement) =>
  [...root.querySelectorAll("video[data-call-video]")] as HTMLVideoElement[];
const localVideos = (root: HTMLElement) =>
  [...root.querySelectorAll("video:not([data-call-video])")] as HTMLVideoElement[];

describe("CallOverlay video layouts (production component)", () => {
  it("spotlight camera: SDK attach on the remote element, local corner stays a mirrored browser-stream preview", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const cam = new FakeRemoteVideoTrack("cam");
    const local = new FakeLocalStream("local-cam");
    const kit = makeKit({
      session: activeVideoSession([peerRow("u2", "سارا")]),
      remotes: [remotePeer({ cam: toSdk(cam), camOn: true })],
      local: toStream(local),
      camOn: true,
      camFacing: "user",
    });
    const { view } = renderOverlay(kit);

    const feed = await waitFor(() => {
      const el = view.container.querySelector('video[data-call-video="remote-camera"]');
      if (!el) throw new Error("no remote camera feed");
      return el as HTMLVideoElement;
    });
    // The SDK track is attached to the exact rendered video element.
    expect(cam.attachCalls).toEqual([feed]);
    expect(feed.className).toContain("object-cover");

    // The local self-preview is a browser-stream video (no data-call-video),
    // mirrored for a front camera.
    const locals = localVideos(view.container);
    expect(locals).toHaveLength(1);
    const localEl = locals[0];
    expect(localEl.className).toContain("object-cover");
    expect(localEl.style.transform).toBe("scaleX(-1)");
    expect((localEl as unknown as { __src?: unknown }).__src).toBe(toStream(local));
    expect(localEl.dataset.callVideo).toBeUndefined();

    expect(remoteVideos(view.container)).toHaveLength(1);
    await waitFor(() => expect(feed.dataset.callVideoPlay).toBe("playing"));
    view.unmount();
    expect(cam.detachCalls).toEqual([feed]);
  });

  it("spotlight: screen share outranks camera and camera resumes after share removal", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const cam = new FakeRemoteVideoTrack("cam");
    const screen = new FakeRemoteVideoTrack("screen");
    const kit = makeKit({
      session: activeVideoSession([peerRow("u2", "سارا")]),
      remotes: [remotePeer({ cam: toSdk(cam), camOn: true, screen: toSdk(screen), screenOn: true })],
    });
    const { view } = renderOverlay(kit);

    const screenFeed = await waitFor(() => {
      const el = view.container.querySelector('video[data-call-video="remote-screen"]');
      if (!el) throw new Error("no remote screen feed");
      return el as HTMLVideoElement;
    });
    expect(screen.attachCalls).toEqual([screenFeed]);
    expect(screenFeed.className).toContain("object-contain");
    // Camera exists but must NOT be attached while screen is shown.
    expect(cam.attachCalls).toHaveLength(0);
    // The remote share badge names the sharer.
    expect(view.container.textContent).toContain("اشتراک صفحهٔ سارا");

    // Sharer stops sharing → camera feed replaces it, old element detached.
    const kit2 = makeKit({
      session: activeVideoSession([peerRow("u2", "سارا")]),
      remotes: [remotePeer({ cam: toSdk(cam), camOn: true })],
    });
    view.rerender(<CallOverlay kit={kit2} onMinimize={vi.fn()} />);
    const camFeed = await waitFor(() => {
      const el = view.container.querySelector('video[data-call-video="remote-camera"]');
      if (!el) throw new Error("camera did not resume");
      return el as HTMLVideoElement;
    });
    expect(view.container.querySelector('video[data-call-video="remote-screen"]')).toBeNull();
    expect(screen.detachCalls).toEqual([screenFeed]); // stale share content removed
    expect(cam.attachCalls).toEqual([camFeed]);
    expect(cam.attachedElements).toEqual([camFeed]);
    view.unmount();
  });

  it("three-person grid: every joined peer gets a tile; avatar-only peer has no remote video", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const camU2 = new FakeRemoteVideoTrack("u2-cam");
    const camU4 = new FakeRemoteVideoTrack("u4-cam");
    const local = new FakeLocalStream("local-cam");
    const kit = makeKit({
      session: activeVideoSession([
        peerRow("u2", "سارا"),
        peerRow("u3", "مریم"),
        peerRow("u4", "نگار"),
      ]),
      remotes: [
        remotePeer({ userId: "u2", displayName: "سارا", cam: toSdk(camU2), camOn: true }),
        remotePeer({ userId: "u4", displayName: "نگار", cam: toSdk(camU4), camOn: true }),
      ],
      local: toStream(local),
      camOn: true,
      camFacing: "environment", // back camera → no mirror
    });
    const { view } = renderOverlay(kit);

    const feeds = await waitFor(() => {
      const els = remoteVideos(view.container);
      if (els.length !== 2) throw new Error(`expected 2 remote feeds, got ${els.length}`);
      return els;
    });
    expect(feeds.every((el) => el.dataset.callVideo === "remote-camera")).toBe(true);
    // Screen absent → GridTile picks camera for u2 and u4.
    expect(camU2.attachCalls).toEqual([feeds[0]]);
    expect(camU4.attachCalls).toEqual([feeds[1]]);
    // Avatar-only participant (مریم): tile exists with an avatar, no video.
    expect(view.container.textContent).toContain("مریم");
    // My own camera tile: browser stream, not mirrored for the back camera.
    const myTileVideo = view.container.querySelector("video:not([data-call-video])") as HTMLVideoElement;
    expect(myTileVideo).toBeTruthy();
    expect(myTileVideo.className).toContain("object-cover");
    expect(myTileVideo.style.transform).toBe("none");
    expect((myTileVideo as unknown as { __src?: unknown }).__src).toBe(toStream(local));
    view.unmount();
  });

  it("grid screen tile keeps object-contain; switching hidden on/off detaches and reattaches remotes only", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const camU2 = new FakeRemoteVideoTrack("u2-cam");
    const localScreen = new FakeLocalStream("my-screen");
    const kit = makeKit({
      session: activeVideoSession([peerRow("u2", "سارا"), peerRow("u3", "مریم")]),
      remotes: [remotePeer({ userId: "u2", displayName: "سارا", cam: toSdk(camU2), camOn: true })],
      sharing: true,
      screenLocal: toStream(localScreen),
    });
    const { view } = renderOverlay(kit);

    // My shared-screen grid tile is a browser-stream preview with contain.
    const myTile = await waitFor(() => {
      const el = view.container.querySelector("video:not([data-call-video])");
      if (!el) throw new Error("no local screen tile");
      return el as HTMLVideoElement;
    });
    expect(myTile.className).toContain("object-contain");
    expect(myTile.dataset.callVideo).toBeUndefined();

    const remoteBefore = remoteVideos(view.container);
    const remote = remoteBefore[0];
    expect(camU2.attachCalls).toEqual([remote]);

    // Minimize (overlay hidden, component stays mounted).
    view.rerender(<CallOverlay kit={kit} onMinimize={vi.fn()} hidden />);
    expect(camU2.detachCalls).toEqual([remote]);
    expect(camU2.attachedElements).toEqual([]);
    // Local preview stays mounted and untouched by minimize.
    expect(myTile.isConnected).toBe(true);
    expect((myTile as unknown as { __src?: unknown }).__src).toBe(toStream(localScreen));

    // Restore: same element re-registers for the same SDK track.
    view.rerender(<CallOverlay kit={kit} onMinimize={vi.fn()} />);
    expect(camU2.attachCalls).toHaveLength(2);
    expect(camU2.attachCalls[1]).toBe(remote);
    await waitFor(() => expect(remote.dataset.callVideoPlay).toBe("playing"));
    view.unmount();
    expect(camU2.attachedElements).toEqual([]);
  });

  it("layout switches (spotlight → grid → spotlight) and minimize leave exactly one live registration", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const camU2 = new FakeRemoteVideoTrack("u2-cam");
    const camU3 = new FakeRemoteVideoTrack("u3-cam");
    const hangup = vi.fn(async () => {});
    const toggleShare = vi.fn(async () => {});
    const kitA = makeKit({
      hangup,
      toggleShare,
      session: activeVideoSession([peerRow("u2", "سارا")]),
      remotes: [remotePeer({ userId: "u2", displayName: "سارا", cam: toSdk(camU2), camOn: true })],
      local: toStream(new FakeLocalStream("local")),
      camOn: true,
    });
    const { view } = renderOverlay(kitA);

    const first = await waitFor(() => {
      const el = view.container.querySelector('video[data-call-video="remote-camera"]');
      if (!el) throw new Error("spotlight camera expected");
      return el as HTMLVideoElement;
    });
    expect(camU2.attachCalls).toEqual([first]);

    // Minimize and restore (spotlight).
    view.rerender(<CallOverlay kit={kitA} onMinimize={vi.fn()} hidden />);
    view.rerender(<CallOverlay kit={kitA} onMinimize={vi.fn()} />);
    expect(camU2.detachCalls).toEqual([first]);
    expect(camU2.attachCalls).toHaveLength(2);

    // Grow to a two-remote grid.
    const kitB = makeKit({
      hangup,
      toggleShare,
      session: activeVideoSession([peerRow("u2", "سارا"), peerRow("u3", "مریم")]),
      remotes: [
        remotePeer({ userId: "u2", displayName: "سارا", cam: toSdk(camU2), camOn: true }),
        remotePeer({ userId: "u3", displayName: "مریم", cam: toSdk(camU3), camOn: true }),
      ],
      local: toStream(new FakeLocalStream("local")),
      camOn: true,
    });
    view.rerender(<CallOverlay kit={kitB} onMinimize={vi.fn()} />);
    await waitFor(() => expect(remoteVideos(view.container)).toHaveLength(2));
    expect(camU2.attachedElements).toHaveLength(1); // spotlight element released
    expect(camU3.attachedElements).toHaveLength(1);

    // One remote leaves: back to spotlight with u2.
    const kitC = makeKit({
      hangup,
      toggleShare,
      session: activeVideoSession([peerRow("u2", "سارا")]),
      remotes: [remotePeer({ userId: "u2", displayName: "سارا", cam: toSdk(camU2), camOn: true })],
      local: toStream(new FakeLocalStream("local")),
      camOn: true,
    });
    view.rerender(<CallOverlay kit={kitC} onMinimize={vi.fn()} />);
    await waitFor(() => expect(remoteVideos(view.container)).toHaveLength(1));
    expect(camU3.attachedElements).toEqual([]);
    expect(camU2.attachedElements).toHaveLength(1);

    // No call-control side effects, no audio elements created by the overlay.
    expect(hangup).not.toHaveBeenCalled();
    expect(toggleShare).not.toHaveBeenCalled();
    expect(view.container.querySelectorAll("audio")).toHaveLength(0);
    view.unmount();
    expect(camU2.attachedElements).toEqual([]);
    expect(camU3.attachedElements).toEqual([]);
  });
});
