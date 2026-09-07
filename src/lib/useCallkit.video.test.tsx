import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCallkit } from "./useCallkit";

/**
 * Everything the mocked module graph needs lives in one hoisted block so the
 * vi.mock factories can reference it (factories run before module bodies).
 */
const h = vi.hoisted(() => {
  /** Browser-track double with an observable `ended` listener registry. */
  class FakeMediaStreamTrack {
    kind: "video" | "audio" = "video";
    readyState: "live" | "ended" = "live";
    private endedListeners = new Set<() => void>();
    addEventListener(type: string, cb: () => void) {
      if (type === "ended") this.endedListeners.add(cb);
    }
    removeEventListener(type: string, cb: () => void) {
      if (type === "ended") this.endedListeners.delete(cb);
    }
    endedListenerCount() {
      return this.endedListeners.size;
    }
    end() {
      if (this.readyState === "ended") return;
      this.readyState = "ended";
      for (const cb of [...this.endedListeners]) cb();
    }
  }

  class FakeRemoteVideoTrack {
    readonly mediaStreamTrack: FakeMediaStreamTrack;
    readonly sid: string;
    stopped = false;
    readonly attached = new Set<HTMLMediaElement>();
    constructor(mediaStreamTrack: FakeMediaStreamTrack, sid: string) {
      this.mediaStreamTrack = mediaStreamTrack;
      this.sid = sid;
    }
    attach(element?: HTMLMediaElement) {
      const el = element ?? document.createElement("video");
      this.attached.add(el);
      return el;
    }
    detach(element?: HTMLMediaElement) {
      if (element) {
        this.attached.delete(element);
        return element;
      }
      const all = [...this.attached];
      this.attached.clear();
      return all;
    }
    stop() {
      this.stopped = true;
    }
    getReceiverStats(): Promise<unknown> {
      return Promise.resolve(undefined);
    }
  }

  /** Remote audio double used by the microphone branch (SDK attachment). */
  class FakeRemoteAudioTrack {
    readonly mediaStreamTrack: FakeMediaStreamTrack;
    readonly sid: string;
    readonly attached = new Set<HTMLAudioElement>();
    constructor(mediaStreamTrack: FakeMediaStreamTrack, sid: string) {
      this.mediaStreamTrack = mediaStreamTrack;
      this.sid = sid;
    }
    attach(element?: HTMLMediaElement) {
      const el = element ?? document.createElement("audio");
      this.attached.add(el as HTMLAudioElement);
      return el;
    }
    detach(element?: HTMLMediaElement) {
      if (element) {
        this.attached.delete(element as HTMLAudioElement);
        return element;
      }
      const all = [...this.attached];
      this.attached.clear();
      return all;
    }
  }

  class FakeLocalParticipant {
    readonly publications: Array<Record<string, unknown>> = [
      {
        source: "microphone",
        trackSid: "TR_LOCAL_MIC",
        isMuted: false,
        track: { mediaStreamTrack: { readyState: "live" } },
      },
    ];
    connectionQuality = "excellent";
    getTrackPublication(source: string) {
      return this.publications.find((p) => p.source === source) ?? null;
    }
    getTrackPublications() {
      return this.publications;
    }
    async setCameraEnabled() {}
    async setMicrophoneEnabled() {}
    async unpublishTrack() {}
    async setScreenShareEnabled() {
      return null;
    }
  }

  /** Fake Room: keeps the handlers production connectMedia registers, exposes
   *  a controlled emitter, and implements only the SDK surface the hook uses. */
  class FakeRoom {
    static instances: FakeRoom[] = [];
    readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    state = "disconnected";
    readonly localParticipant = new FakeLocalParticipant();
    constructor(_options?: Record<string, unknown>) {
      FakeRoom.instances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(cb);
      this.handlers.set(event, list);
    }
    emit(event: string, ...args: unknown[]) {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
    async connect() {
      this.state = "connected";
    }
    async startAudio() {}
    disconnect() {
      this.state = "disconnected";
    }
  }

  /** Stub MediaStream so `new MediaStream([...])` works in JSDOM. */
  class MediaStreamStub {
    readonly tracks: FakeMediaStreamTrack[];
    constructor(tracks: FakeMediaStreamTrack[] = []) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
  }

  const Track = {
    Source: {
      Camera: "camera",
      Microphone: "microphone",
      ScreenShare: "screen_share",
      ScreenShareAudio: "screen_share_audio",
    },
  } as const;
  const RoomEvent = {
    LocalTrackPublished: "localTrackPublished",
    LocalTrackUnpublished: "localTrackUnpublished",
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    TrackUnpublished: "trackUnpublished",
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
    TrackMuted: "trackMuted",
    TrackUnmuted: "trackUnmuted",
    ConnectionQualityChanged: "connectionQualityChanged",
    Reconnecting: "reconnecting",
    Reconnected: "reconnected",
    Disconnected: "disconnected",
  } as const;
  const ConnectionState = {
    Connecting: "connecting",
    Connected: "connected",
    Reconnecting: "reconnecting",
    Disconnected: "disconnected",
  } as const;
  const ConnectionQuality = {
    Excellent: "excellent",
    Good: "good",
    Poor: "poor",
    Lost: "lost",
  } as const;

  const lk = {
    Room: FakeRoom,
    RemoteVideoTrack: FakeRemoteVideoTrack,
    RemoteAudioTrack: FakeRemoteAudioTrack,
    RoomEvent,
    Track,
    ConnectionState,
    ConnectionQuality,
  } as const;

  const activeCallRow = {
    callId: "call-1",
    conversationId: "conv-1",
    kind: "video",
    status: "active",
    initiatorId: "u1",
    startedAt: Date.now() - 2_000,
    initiatedByMe: true,
    acceptedByMe: true,
    caller: { userId: "u1", displayName: "من", themeColor: "#2f9e6e" },
    peers: [{ userId: "u2", displayName: "سارا", themeColor: "#8a6340", joined: true }],
  };

  const softQueryResult = { data: [activeCallRow], unavailable: false };
  const convexAction = vi.fn(async () => ({ url: "wss://fake.livekit", token: "jwt-fake" }));
  const convexMutation = vi.fn(async () => ({}));

  return {
    FakeRoom,
    FakeRemoteVideoTrack,
    FakeRemoteAudioTrack,
    FakeMediaStreamTrack,
    MediaStreamStub,
    Track,
    RoomEvent,
    ConnectionState,
    lk,
    softQueryResult,
    convexAction,
    convexMutation,
  };
});

vi.mock("convex/react", () => ({
  useAction: () => h.convexAction,
  useMutation: () => h.convexMutation,
}));

vi.mock("./softQuery", () => ({
  useSoftQuery: () => h.softQueryResult,
}));

vi.mock("../convex/_generated/api", () => ({
  api: {
    calls: { myCalls: {}, start: {}, end: {}, answer: {} },
    livekit: { getToken: {} },
    push: { notifyIncomingCall: {} },
  },
  internal: {},
  components: {},
}));

vi.mock("./livekitLoader", () => ({
  loadLiveKit: async () => h.lk,
  livekit: () => h.lk,
}));

type RemotePublication = {
  source: string;
  trackSid: string;
  isMuted: boolean;
  track?: unknown;
};

const pub = (source: string, sid: string, isMuted = false, track?: unknown): RemotePublication => ({
  source,
  trackSid: sid,
  isMuted,
  ...(track === undefined ? {} : { track }),
});

const participantOf = (identity = "u2") => ({ identity });

/** A live video browser track (packets need not have arrived: muted ok). */
function liveVideoTrack(kind: "video" | "audio" = "video") {
  const mst = new h.FakeMediaStreamTrack();
  mst.kind = kind;
  return mst;
}

type CallCtx = {
  result: ReturnType<typeof renderHook<ReturnType<typeof useCallkit>, never>>["result"];
  room: InstanceType<typeof h.FakeRoom>;
  unmount: () => void;
};

async function mountConnected(): Promise<CallCtx> {
  const { result, unmount } = renderHook(() => useCallkit("test-token"));
  let room: InstanceType<typeof h.FakeRoom> | undefined;
  await waitFor(() => {
    room = h.FakeRoom.instances[0];
    expect(room).toBeDefined();
  });
  // Handlers are registered synchronously with instance creation; wait for
  // the connect to settle so lifecycle assertions are deterministic.
  await waitFor(() => expect(result.current.reconnecting).toBe(false));
  return { result, room: room as InstanceType<typeof h.FakeRoom>, unmount };
}

async function endCall(ctx: CallCtx) {
  if (ctx.result.current.session) {
    await act(async () => {
      await ctx.result.current.hangup();
    });
  }
  ctx.unmount();
}

function subscribe(
  room: InstanceType<typeof h.FakeRoom>,
  event: string,
  ...args: unknown[]
) {
  act(() => room.emit(event, ...args));
}

const expectCam = async (ctx: CallCtx, expected: unknown, userId = "u2") => {
  await waitFor(() => {
    const r = ctx.result.current.remotes.find((x) => x.userId === userId);
    expect(r?.cam).toBe(expected);
  });
};

function overrideMediaMethod(name: string, impl: (...args: unknown[]) => unknown) {
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  try {
    Object.defineProperty(proto, name, { configurable: true, writable: true, value: impl });
  } catch {
    // jsdom's native stub stays; no test depends on its exact behavior here.
  }
}

beforeEach(() => {
  h.FakeRoom.instances.length = 0;
  vi.stubGlobal("MediaStream", h.MediaStreamStub);
  // Mic elements are created and paused by the real hook; silence JSDOM.
  overrideMediaMethod("play", function play() {
    return Promise.resolve();
  });
  overrideMediaMethod("pause", function pause() {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("useCallkit remote video events (real hook, mocked SDK boundary)", () => {
  it("exposes the exact subscribed SDK objects for camera and screen (regression: baseline built a new MediaStream)", async () => {
    const ctx = await mountConnected();
    try {
      const camTrack = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_1");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, camTrack, pub("camera", "TR_CAM_1", false, camTrack), participantOf());
      await waitFor(() => {
        expect(ctx.result.current.remotes[0]?.cam).toBe(camTrack);
      });
      expect(ctx.result.current.remotes[0]?.camOn).toBe(true);

      const screenTrack = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_SCR_1");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, screenTrack, pub("screen_share", "TR_SCR_1", false, screenTrack), participantOf());
      await waitFor(() => {
        expect(ctx.result.current.remotes[0]?.screen).toBe(screenTrack);
      });
      // Original SDK object identity, never a spread/clone/proxy.
      expect(ctx.result.current.remotes[0]?.cam).toBe(camTrack);
      expect(ctx.result.current.remotes[0]?.screen).toBe(screenTrack);
      expect(ctx.result.current.remotes[0]?.screenOn).toBe(true);
      expect(camTrack.stopped).toBe(false);
    } finally {
      await endCall(ctx);
    }
  });

  it("a muted-but-live camera track is still exposed for attachment while camOn reads false", async () => {
    const ctx = await mountConnected();
    try {
      const camTrack = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_1");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, camTrack, pub("camera", "TR_CAM_1", true, camTrack), participantOf());
      await waitFor(() => {
        const r = ctx.result.current.remotes[0];
        expect(r?.cam).toBe(camTrack);
        expect(r?.camOn).toBe(false);
      });
    } finally {
      await endCall(ctx);
    }
  });

  it("camera unsubscribe clears only the camera: screen, its listener and the mic stay", async () => {
    const ctx = await mountConnected();
    try {
      const camA = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_A");
      const screenS = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_SCR_S");
      const micTrack = new h.FakeRemoteAudioTrack(liveVideoTrack("audio"), "TR_MIC_M");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, micTrack, pub("microphone", "TR_MIC_M", false, micTrack), participantOf());
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, camA, pub("camera", "TR_CAM_A", false, camA), participantOf());
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, screenS, pub("screen_share", "TR_SCR_S", false, screenS), participantOf());
      await waitFor(() => {
        const r = ctx.result.current.remotes[0];
        expect(r?.cam).toBe(camA);
        expect(r?.screen).toBe(screenS);
        expect(r?.mic).toBeInstanceOf(h.MediaStreamStub);
      });
      const micBefore = ctx.result.current.remotes[0]?.mic;
      expect(camA.mediaStreamTrack.endedListenerCount()).toBe(1);
      expect(screenS.mediaStreamTrack.endedListenerCount()).toBe(1);

      subscribe(ctx.room, h.RoomEvent.TrackUnsubscribed, camA, pub("camera", "TR_CAM_A", false, camA), participantOf());
      await waitFor(() => {
        const r = ctx.result.current.remotes[0];
        expect(r?.cam).toBeNull();
        expect(r?.screen).toBe(screenS);
        expect(r?.screenOn).toBe(true);
        expect(r?.mic).toBe(micBefore);
        expect(r?.micOn).toBe(true);
      });
      // A's ended listener is gone; S's is still armed.
      expect(camA.mediaStreamTrack.endedListenerCount()).toBe(0);
      expect(screenS.mediaStreamTrack.endedListenerCount()).toBe(1);
    } finally {
      await endCall(ctx);
    }
  });

  it("screen unsubscribe leaves camera A available for the screen-first renderer", async () => {
    const ctx = await mountConnected();
    try {
      const camA = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_A");
      const screenS = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_SCR_S");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, camA, pub("camera", "TR_CAM_A", false, camA), participantOf());
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, screenS, pub("screen_share", "TR_SCR_S", false, screenS), participantOf());
      await waitFor(() => expect(ctx.result.current.remotes[0]?.screen).toBe(screenS));

      subscribe(ctx.room, h.RoomEvent.TrackUnsubscribed, screenS, pub("screen_share", "TR_SCR_S", false, screenS), participantOf());
      await waitFor(() => {
        const r = ctx.result.current.remotes[0];
        expect(r?.screen).toBeNull();
        expect(r?.screenOn).toBe(false);
        expect(r?.cam).toBe(camA); // camera is not a substitute slot for screen
        expect(r?.camOn).toBe(true);
      });
      expect(camA.mediaStreamTrack.endedListenerCount()).toBe(1);
    } finally {
      await endCall(ctx);
    }
  });

  it("mute/unmute flips only the on flag; the slot and its SDK track survive", async () => {
    const ctx = await mountConnected();
    try {
      const camA = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_A");
      const screenS = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_SCR_S");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, camA, pub("camera", "TR_CAM_A", false, camA), participantOf());
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, screenS, pub("screen_share", "TR_SCR_S", false, screenS), participantOf());
      await waitFor(() => {
        expect(ctx.result.current.remotes[0]?.cam).toBe(camA);
        expect(ctx.result.current.remotes[0]?.screen).toBe(screenS);
      });

      subscribe(ctx.room, h.RoomEvent.TrackMuted, pub("camera", "TR_CAM_A"), participantOf());
      subscribe(ctx.room, h.RoomEvent.TrackMuted, pub("screen_share", "TR_SCR_S"), participantOf());
      await waitFor(() => {
        const r = ctx.result.current.remotes[0];
        expect(r?.cam).toBe(camA);
        expect(r?.camOn).toBe(false);
        expect(r?.screen).toBe(screenS);
        expect(r?.screenOn).toBe(false);
      });
      // Listeners stay while muted: an unmute must display the same track.
      expect(camA.mediaStreamTrack.endedListenerCount()).toBe(1);

      subscribe(ctx.room, h.RoomEvent.TrackUnmuted, pub("camera", "TR_CAM_A"), participantOf());
      subscribe(ctx.room, h.RoomEvent.TrackUnmuted, pub("screen_share", "TR_SCR_S"), participantOf());
      await waitFor(() => {
        const r = ctx.result.current.remotes[0];
        expect(r?.camOn).toBe(true);
        expect(r?.cam).toBe(camA);
        expect(r?.screenOn).toBe(true);
        expect(r?.screen).toBe(screenS);
      });
      // A mute event for an unknown SID must not touch this source.
      subscribe(ctx.room, h.RoomEvent.TrackMuted, pub("camera", "TR_CAM_OTHER"), participantOf());
      expect(ctx.result.current.remotes[0]?.camOn).toBe(true);
    } finally {
      await endCall(ctx);
    }
  });

  it("matching unpublish (even with publication.track absent) clears only that source", async () => {
    const ctx = await mountConnected();
    try {
      const camA = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_A");
      const screenS = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_SCR_S");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, camA, pub("camera", "TR_CAM_A", false, camA), participantOf());
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, screenS, pub("screen_share", "TR_SCR_S", false, screenS), participantOf());
      await waitFor(() => expect(ctx.result.current.remotes[0]?.screen).toBe(screenS));

      // Obsolete different-publication event cannot clear a newer one.
      subscribe(ctx.room, h.RoomEvent.TrackUnpublished, pub("screen_share", "TR_SCR_OLD"), participantOf());
      expect(ctx.result.current.remotes[0]?.screen).toBe(screenS);

      // Matching unpublish with NO publication.track (already unset).
      subscribe(ctx.room, h.RoomEvent.TrackUnpublished, pub("camera", "TR_CAM_A"), participantOf());
      await waitFor(() => {
        const r = ctx.result.current.remotes[0];
        expect(r?.cam).toBeNull();
        expect(r?.screen).toBe(screenS);
        expect(r?.screenOn).toBe(true);
      });
      expect(camA.mediaStreamTrack.endedListenerCount()).toBe(0);
      expect(screenS.mediaStreamTrack.endedListenerCount()).toBe(1);
    } finally {
      await endCall(ctx);
    }
  });

  it("replacement A→B: stale unsubscribe/ended events for A cannot clear B", async () => {
    const ctx = await mountConnected();
    try {
      const trackA = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_A");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, trackA, pub("camera", "TR_CAM_A", false, trackA), participantOf());
      await expectCam(ctx, trackA);

      const trackB = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_B");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, trackB, pub("camera", "TR_CAM_B", false, trackB), participantOf());
      await expectCam(ctx, trackB);
      expect(trackA.mediaStreamTrack.endedListenerCount()).toBe(0);
      expect(trackB.mediaStreamTrack.endedListenerCount()).toBe(1);

      // A's own unsubscribe and native ended must leave B untouched.
      subscribe(ctx.room, h.RoomEvent.TrackUnsubscribed, trackA, pub("camera", "TR_CAM_A", false, trackA), participantOf());
      act(() => trackA.mediaStreamTrack.end());
      expect(ctx.result.current.remotes[0]?.cam).toBe(trackB);

      // Same SID re-subscribed with a DIFFERENT SDK object.
      const trackD = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_C");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, trackD, pub("camera", "TR_CAM_C", false, trackD), participantOf());
      await expectCam(ctx, trackD);
      // Obsolete unpublish from a different publication cannot clear it either.
      subscribe(ctx.room, h.RoomEvent.TrackUnpublished, pub("camera", "TR_CAM_OLD"), participantOf());
      expect(ctx.result.current.remotes[0]?.cam).toBe(trackD);
      expect(trackD.mediaStreamTrack.endedListenerCount()).toBe(1);
      expect(trackB.mediaStreamTrack.endedListenerCount()).toBe(0);
      expect(trackA.stopped).toBe(false);
      expect(trackB.stopped).toBe(false);
    } finally {
      await endCall(ctx);
    }
  });

  it("native ended clears only its own slot", async () => {
    const ctx = await mountConnected();
    try {
      const camA = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_A");
      const screenS = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_SCR_S");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, camA, pub("camera", "TR_CAM_A", false, camA), participantOf());
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, screenS, pub("screen_share", "TR_SCR_S", false, screenS), participantOf());
      await waitFor(() => expect(ctx.result.current.remotes[0]?.screen).toBe(screenS));

      act(() => camA.mediaStreamTrack.end());
      await waitFor(() => {
        const r = ctx.result.current.remotes[0];
        expect(r?.cam).toBeNull();
        expect(r?.camOn).toBe(false);
        expect(r?.screen).toBe(screenS);
        expect(r?.screenOn).toBe(true);
      });
      expect(screenS.mediaStreamTrack.endedListenerCount()).toBe(1);
    } finally {
      await endCall(ctx);
    }
  });

  it("participant departure disposes both video listeners and drops the part", async () => {
    const ctx = await mountConnected();
    try {
      const camA = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_A");
      const screenS = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_SCR_S");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, camA, pub("camera", "TR_CAM_A", false, camA), participantOf());
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, screenS, pub("screen_share", "TR_SCR_S", false, screenS), participantOf());
      await waitFor(() => expect(ctx.result.current.remotes.length).toBe(1));
      expect(camA.mediaStreamTrack.endedListenerCount()).toBe(1);

      subscribe(ctx.room, h.RoomEvent.ParticipantDisconnected, participantOf());
      await waitFor(() => expect(ctx.result.current.remotes.length).toBe(0));
      expect(camA.mediaStreamTrack.endedListenerCount()).toBe(0);
      expect(screenS.mediaStreamTrack.endedListenerCount()).toBe(0);
      expect(camA.stopped).toBe(false);
      expect(screenS.stopped).toBe(false);
    } finally {
      await endCall(ctx);
    }
  });

  it("an unsubscribe for a missing participant creates no ghost video part", async () => {
    const ctx = await mountConnected();
    try {
      const ghostTrack = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_GHOST");
      subscribe(ctx.room, h.RoomEvent.TrackUnsubscribed, ghostTrack, pub("camera", "TR_GHOST", false, ghostTrack), participantOf("ghost"));
      expect(ctx.result.current.remotes).toHaveLength(0);
    } finally {
      await endCall(ctx);
    }
  });

  it("full disconnect clears slots and reconnects; old-room callbacks cannot mutate the new room", async () => {
    const ctx = await mountConnected();
    try {
      const camA = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_A");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, camA, pub("camera", "TR_CAM_A", false, camA), participantOf());
      await expectCam(ctx, camA);

      // FULL room disconnect (server restart): session survives, media cleared.
      subscribe(ctx.room, h.RoomEvent.Disconnected);
      await waitFor(() => {
        const r = ctx.result.current.remotes[0];
        expect(r?.cam).toBeNull();
      });
      expect(ctx.result.current.session?.phase).toBe("active");
      expect(camA.mediaStreamTrack.endedListenerCount()).toBe(0);

      // The hook's retry policy reconnects (~1.5 s later, real timer).
      await waitFor(
        () => {
          expect(h.FakeRoom.instances.length).toBe(2);
        },
        { timeout: 6_000 },
      );
      const room2 = h.FakeRoom.instances[1];
      await waitFor(() => expect(room2.state).toBe("connected"));

      // An old-room subscription cannot resurrect media in the new room.
      const stale = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_STALE");
      subscribe(ctx.room, h.RoomEvent.TrackSubscribed, stale, pub("camera", "TR_STALE", false, stale), participantOf());
      expect(ctx.result.current.remotes[0]?.cam).toBeNull();

      // A subscription on the new room works.
      const camB = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_B");
      subscribe(room2, h.RoomEvent.TrackSubscribed, camB, pub("camera", "TR_CAM_B", false, camB), participantOf());
      await expectCam(ctx, camB);
      expect(ctx.result.current.remotes[0]?.cam).toBe(camB);
    } finally {
      await endCall(ctx);
    }
  });

  it("after a hangup, callbacks from the torn-down room cannot resurrect media", async () => {
    const ctx = await mountConnected();
    const camA = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_CAM_A");
    subscribe(ctx.room, h.RoomEvent.TrackSubscribed, camA, pub("camera", "TR_CAM_A", false, camA), participantOf());
    await expectCam(ctx, camA);

    await act(async () => {
      await ctx.result.current.hangup();
    });
    await waitFor(() => expect(ctx.result.current.remotes).toHaveLength(0));

    // Late old-room events must not rebuild media after teardown.
    const late = new h.FakeRemoteVideoTrack(liveVideoTrack(), "TR_LATE");
    subscribe(ctx.room, h.RoomEvent.TrackSubscribed, late, pub("camera", "TR_LATE", false, late), participantOf());
    expect(ctx.result.current.remotes).toHaveLength(0);
    expect(late.stopped).toBe(false); // we never stop tracks ourselves
    ctx.unmount();
  });
});
