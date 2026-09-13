import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALL_OP_TIMEOUTS, DEFAULT_CALL_OP_TIMEOUTS } from "./callLifecycle";
import { useCallkit } from "./useCallkit";

/**
 * Call-lifecycle ownership tests (the repair's regression suite).
 *
 * Every test here fails against the pre-repair implementation, because each
 * one exercises an async media operation that used to be awaited bare:
 * a hung microphone publish, a camera flip that outlives the call, a screen
 * capture that lands after a hangup, and an end mutation that never resolves.
 *
 * The real hook runs against a mocked SDK boundary, and the operation
 * deadlines are shrunk through CALL_OP_TIMEOUTS so the real code paths run in
 * milliseconds instead of tens of seconds. Nothing about the ownership model
 * itself is mocked away.
 */
const h = vi.hoisted(() => {
  /** Test knobs — flipped per test to bend the fake SDK's behavior. */
  const control = {
    calls: [] as Array<Record<string, unknown>>,
    micMode: "ok" as "ok" | "hang" | "defer",
    camMode: "ok" as "ok" | "hang",
    shareMode: "ok" as "ok" | "fail" | "defer",
    restartMode: "ok" as "ok" | "defer",
    /** Resolvers a test calls to complete a pending SDK operation. */
    resolveMic: null as null | (() => void),
    resolveShare: null as null | (() => void),
    resolveRestart: null as null | (() => void),
    connectMode: "ok" as "ok" | "defer",
    /** Resolver for a deferred room connect (a connect that answers late). */
    resolveConnect: null as null | (() => void),
    devices: [] as Array<{ deviceId: string; kind: string; label?: string }>,
    screenStopCalls: 0,
    /** Total setMicrophoneEnabled() calls (enables and mutes). */
    micCalls: 0,
    /** Every pending defer-mode resolver, in order: a stale operation and a
     *  newer lifecycle's operation can be in flight at the same time. */
    micResolvers: [] as Array<() => void>,
    shareResolvers: [] as Array<() => void>,
    restartResolvers: [] as Array<() => void>,
  };

  class FakeTrack {
    kind = "video";
    readyState: "live" | "ended" = "live";
    stopped = false;
    settings: Record<string, unknown> = { deviceId: "cam-front", facingMode: "user" };
    private endedListeners = new Set<() => void>();
    addEventListener(type: string, cb: () => void) {
      if (type === "ended") this.endedListeners.add(cb);
    }
    removeEventListener(type: string, cb: () => void) {
      if (type === "ended") this.endedListeners.delete(cb);
    }
    getSettings() {
      return this.settings;
    }
    stop() {
      this.stopped = true;
      this.readyState = "ended";
    }
    end() {
      this.readyState = "ended";
      for (const cb of [...this.endedListeners]) cb();
    }
  }

  /** One local publication, shaped like the SDK's TrackPublication. */
  class FakePublication {
    source: string;
    trackSid: string;
    isMuted: boolean;
    track: unknown;
    constructor(source: string, track: unknown, isMuted = true) {
      this.source = source;
      this.trackSid = `TR_${source}_${Math.random().toString(36).slice(2, 8)}`;
      this.track = track;
      this.isMuted = isMuted;
    }
  }

  /**
   * A LocalVideoTrack: carries the browser track plus restartTrack(). A real
   * restartTrack installs a FRESH capture on the SAME LocalVideoTrack object
   * (the publication itself is unchanged), which is what makes the late-result
   * case observable: room teardown stops the OLD capture, and a restart that
   * lands afterwards installs a NEW, otherwise-unowned one.
   */
  class FakeLocalVideoTrack {
    mediaStreamTrack: FakeTrack;
    constructor(mst: FakeTrack) {
      this.mediaStreamTrack = mst;
    }
    restartTrack() {
      if (control.restartMode === "defer") {
        return new Promise<void>((resolve) => {
          const finish = () => {
            this.mediaStreamTrack = new FakeTrack();
            resolve();
          };
          control.restartResolvers.push(finish);
          control.resolveRestart = finish;
        });
      }
      return Promise.resolve();
    }
  }
  const localVideoTrack = (mst: FakeTrack) => new FakeLocalVideoTrack(mst);

  /** A subscribed SDK video track (the renderer's input type). */
  class FakeRemoteVideoTrack {
    mediaStreamTrack: FakeTrack;
    sid: string;
    constructor(mediaStreamTrack: FakeTrack, sid = "TR_REMOTE") {
      this.mediaStreamTrack = mediaStreamTrack;
      this.sid = sid;
    }
    attach() {
      return document.createElement("video");
    }
    detach() {
      return undefined;
    }
    getReceiverStats() {
      return Promise.resolve(undefined);
    }
  }

  class FakeLocalParticipant {
    identity = "u1";
    publications: FakePublication[] = [];
    connectionQuality = "excellent";
    /** Set by FakeRoom so publishing emits the SDK's own events. */
    room: { emit: (event: string, ...args: unknown[]) => void } | null = null;
    /** Push a publication AND tell the room, exactly like the real SDK. */
    private publish(pub: FakePublication) {
      this.publications.push(pub);
      this.room?.emit("localTrackPublished", pub);
    }
    getTrackPublication(source: string) {
      return this.publications.find((p) => p.source === source) ?? null;
    }
    getTrackPublications() {
      return this.publications;
    }
    async unpublishTrack(track: unknown) {
      this.publications = this.publications.filter((p) => p.track !== track);
    }
    async setMicrophoneEnabled(enable: boolean) {
      control.micCalls += 1;
      const existing = this.getTrackPublication("microphone");
      if (!enable) {
        if (existing) existing.isMuted = true;
        return existing;
      }
      if (control.micMode === "hang") return new Promise<never>(() => {});
      if (control.micMode === "defer") {
        return new Promise<FakePublication>((resolve) => {
          const finish = () => {
            const t = new FakeTrack();
            t.kind = "audio";
            const pub = new FakePublication("microphone", { mediaStreamTrack: t }, false);
            this.publish(pub);
            resolve(pub);
          };
          control.micResolvers.push(finish);
          control.resolveMic = finish;
        });
      }
      if (existing) {
        existing.isMuted = false;
        return existing;
      }
      const t = new FakeTrack();
      t.kind = "audio";
      const pub = new FakePublication("microphone", { mediaStreamTrack: t }, false);
      this.publish(pub);
      return pub;
    }
    async setCameraEnabled(enable: boolean) {
      const existing = this.getTrackPublication("camera");
      if (!enable) {
        if (existing) existing.isMuted = true;
        return existing;
      }
      if (control.camMode === "hang") return new Promise<never>(() => {});
      if (existing) {
        existing.isMuted = false;
        return existing;
      }
      const pub = new FakePublication("camera", localVideoTrack(new FakeTrack()), false);
      this.publish(pub);
      return pub;
    }
    async setScreenShareEnabled(enable: boolean) {
      const existing = this.getTrackPublication("screen_share");
      if (!enable) {
        control.screenStopCalls += 1;
        if (existing) {
          (existing.track as { mediaStreamTrack: FakeTrack }).mediaStreamTrack.stop();
          this.publications = this.publications.filter((p) => p !== existing);
          // The SDK fires this for a real unpublish; the hook's state follows it.
          this.room?.emit("localTrackUnpublished", existing);
        }
        return existing;
      }
      if (control.shareMode === "fail") throw new DOMException("nope", "NotSupportedError");
      if (control.shareMode === "defer") {
        return new Promise<FakePublication>((resolve) => {
          const finish = () => {
            const pub = new FakePublication(
              "screen_share",
              { mediaStreamTrack: new FakeTrack() },
              false,
            );
            this.publish(pub);
            resolve(pub);
          };
          control.shareResolvers.push(finish);
          control.resolveShare = finish;
        });
      }
      const pub = new FakePublication("screen_share", { mediaStreamTrack: new FakeTrack() }, false);
      this.publish(pub);
      return pub;
    }
    async publishData() {}
  }

  class FakeRoom {
    static instances: FakeRoom[] = [];
    readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    state = "disconnected";
    readonly localParticipant = new FakeLocalParticipant();
    readonly remoteParticipants = new Map<string, unknown>();
    constructor(_options?: Record<string, unknown>) {
      FakeRoom.instances.push(this);
      // Publishing on the local participant emits the SDK's room events, so the
      // hook's own handlers (camOn, sharing, screenLocal…) run for real.
      this.localParticipant.room = this;
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
      if (control.connectMode === "defer") {
        await new Promise<void>((resolve) => {
          control.resolveConnect = () => {
            this.state = "connected";
            resolve();
          };
        });
        return;
      }
      this.state = "connected";
    }
    async startAudio() {}
    disconnect() {
      this.state = "disconnected";
    }
  }

  class MediaStreamStub {
    readonly tracks: FakeTrack[];
    constructor(tracks: FakeTrack[] = []) {
      this.tracks = tracks;
    }
    getTracks() {
      return this.tracks;
    }
  }

  const Track = {
    Source: { Camera: "camera", Microphone: "microphone", ScreenShare: "screen_share" },
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
  const ConnectionQuality = { Excellent: "excellent", Good: "good", Poor: "poor", Lost: "lost" } as const;

  const lk = {
    Room: FakeRoom,
    RemoteVideoTrack: FakeRemoteVideoTrack,
    RoomEvent,
    Track,
    ConnectionState,
    ConnectionQuality,
  };

  /** Distinct, stable refs per Convex function so the hook's memoization (and
   *  therefore its effect deps) stays stable across renders. */
  const refs = {
    callsStart: { name: "calls.start" },
    callsEnd: { name: "calls.end" },
    callsAnswer: { name: "calls.answer" },
    callsMyCalls: { name: "calls.myCalls" },
    livekitGetToken: { name: "livekit.getToken" },
    livekitHandoff: { name: "livekit.requestScreenShareHandoff" },
    pushNotify: { name: "push.notifyIncomingCall" },
  };
  const fns = {
    start: vi.fn(async () => "call-1"),
    end: vi.fn(async () => ({})),
    answer: vi.fn(async () => ({})),
    getToken: vi.fn(async () => ({ url: "wss://fake.livekit", token: "jwt-fake" })),
    handoff: vi.fn(async () => ({ code: "A".repeat(43), expiresInMs: 60_000 })),
    notify: vi.fn(async () => ({})),
  };

  return { control, FakeRoom, FakeTrack, FakeRemoteVideoTrack, MediaStreamStub, lk, refs, fns, RoomEvent };
});

vi.mock("convex/react", () => ({
  useAction: (ref: unknown) =>
    ref === h.refs.livekitGetToken
      ? h.fns.getToken
      : ref === h.refs.livekitHandoff
        ? h.fns.handoff
        : h.fns.notify,
  useMutation: (ref: unknown) =>
    ref === h.refs.callsStart ? h.fns.start : ref === h.refs.callsEnd ? h.fns.end : h.fns.answer,
}));

vi.mock("./softQuery", () => ({
  useSoftQuery: () => ({ data: h.control.calls, unavailable: false }),
}));

vi.mock("../convex/_generated/api", () => ({
  api: {
    calls: { myCalls: h.refs.callsMyCalls, start: h.refs.callsStart, end: h.refs.callsEnd, answer: h.refs.callsAnswer },
    livekit: { getToken: h.refs.livekitGetToken, requestScreenShareHandoff: h.refs.livekitHandoff },
    push: { notifyIncomingCall: h.refs.pushNotify },
  },
  internal: {},
  components: {},
}));

vi.mock("./livekitLoader", () => ({
  loadLiveKit: async () => h.lk,
  livekit: () => h.lk,
}));

/* ------------------------------------------------------------------ */

type CallRow = Record<string, unknown>;

/** Structural view of the fake browser track used in assertions. */
type FakeTrackLike = { mediaStreamTrack: { stopped: boolean; end: () => void } };

function callRow(over: CallRow = {}): CallRow {
  return {
    callId: "call-1",
    conversationId: "conv-1",
    kind: "video",
    status: "active",
    initiatorId: "u1",
    startedAt: Date.now() - 1_000,
    initiatedByMe: true,
    acceptedByMe: true,
    caller: { userId: "u1", displayName: "من", themeColor: "#2f9e6e" },
    peers: [{ userId: "u2", displayName: "سارا", themeColor: "#8a6340", joined: true }],
    ...over,
  };
}

function overrideMediaMethod(name: string, impl: (...args: unknown[]) => unknown) {
  const proto = HTMLMediaElement.prototype as unknown as Record<string, unknown>;
  try {
    Object.defineProperty(proto, name, { configurable: true, writable: true, value: impl });
  } catch {
    /* jsdom stub stays */
  }
}

function installMediaDevices(getDisplayMedia: boolean) {
  const md: Record<string, unknown> = {
    enumerateDevices: async () => h.control.devices,
    getUserMedia: async () => new h.MediaStreamStub([new h.FakeTrack()]),
  };
  if (getDisplayMedia) {
    md.getDisplayMedia = async () => new h.MediaStreamStub([new h.FakeTrack()]);
  }
  Object.defineProperty(window.navigator, "mediaDevices", { value: md, configurable: true });
}

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

type Ctx = {
  result: { current: ReturnType<typeof useCallkit> };
  room: InstanceType<typeof h.FakeRoom>;
  rerender: () => void;
  unmount: () => void;
};

/**
 * Mount the hook with one call row and wait for the media connect.
 * `waitRoom: false` is for a ringing call (no room is joined until answered).
 */
async function mount(
  ctxCalls: CallRow[] = [callRow()],
  opts: { waitConnected?: boolean; waitRoom?: boolean } = {},
): Promise<Ctx> {
  h.control.calls = ctxCalls;
  const { result, rerender, unmount } = renderHook(() => useCallkit("test-token"));
  if (opts.waitRoom === false) {
    await waitFor(() => expect(result.current.session).not.toBeNull());
    return { result, room: h.FakeRoom.instances[0], rerender, unmount };
  }
  await waitFor(() => expect(h.FakeRoom.instances.length).toBeGreaterThan(0));
  const room = h.FakeRoom.instances[0];
  if (opts.waitConnected !== false) {
    await waitFor(() => expect(room.state).toBe("connected"));
    await waitFor(() => expect(result.current.session?.phase).toBe("active"));
  }
  return { result, room, rerender, unmount };
}

/** Publish a camera the way a user does (the resume path keeps it off). */
async function turnCameraOn(ctx: Ctx) {
  await act(async () => {
    await ctx.result.current.toggleCam();
  });
  await waitFor(() => expect(ctx.result.current.camOn).toBe(true));
  await waitFor(() => expect(ctx.result.current.canSwitchCamera).toBe(true));
}

const flush = async (ms = 0) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

beforeEach(() => {
  h.FakeRoom.instances.length = 0;
  h.control.calls = [];
  h.control.micMode = "ok";
  h.control.camMode = "ok";
  h.control.shareMode = "ok";
  h.control.restartMode = "ok";
  h.control.resolveMic = null;
  h.control.resolveShare = null;
  h.control.resolveRestart = null;
  h.control.resolveConnect = null;
  h.control.connectMode = "ok";
  h.control.micCalls = 0;
  h.control.micResolvers = [];
  h.control.shareResolvers = [];
  h.control.restartResolvers = [];
  h.control.screenStopCalls = 0;
  h.control.devices = [
    { deviceId: "cam-front", kind: "videoinput" },
    { deviceId: "cam-back", kind: "videoinput" },
  ];
  // Shrunken deadlines: the SAME production code paths, fast.
  CALL_OP_TIMEOUTS.mic = 60;
  CALL_OP_TIMEOUTS.micRetryDelay = 10;
  CALL_OP_TIMEOUTS.camera = 80;
  CALL_OP_TIMEOUTS.cameraSwitch = 80;
  CALL_OP_TIMEOUTS.share = 120;
  CALL_OP_TIMEOUTS.endMutation = 40;
  CALL_OP_TIMEOUTS.connect = 2_000;
  vi.stubGlobal("MediaStream", h.MediaStreamStub);
  overrideMediaMethod("play", function play() {
    return Promise.resolve();
  });
  overrideMediaMethod("pause", function pause() {});
  setUserAgent("Mozilla/5.0 (X11; Linux x86_64) Chrome/120");
  installMediaDevices(true);
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
});

afterEach(() => {
  Object.assign(CALL_OP_TIMEOUTS, DEFAULT_CALL_OP_TIMEOUTS);
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */

describe("initial microphone publication ownership", () => {
  it("a microphone publish that never settles cannot wedge the call: finite failure with the clear mic error", async () => {
    h.control.micMode = "hang";
    const ctx = await mount([callRow({ kind: "audio", peers: [
      { userId: "u2", displayName: "سارا", themeColor: "#8a6340", joined: true },
    ] })]);

    // The lifecycle is alive (not stuck on the hung publish)…
    await waitFor(() => expect(ctx.result.current.micError).not.toBeNull());
    expect(ctx.result.current.micOn).toBe(false);
    expect(ctx.result.current.session?.phase).toBe("active");
    expect(ctx.result.current.reconnecting).toBe(false);

    // …and the microphone never became an unowned/undisposed capture. Exactly
    // two attempts were made (initial + one bounded retry), each bounded.
    expect(ctx.result.current.micError).toContain("میکروفون");
    await act(async () => {
      await ctx.result.current.hangup();
    });
    expect(ctx.result.current.session).toBeNull();
    ctx.unmount();
  });

  it("hangup while the microphone publish is pending: the late capture is released and nothing resurrects", async () => {
    h.control.micMode = "defer";
    const ctx = await mount([callRow({ kind: "audio" })], { waitConnected: false });
    await waitFor(() => expect(h.control.resolveMic).not.toBeNull());

    await act(async () => {
      await ctx.result.current.hangup();
    });
    expect(ctx.result.current.session).toBeNull();

    // The publish answers AFTER the hangup: its capture must be stopped, and
    // it must not bring any call state back.
    await act(async () => {
      h.control.resolveMic?.();
    });
    await flush(60);

    // The late capture's own track was stopped (it is the operation's
    // resource; the call it would have belonged to is gone).
    const lateMicPublications = ctx.room.localParticipant.getTrackPublications();
    const lateMicTrack = (lateMicPublications[0]?.track as FakeTrackLike | undefined)?.mediaStreamTrack;
    expect(lateMicTrack?.stopped).toBe(true);
    expect(ctx.result.current.session).toBeNull();
    expect(ctx.result.current.micOn).toBe(true); // teardown default, unchanged
    ctx.unmount();
  });

  it("a new call started before the old microphone promise resolves is untouched by the late completion", async () => {
    h.control.micMode = "defer";
    const ctx = await mount([callRow({ kind: "audio" })], { waitConnected: false });
    await waitFor(() => expect(h.control.resolveMic).not.toBeNull());

    await act(async () => {
      await ctx.result.current.hangup();
    });
    // A SECOND call starts; its own room/publishes are the live ones.
    h.control.micMode = "ok";
    await act(async () => {
      h.control.calls = [callRow({ callId: "call-2", kind: "audio", startedAt: Date.now() })];
      ctx.rerender();
    });
    await waitFor(() => expect(h.FakeRoom.instances.length).toBe(2));
    const secondRoom = h.FakeRoom.instances[1];
    await waitFor(() => expect(secondRoom.state).toBe("connected"));

    const secondMic = secondRoom.localParticipant.getTrackPublication("microphone");
    expect(secondMic).not.toBeNull();

    // Now the OLD publish lands.
    await act(async () => {
      h.control.resolveMic?.();
    });
    await flush(60);

    // The new call's microphone is untouched and still live…
    const after = secondRoom.localParticipant.getTrackPublication("microphone");
    expect(after).toBe(secondMic);
    expect(after?.isMuted).toBe(false);
    // …and nothing about the new call's session or UI changed.
    await waitFor(() => expect(ctx.result.current.session?.callId).toBe("call-2"));
    expect(ctx.result.current.micOn).toBe(true);
    ctx.unmount();
  });
});

describe("camera switch ownership", () => {
  it("hangup during a camera switch leaves the late switch inert (no preview, no camOn/camFacing, no lock left behind)", async () => {
    h.control.restartMode = "defer";
    const ctx = await mount();
    await turnCameraOn(ctx);

    await act(async () => {
      void ctx.result.current.switchCamera();
    });
    // The flip is awaiting restartTrack when the user hangs up.
    await waitFor(() => expect(h.control.resolveRestart).not.toBeNull());
    await act(async () => {
      await ctx.result.current.hangup();
    });
    expect(ctx.result.current.session).toBeNull();

    await act(async () => {
      h.control.resolveRestart?.();
    });
    await flush(60);

    expect(ctx.result.current.local).toBeNull();
    expect(ctx.result.current.camOn).toBe(false);
    expect(ctx.result.current.camFacing).toBe("");
    expect(ctx.result.current.camError).toBeNull();
    // The busy lock is released, so a fresh call can flip its camera again.
    h.control.restartMode = "ok";
    ctx.unmount();
  });

  it("rapid switch → hangup → new call: the stale completion cannot stop the new call's camera", async () => {
    h.control.restartMode = "defer";
    const ctx = await mount();
    await turnCameraOn(ctx);
    await act(async () => {
      void ctx.result.current.switchCamera();
    });
    await waitFor(() => expect(h.control.resolveRestart).not.toBeNull());

    await act(async () => {
      await ctx.result.current.hangup();
    });
    h.control.restartMode = "ok";
    await act(async () => {
      h.control.calls = [callRow({ callId: "call-2", startedAt: Date.now() })];
      ctx.rerender();
    });
    await waitFor(() => expect(h.FakeRoom.instances.length).toBe(2));
    const secondRoom = h.FakeRoom.instances[1];
    await waitFor(() => expect(secondRoom.state).toBe("connected"));
    // The new call turns its own camera on, and then the STALE flip from the
    // previous call finally completes.
    await act(async () => {
      await ctx.result.current.toggleCam();
    });
    const newCam = secondRoom.localParticipant.getTrackPublication("camera");
    const newCamTrack = newCam?.track as FakeTrackLike | undefined;
    expect(newCamTrack).toBeDefined();
    expect(newCamTrack?.mediaStreamTrack.stopped).toBe(false);

    await act(async () => {
      h.control.resolveRestart?.();
    });
    await flush(60);

    // The new call's camera is untouched, and its state is not overwritten by
    // the obsolete operation.
    expect(newCamTrack?.mediaStreamTrack.stopped).toBe(false);
    expect(secondRoom.localParticipant.getTrackPublication("camera")).toBe(newCam);
    await waitFor(() => expect(ctx.result.current.session?.callId).toBe("call-2"));
    expect(ctx.result.current.camOn).toBe(true);
    ctx.unmount();
  });
});

describe("screen-share ownership", () => {
  it("hangup while the browser picker is pending: the late capture is released and sharing stays false", async () => {
    h.control.shareMode = "defer";
    const ctx = await mount();
    await waitFor(() => expect(ctx.result.current.session?.phase).toBe("active"));

    await act(async () => {
      void ctx.result.current.toggleShare();
    });
    expect(ctx.result.current.shareStarting).toBe(true);

    await act(async () => {
      await ctx.result.current.hangup();
    });
    expect(ctx.result.current.sharing).toBe(false);

    await act(async () => {
      h.control.resolveShare?.();
    });
    await flush(60);

    // The screen track that arrived after the hangup must not be left live,
    // and no share state may be committed for the dead call.
    const pubs = ctx.room.localParticipant.getTrackPublications();
    const screen = pubs.find((p) => p.source === "screen_share");
    if (screen) {
      expect((screen.track as FakeTrackLike).mediaStreamTrack.stopped).toBe(true);
    }
    expect(ctx.result.current.sharing).toBe(false);
    expect(ctx.result.current.screenLocal).toBeNull();
    expect(ctx.result.current.session).toBeNull();
    ctx.unmount();
  });

  it("start → stop → start again keeps sharing truthful throughout", async () => {
    const ctx = await mount();
    await act(async () => {
      await ctx.result.current.toggleShare();
    });
    expect(ctx.result.current.sharing).toBe(true);

    await act(async () => {
      await ctx.result.current.toggleShare();
    });
    expect(ctx.result.current.sharing).toBe(false);
    expect(ctx.result.current.screenLocal).toBeNull();
    expect(h.control.screenStopCalls).toBe(1);

    await act(async () => {
      await ctx.result.current.toggleShare();
    });
    expect(ctx.result.current.sharing).toBe(true);
    expect(ctx.result.current.shareError).toBeNull();
    ctx.unmount();
  });

  it("the OS/browser 'stop sharing' (track ended) ends the share honestly", async () => {
    const ctx = await mount();
    await act(async () => {
      await ctx.result.current.toggleShare();
    });
    expect(ctx.result.current.sharing).toBe(true);

    const pub = ctx.room.localParticipant.getTrackPublication("screen_share");
    const track = (pub?.track as FakeTrackLike).mediaStreamTrack;
    await act(async () => {
      track.end();
    });
    await waitFor(() => expect(ctx.result.current.sharing).toBe(false));
    ctx.unmount();
  });

  it("a browser without working display capture is routed to the Android companion (never just 'unsupported')", async () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/120 Mobile Safari");
    installMediaDevices(false); // no getDisplayMedia on this Android browser
    const ctx = await mount();
    await act(async () => {
      await ctx.result.current.toggleShare();
    });
    await waitFor(() => expect(h.fns.handoff).toHaveBeenCalledTimes(1));
    expect(h.fns.handoff).toHaveBeenCalledWith({ token: "test-token", callId: "call-1" });
    expect(ctx.result.current.sharePath).toBe("android-native");
    // No web share was attempted and no false "unsupported" message shown.
    expect(h.control.screenStopCalls).toBe(0);
    expect(ctx.result.current.shareError).toBeNull();
    ctx.unmount();
  });

  it("reports a remembered web-path failure and switches this device to the companion", async () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/120 Mobile Safari");
    installMediaDevices(true); // the API exists but the platform cannot deliver
    h.control.shareMode = "fail";
    const ctx = await mount();
    await act(async () => {
      await ctx.result.current.toggleShare();
    });
    await waitFor(() => expect(ctx.result.current.shareError).not.toBeNull());
    expect(ctx.result.current.sharePath).toBe("android-native");
    ctx.unmount();
  });
});

describe("auxiliary screen-share participant (Android companion)", () => {
  it("attributes the companion's screen track to the real user instead of a mystery participant", async () => {
    const ctx = await mount();
    const screen = new h.FakeRemoteVideoTrack(new h.FakeTrack(), "TR_AUX");
    await act(async () => {
      ctx.room.emit(
        h.RoomEvent.TrackSubscribed,
        screen,
        { source: "screen_share", trackSid: "TR_AUX", isMuted: false, track: screen },
        { identity: "u2:screen" },
      );
    });
    const peer = ctx.result.current.remotes.find((r) => r.userId === "u2");
    expect(peer?.screen).toBe(screen);
    expect(peer?.screenOn).toBe(true);
    // No extra "u2:screen" participant is ever exposed.
    expect(ctx.result.current.remotes.some((r) => r.userId.includes("screen"))).toBe(false);

    // Stopping the companion removes the screen tile immediately.
    await act(async () => {
      ctx.room.emit(
        h.RoomEvent.TrackUnpublished,
        { source: "screen_share", trackSid: "TR_AUX" },
        { identity: "u2:screen" },
      );
    });
    await waitFor(() => {
      const after = ctx.result.current.remotes.find((r) => r.userId === "u2");
      expect(after?.screen).toBeNull();
      expect(after?.screenOn).toBe(false);
    });
    ctx.unmount();
  });

  it("ignores a companion for someone who is not on this call, and any non-screen source it might try", async () => {
    const ctx = await mount();
    const ghostTrack = new h.FakeRemoteVideoTrack(new h.FakeTrack(), "TR_GHOST");
    await act(async () => {
      ctx.room.emit(
        h.RoomEvent.TrackSubscribed,
        ghostTrack,
        { source: "screen_share", trackSid: "TR_GHOST", isMuted: false, track: ghostTrack },
        { identity: "ghost:screen" },
      );
    });
    expect(ctx.result.current.remotes).toHaveLength(0);

    const camAsScreen = new h.FakeRemoteVideoTrack(new h.FakeTrack(), "TR_WRONG");
    await act(async () => {
      ctx.room.emit(
        h.RoomEvent.TrackSubscribed,
        camAsScreen,
        { source: "camera", trackSid: "TR_WRONG", isMuted: false, track: camAsScreen },
        { identity: "u2:screen" },
      );
    });
    const peer = ctx.result.current.remotes.find((r) => r.userId === "u2");
    expect(peer?.cam ?? null).toBeNull();
    expect(peer?.screen ?? null).toBeNull();
    ctx.unmount();
  });

  it("my own companion marks MY share instead of appearing as another person", async () => {
    const ctx = await mount();
    const mine = new h.FakeRemoteVideoTrack(new h.FakeTrack(), "TR_MINE");
    await act(async () => {
      ctx.room.emit(
        h.RoomEvent.TrackSubscribed,
        mine,
        { source: "screen_share", trackSid: "TR_MINE", isMuted: false, track: mine },
        { identity: "u1:screen" },
      );
    });
    await waitFor(() => expect(ctx.result.current.nativeSharing).toBe(true));
    expect(ctx.result.current.sharing).toBe(true);
    // It is not rendered as a remote peer.
    expect(ctx.result.current.remotes.some((r) => r.userId.includes("screen"))).toBe(false);

    // The companion disconnect (notification STOP, revoked projection, service
    // killed) returns the UI to non-sharing.
    await act(async () => {
      ctx.room.emit(h.RoomEvent.ParticipantDisconnected, { identity: "u1:screen" });
    });
    await waitFor(() => expect(ctx.result.current.nativeSharing).toBe(false));
    expect(ctx.result.current.sharing).toBe(false);
    ctx.unmount();
  });
});

describe("hangup never waits on the network", () => {
  it("an end mutation that never resolves still lets hangup complete immediately", async () => {
    const ctx = await mount();
    h.fns.end.mockImplementation(() => new Promise(() => {}));

    const started = Date.now();
    await act(async () => {
      await ctx.result.current.hangup();
    });
    const elapsed = Date.now() - started;

    // Local release is instant: no server round-trip is awaited.
    expect(elapsed).toBeLessThan(300);
    expect(ctx.result.current.session).toBeNull();
    expect(ctx.result.current.sharing).toBe(false);
    expect(ctx.result.current.camOn).toBe(false);
    expect(ctx.result.current.busy).toBe(false);
    // Room and captures are gone locally.
    expect(ctx.room.state).toBe("disconnected");
    ctx.unmount();
  });

  it("the same holds for decline while ringing", async () => {
    const ctx = await mount([callRow({ status: "ringing", initiatedByMe: false, acceptedByMe: false })], {
      waitRoom: false,
    });
    await waitFor(() => expect(ctx.result.current.session?.phase).toBe("incoming"));
    h.fns.end.mockImplementation(() => new Promise(() => {}));

    await act(async () => {
      await ctx.result.current.decline();
    });
    expect(ctx.result.current.session).toBeNull();
    expect(ctx.result.current.busy).toBe(false);
    ctx.unmount();
  });
});

describe("lock ownership across lifecycles", () => {
  it("an obsolete share attempt cannot un-latch a NEW call's share button", async () => {
    // Wide deadline so the handoff (hangup + a whole new call) happens while
    // the first attempt is still in flight.
    CALL_OP_TIMEOUTS.share = 5_000;
    const ctx = await mount();
    await waitFor(() => expect(ctx.result.current.session?.phase).toBe("active"));

    // (1) Call #1: a share attempt that answers only when the test says so.
    h.control.shareMode = "defer";
    await act(async () => {
      void ctx.result.current.toggleShare();
    });
    await waitFor(() => expect(h.control.shareResolvers.length).toBe(1));
    expect(ctx.result.current.shareStarting).toBe(true);

    // (2) The user hangs up and starts a NEW call while it is still pending.
    await act(async () => {
      await ctx.result.current.hangup();
    });
    await act(async () => {
      h.control.calls = [callRow({ callId: "call-2", startedAt: Date.now() })];
      ctx.rerender();
    });
    await waitFor(() => expect(h.FakeRoom.instances.length).toBe(2));
    const second = h.FakeRoom.instances[1];
    await waitFor(() => expect(second.state).toBe("connected"));

    // (3) The new call starts its OWN share attempt (also pending).
    await act(async () => {
      void ctx.result.current.toggleShare();
    });
    await waitFor(() => expect(h.control.shareResolvers.length).toBe(2));
    expect(ctx.result.current.shareStarting).toBe(true);

    // (4) The DEAD call's capture finally answers. It belongs to a disposed
    // lifecycle, so it may not paint the new call's share state.
    await act(async () => {
      h.control.shareResolvers[0]();
    });
    await flush(30);
    expect(ctx.result.current.shareStarting).toBe(true);

    // (5) The new call's own capture then lands and completes normally.
    await act(async () => {
      h.control.shareResolvers[1]();
    });
    await waitFor(() => expect(ctx.result.current.sharing).toBe(true));
    expect(ctx.result.current.shareStarting).toBe(false);
    ctx.unmount();
  });

  it("an obsolete microphone toggle cannot release a NEW call's microphone lock", async () => {
    CALL_OP_TIMEOUTS.mic = 5_000;
    const ctx = await mount([callRow({ kind: "audio" })]);
    await waitFor(() => expect(ctx.result.current.session?.phase).toBe("active"));

    // (1) Call #1: mute (synchronous), then unmute, which hangs in the SDK.
    await act(async () => {
      await ctx.result.current.toggleMic();
    });
    await waitFor(() => expect(ctx.result.current.micOn).toBe(false));
    h.control.micMode = "defer";
    await act(async () => {
      void ctx.result.current.toggleMic();
    });
    await waitFor(() => expect(h.control.micResolvers.length).toBe(1));

    // (2) Hang up and start call #2 while that publish is still pending.
    await act(async () => {
      await ctx.result.current.hangup();
    });
    h.control.micMode = "ok";
    await act(async () => {
      h.control.calls = [callRow({ callId: "call-2", kind: "audio", startedAt: Date.now() })];
      ctx.rerender();
    });
    await waitFor(() => expect(h.FakeRoom.instances.length).toBe(2));
    const second = h.FakeRoom.instances[1];
    await waitFor(() => expect(second.state).toBe("connected"));

    // (3) Call #2 starts its own pending microphone operation.
    await act(async () => {
      await ctx.result.current.toggleMic();
    });
    await waitFor(() => expect(ctx.result.current.micOn).toBe(false));
    h.control.micMode = "defer";
    await act(async () => {
      void ctx.result.current.toggleMic();
    });
    await waitFor(() => expect(h.control.micResolvers.length).toBe(2));

    // (4) The DEAD call's publish answers late and must release nothing.
    await act(async () => {
      h.control.micResolvers[0]();
    });
    await flush(30);

    // (5) Call #2's microphone lock is still held: a second tap while its own
    // publish is in flight must be a no-op, not a second concurrent publish.
    const callsBefore = h.control.micCalls;
    await act(async () => {
      await ctx.result.current.toggleMic();
    });
    expect(h.control.micCalls).toBe(callsBefore);

    await act(async () => {
      h.control.micResolvers[1]();
    });
    await flush(30);
    ctx.unmount();
  });

  it("a room connect that answers after its deadline is closed again", async () => {
    CALL_OP_TIMEOUTS.connect = 60;
    h.control.connectMode = "defer";
    const ctx = await mount([callRow()], { waitConnected: false });
    await waitFor(() => expect(h.control.resolveConnect).not.toBeNull());

    // The deadline fires: the app gives up on this room and disconnects it.
    await flush(120);
    expect(ctx.room.state).toBe("disconnected");

    // The SDK now finishes connecting the abandoned room. It must be closed
    // again instead of sitting there live and publishing behind a call that
    // already moved on.
    await act(async () => {
      h.control.resolveConnect?.();
    });
    await flush(40);
    expect(ctx.room.state).toBe("disconnected");
    ctx.unmount();
  });

  it("a camera flip whose restartTrack answers after the call ended releases that capture", async () => {
    CALL_OP_TIMEOUTS.cameraSwitch = 60;
    h.control.restartMode = "defer";
    const ctx = await mount();
    await turnCameraOn(ctx);
    const camTrack = ctx.room.localParticipant.getTrackPublication("camera")?.track as
      | { mediaStreamTrack: { stopped: boolean } }
      | undefined;

    await act(async () => {
      void ctx.result.current.switchCamera();
    });
    await waitFor(() => expect(h.control.restartResolvers.length).toBe(1));

    // The user hangs up while the flip is still in flight…
    await act(async () => {
      await ctx.result.current.hangup();
    });
    // …its deadline fires (the room teardown already stopped the OLD capture it
    // was replacing), and the SDK only then answers — installing the FRESH
    // capture on that same publication.
    await flush(90);
    await act(async () => {
      h.control.restartResolvers[0]();
    });
    await flush(120);

    // That late capture has no call behind it and nothing else would ever stop
    // it: the obsolete flip must have released it.
    expect(camTrack?.mediaStreamTrack.stopped).toBe(true);
    expect(ctx.result.current.session).toBeNull();
    ctx.unmount();
  });
});
