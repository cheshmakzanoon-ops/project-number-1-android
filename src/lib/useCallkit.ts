import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Room,
  RoomEvent,
  Track,
  ConnectionQuality,
  ConnectionState,
  type TrackPublication,
  type VideoEncoding,
} from "livekit-client";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

export type CallPhase = "idle" | "outgoing" | "incoming" | "active";
export type CallKind = "audio" | "video";

export interface CallSession {
  callId: Id<"calls">;
  phase: CallPhase;
  kind: CallKind;
  otherId?: Id<"users">;
  otherName: string;
  otherColor: string;
  initiatedByMe: boolean;
}

export interface GarmaCallkit {
  session: CallSession | null;
  startCall: (
    conversationId: Id<"conversations">,
    otherId: Id<"users">,
    otherName: string,
    otherColor: string,
    kind: CallKind,
  ) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
  hangup: () => Promise<void>;
  toggleMic: () => Promise<void>;
  toggleCam: () => Promise<void>;
  switchCamera: () => Promise<void>;
  toggleShare: () => Promise<void>;
  toggleSpeaker: () => void;
  micOn: boolean;
  camOn: boolean;
  speakerOn: boolean;
  sharing: boolean;
  remoteMicOn: boolean;
  remoteCamOn: boolean;
  /** LiveKit measured the remote peer's link to us as poor (their uplink). */
  remotePoor: boolean;
  local: MediaStream | null;
  remote: MediaStream | null;
  screenLocal: MediaStream | null;
  screenRemote: MediaStream | null;
  error: string | null;
  /** True while an accept/decline/hangup/start mutation is in flight. */
  busy: boolean;
  /** True while LiveKit is re-establishing a dropped connection. */
  reconnecting: boolean;
  /** Active camera tier label ("1080p" / "720p" / "480p"). */
  camQuality: string | null;
  /**
   * Cycle the camera quality between automatic and a fixed cap
   * (auto -> 480p -> 720p -> 1080p -> auto). Tapping the in-call badge
   * calls this. In "auto" the app follows the network + measured
   * congestion; a fixed cap is respected even on fast links.
   */
  cycleQuality: () => void;
}

type CallRow = {
  callId: Id<"calls">;
  conversationId: Id<"conversations">;
  kind: CallKind;
  status: "ringing" | "active" | "ended" | "declined" | "missed";
  initiatorId: Id<"users">;
  startedAt: number;
  otherName: string;
  otherColor: string;
  initiatedByMe: boolean;
};

/**
 * Result of a media-connect attempt:
 * - true: connected, media publishing.
 * - "retryable": transient failure (timeout, dead link) — retry in background.
 * - "unauthorized" / "livekit_not_configured": permanent — give up.
 */
type ConnectResult = true | "retryable" | "unauthorized" | "livekit_not_configured";

function one(media: MediaStreamTrack | null | undefined): MediaStream | null {
  return media ? new MediaStream([media]) : null;
}

/** Structural view of the Network Information API (not in TS's DOM lib). */
type NetConn = {
  effectiveType?: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

function netConn(): NetConn | null {
  return (navigator as Navigator & { connection?: NetConn | null }).connection ?? null;
}

/** Rough network class: 0 = slow, 1 = medium, 2 = fast. Unknown => fast. */
function netTier(effectiveType?: string): number {
  if (effectiveType === "slow-2g" || effectiveType === "2g") return 0;
  if (effectiveType === "3g") return 1;
  return 2;
}

/**
 * The camera tier each network class starts at (and, in auto mode, may step
 * back up to): 2g/slow-2g → 180p, 3g → 480p, 4g/5g/WiFi/unknown → 1080p.
 * Choosing deliberately below what a link "should" carry keeps the call alive
 * through the real-world valleys of mobile networks instead of bursting and
 * then freezing.
 */
const TIER_BY_NET_CLASS: ReadonlyArray<number> = [0, 1, 3];

/** The tier the current network class allows in auto mode. */
function netCeilingTier(): number {
  const c = TIER_BY_NET_CLASS[netTier(netConn()?.effectiveType)];
  return c ?? TIER_BY_NET_CLASS[TIER_BY_NET_CLASS.length - 1];
}

/**
 * Camera tiers, ordered low → high, chosen from (and adapted to) the caller's
 * connection so a video call uses the highest quality the network can
 * actually transport — and, when everything collapses, still the lowest one:
 * - 2g / slow-2g: 180p @ 12fps (~170 kbps — EDGE-class uplink floor)
 * - 3g:           480p @ 15fps (~450 kbps)
 * - 4g/5g/WiFi:   1080p @ 30fps (only when the link is truly healthy)
 *
 * Every tier publishes with LiveKit SIMULCAST (q/h spatial layers on top of
 * this "f" layer) + dynacast + adaptiveStream. That combination is what keeps
 * a weak receiver's picture moving: when their link congests, LiveKit hands
 * them a smaller layer instead of a frozen full-res frame, and it stops
 * forwarding layers nobody watches. `encoding.maxBitrate` caps the top layer
 * (and therefore the worst-case uplink) per tier — VP8 defaults would happily
 * burst far higher than a flaky 3G uplink can carry.
 */
const CAM_TIERS: ReadonlyArray<{
  label: string;
  resolution: { width: number; height: number };
  frameRate: number;
  encoding: VideoEncoding;
}> = [
  {
    label: "180p",
    resolution: { width: 320, height: 180 },
    frameRate: 12,
    encoding: { maxBitrate: 170_000, maxFramerate: 12 },
  },
  {
    label: "480p",
    resolution: { width: 640, height: 480 },
    frameRate: 15,
    encoding: { maxBitrate: 450_000, maxFramerate: 15 },
  },
  {
    label: "720p",
    resolution: { width: 1280, height: 720 },
    frameRate: 24,
    encoding: { maxBitrate: 1_200_000, maxFramerate: 24 },
  },
  {
    label: "1080p",
    resolution: { width: 1920, height: 1080 },
    frameRate: 30,
    encoding: { maxBitrate: 2_500_000, maxFramerate: 30 },
  },
];

/**
 * Quality mode:
 * - "auto":  follow the network class AND measured congestion (default)
 * - fixed cap ("480p"/"720p"/"1080p"): pin the capture tier — useful when a
 *   link is fast but flaky/metered, or the phone is low-end.
 * The 180p tier is only ever used by "auto" as the emergency floor.
 */
type CamMode = "auto" | "480p" | "720p" | "1080p";

const MODE_KEY = "garma.cam.mode";
const CAM_CYCLE: CamMode[] = ["auto", "480p", "720p", "1080p"];
const TIER_OF_MODE: Record<Exclude<CamMode, "auto">, number> = {
  "480p": 1,
  "720p": 2,
  "1080p": 3,
};

function loadCamMode(): CamMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "auto" || v === "480p" || v === "720p" || v === "1080p") return v;
  } catch {
    /* noop */
  }
  return "auto";
}

function saveCamMode(m: CamMode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* noop */
  }
}

/** Reject after `ms` so a hung getUserMedia/connect can never wedge the UI. */
function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function useCallkit(token: string | null): GarmaCallkit {
  const [session, setSession] = useState<CallSession | null>(null);
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const [screenRemote, setScreenRemote] = useState<MediaStream | null>(null);
  const [screenLocal, setScreenLocal] = useState<MediaStream | null>(null);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [remoteMicOn, setRemoteMicOn] = useState(true);
  const [remoteCamOn, setRemoteCamOn] = useState(true);
  const [remotePoor, setRemotePoor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [camQuality, setCamQuality] = useState<string | null>(null);

  const roomRef = useRef<Room | null>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const camTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const lastCamIdRef = useRef<string>("");
  const remoteAudioElsRef = useRef<Set<HTMLAudioElement>>(new Set());
  const busyRef = useRef(false);
  const sawCallRef = useRef(false);
  const ringRef = useRef<AudioContext | null>(null);
  const ringTimerRef = useRef<number | null>(null);
  const ringVibrateTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // ---- Adaptive camera quality state ----
  const camModeRef = useRef<CamMode>(loadCamMode());
  /** The tier the camera is currently captured/published at. */
  const captureTierRef = useRef<number>(CAM_TIERS.length - 1);
  const tierBusyRef = useRef(false);
  /**
   * Whether the user wants the camera LIVE right now. Adapters (congestion
   * stepping, network-tier changes, quality cycling) must respect this — they
   * must never silently switch a deliberately-off camera back on.
   */
  const camIntentRef = useRef(false);
  /** Whether the user wants the mic LIVE right now (restored on rejoin). */
  const micIntentRef = useRef(true);
  /**
   * The call this screen's user (or a local ring timeout) ended while its
   * server row is still ringing/active (e.g. the end mutation failed on a
   * dead link). The lifecycle reconcile below must not re-present/re-join
   * that call; the ref is cleared once the row actually disappears from
   * myCalls, and the end mutation is retried whenever connectivity returns.
   */
  const leaveRef = useRef<{ callId: Id<"calls">; wanted: "ended" | "declined" | "missed" } | null>(null);
  // ---- App-level "never drop the call" machinery ----
  // LiveKit's own reconnect never gives up (see the reconnectPolicy below).
  // For the rarer case of a FULL disconnect (server restart, room closed,
  // policy-less hard failure) these refs run an application-level rejoin loop
  // that keeps retrying the same call until the user hangs up or the peer
  // ends it — a call therefore never dies just because the network was dead
  // for a while.
  const connectGenRef = useRef(0); // bumped on teardown → invalidates retries
  const connectTimerRef = useRef<number | null>(null);
  const connRetryDelayRef = useRef(1500);
  const connectMediaRef = useRef<
    (callId: Id<"calls">, kind: CallKind, opts?: { restoreState?: boolean }) => Promise<ConnectResult>
  >(async () => "retryable");
  /** Fails an unanswered ring (incoming: missed, outgoing: timed out). */
  const ringTtlRef = useRef<number | null>(null);
  /** Periodic sampler of the measured connection quality (auto degrade). */
  const qualityWatchRef = useRef<number | null>(null);
  const qualityCountsRef = useRef({ poor: 0, good: 0 });

  const startCallMut = useMutation(api.calls.start);
  const endCallMut = useMutation(api.calls.end);
  const answerCallMut = useMutation(api.calls.answer);
  const getToken = useAction(api.livekit.getToken);
  const notifyIncoming = useAction(api.push.notifyIncomingCall);

  /**
   * iOS/Safari only grant mic/camera if the request happens inside (or very
   * soon after) a user tap, before any slow network round-trips. We warm the
   * permission synchronously so the LiveKit connect that follows can't be
   * blocked, then release the tracks — LiveKit re-requests and reuses the grant.
   * Capped with a timeout so a stuck permission prompt can never wedge the UI.
   */
  const primeMedia = useCallback(async (kind: CallKind) => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({ audio: true, video: kind === "video" }),
        10_000,
        "prime_timeout",
      );
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* denied here just means the grant is reused; LiveKit will surface errors */
    }
  }, []);

  const myCalls = useQuery(api.calls.myCalls, token ? { token } : "skip") as unknown as
    | CallRow[]
    | undefined;

  const rebuildRemote = useCallback(() => {
    const parts: MediaStreamTrack[] = [];
    if (micTrackRef.current) parts.push(micTrackRef.current);
    if (camTrackRef.current) parts.push(camTrackRef.current);
    setRemote(parts.length ? new MediaStream(parts) : null);
  }, []);

  const clearRingTtl = useCallback(() => {
    if (ringTtlRef.current != null) {
      window.clearTimeout(ringTtlRef.current);
      ringTtlRef.current = null;
    }
  }, []);

  const clearQualityWatch = useCallback(() => {
    if (qualityWatchRef.current != null) {
      window.clearInterval(qualityWatchRef.current);
      qualityWatchRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    // Invalidate any scheduled rejoin attempt and cancel its timer.
    connectGenRef.current += 1;
    if (connectTimerRef.current != null) {
      window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    connRetryDelayRef.current = 1500;
    remoteAudioElsRef.current.forEach((el) => {
      el.pause();
      el.srcObject = null;
    });
    remoteAudioElsRef.current.clear();
    clearRingTtl();
    clearQualityWatch();
    const room = roomRef.current;
    if (room) {
      // Null the ref BEFORE disconnecting: every room event handler is scoped
      // to "am I still the current room?", so the async Disconnected event
      // that follows (sometimes seconds later) can never tear down a NEW call
      // created in between. This was the root cause of the second call dying.
      roomRef.current = null;
      try {
        room.disconnect();
      } catch {
        /* noop */
      }
    }
    micTrackRef.current = null;
    camTrackRef.current = null;
    screenTrackRef.current = null;
    lastCamIdRef.current = "";
    setRemote(null);
    setScreenRemote(null);
    setScreenLocal(null);
    setLocal(null);
    setMicOn(true);
    micIntentRef.current = true;
    setCamOn(false);
    camIntentRef.current = false;
    setSharing(false);
    setRemoteMicOn(true);
    setRemoteCamOn(true);
    setRemotePoor(false);
    setCamQuality(null);
    setReconnecting(false);
    qualityCountsRef.current = { poor: 0, good: 0 };
  }, [clearQualityWatch, clearRingTtl]);

  const stopRing = useCallback(() => {
    if (ringTimerRef.current != null) {
      window.clearInterval(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    if (ringVibrateTimerRef.current != null) {
      window.clearInterval(ringVibrateTimerRef.current);
      ringVibrateTimerRef.current = null;
    }
    try {
      navigator.vibrate?.(0);
    } catch {
      /* noop */
    }
    try {
      ringRef.current?.close();
    } catch {
      /* noop */
    }
    ringRef.current = null;
  }, []);

  // Any teardown must silence the ringtone, or a dropped call keeps beeping.
  const cleanup = useCallback(() => {
    teardown();
    stopRing();
    sawCallRef.current = false;
    setSession(null);
  }, [teardown, stopRing]);

  /**
   * Classic analog-phone ring: a 440+480 Hz dual tone, rung for 2s then
   * paused for 4s — the cadence every real phone uses, so an incoming call
   * sounds like a phone ringing, not a beep. Also vibrates on phones that
   * support the Vibration API (silent-switch independent).
   */
  const startRing = useCallback(() => {
    stopRing();
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      ringRef.current = ctx;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(ctx.destination);
      const o1 = ctx.createOscillator();
      o1.type = "sine";
      o1.frequency.value = 440;
      const o2 = ctx.createOscillator();
      o2.type = "sine";
      o2.frequency.value = 480;
      o1.connect(gain);
      o2.connect(gain);
      o1.start();
      o2.start();
      // 2s ring / 4s silence, matching the standard ring cadence.
      const tone = () => {
        gain.gain.setTargetAtTime(0.22, ctx.currentTime, 0.02);
        window.setTimeout(() => {
          gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        }, 2000);
      };
      tone();
      ringTimerRef.current = window.setInterval(tone, 6000);
      const vibrate = () => {
        try {
          navigator.vibrate?.([800, 400, 800, 400, 800]);
        } catch {
          /* noop */
        }
      };
      vibrate();
      ringVibrateTimerRef.current = window.setInterval(vibrate, 6000);
    } catch {
      /* noop */
    }
  }, [stopRing]);

  useEffect(() => () => stopRing(), [stopRing]);

  /**
   * (Re)capture and publish the camera at a given tier. Used for the initial
   * publish, network upgrades/downgrades, congestion stepping and manual caps.
   * Publish options explicitly carry simulcast + this tier's bitrate cap so
   * the SFU always has lower spatial layers to offer a struggling receiver.
   */
  const captureCameraAt = useCallback(
    async (tier: number, opts?: { enable?: boolean }): Promise<boolean> => {
      const room = roomRef.current;
      if (!room || tierBusyRef.current) return false;
      const plan = CAM_TIERS[tier];
      if (!plan) return false;
      // Camera adaptation is only meaningful during video calls — an audio
      // call must never have its camera silently switched on by a network
      // change.
      if (sessionRef.current?.kind !== "video") return false;
      // `enable: true` marks an explicit turn-on (initial publish, the camera
      // button). Every other caller — congestion stepping, network-tier
      // change, quality cycling — must respect a camera the user switched OFF:
      // silently flipping it back on mid-call would be a privacy shock. In
      // that case we only remember the tier for when they next turn it on.
      if (opts?.enable) camIntentRef.current = true;
      else if (!camIntentRef.current) {
        captureTierRef.current = tier;
        return false;
      }
      tierBusyRef.current = true;
      try {
        const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        // A live track has to be stopped before it can be re-captured at new
        // constraints (setCameraEnabled with a live track only unmutes).
        if (pub) await room.localParticipant.setCameraEnabled(false);
        await room.localParticipant.setCameraEnabled(
          true,
          { resolution: plan.resolution, frameRate: plan.frameRate },
          { videoEncoding: plan.encoding, simulcast: true },
        );
        captureTierRef.current = tier;
        setCamQuality(plan.label);
        return true;
      } catch {
        /* keep the current capture on failure */
        return false;
      } finally {
        tierBusyRef.current = false;
      }
    },
    [],
  );

  /** The tier this device should capture at right now, per mode + network. */
  const desiredTier = useCallback((): number => {
    const mode = camModeRef.current;
    if (mode === "auto") return netCeilingTier();
    return TIER_OF_MODE[mode];
  }, []);

  /**
   * Follow the Network Information API (Chrome/Android; no-op elsewhere):
   * when the effective tier changes mid-call, re-capture to match — both
   * directions. Congestion that the API doesn't report is handled by the
   * per-call quality sampler in connectMedia.
   */
  const adaptToNetwork = useCallback(async () => {
    if (camModeRef.current !== "auto") return;
    const room = roomRef.current;
    if (!room || tierBusyRef.current) return;
    const tier = netCeilingTier();
    if (tier !== captureTierRef.current) await captureCameraAt(tier);
  }, [captureCameraAt]);

  useEffect(() => {
    const conn = netConn();
    if (!conn?.addEventListener) return;
    const onNetChange = () => void adaptToNetwork();
    conn.addEventListener("change", onNetChange);
    return () => conn.removeEventListener?.("change", onNetChange);
  }, [adaptToNetwork]);

  /**
   * Cycle quality: auto -> 480p -> 720p -> 1080p -> auto. A fixed cap is a
   * hard ceiling — good for metered/flaky "fast" links and low-end phones;
   * back to "auto" resumes network + congestion adaptation.
   */
  const cycleQuality = useCallback(() => {
    const next = CAM_CYCLE[(CAM_CYCLE.indexOf(camModeRef.current) + 1) % CAM_CYCLE.length];
    camModeRef.current = next;
    saveCamMode(next);
    const room = roomRef.current;
    const s = sessionRef.current;
    if (!room || !s || s.phase !== "active") return; // applied on next call
    const target = desiredTier();
    if (target !== captureTierRef.current) void captureCameraAt(target);
  }, [captureCameraAt, desiredTier]);

  /**
   * Application-level rejoin loop ("never drop the call"). Called when a
   * media connect fails transiently (dead link during ring/answer) or when
   * LiveKit fully disconnects (server restart / room closed). It keeps
   * retrying the SAME call with capped backoff while the session is still
   * alive; hangup, the peer ending the call, or teardown cancels it through
   * connectGenRef. Every attempt mints a fresh LiveKit token, so long calls
   * can never outlive a token's TTL either.
   */
  const scheduleConnectRetry = useCallback(
    (callId: Id<"calls">, kind: CallKind) => {
      if (!token) return;
      const gen = connectGenRef.current;
      const delay = connRetryDelayRef.current;
      connRetryDelayRef.current = Math.min(connRetryDelayRef.current * 1.8, 20_000);
      if (connectTimerRef.current != null) window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = window.setTimeout(() => {
        connectTimerRef.current = null;
        if (connectGenRef.current !== gen) return;
        void (async () => {
          const s = sessionRef.current;
          if (!s || s.callId !== callId) return;
          if (s.phase !== "active" && s.phase !== "outgoing") return;
          const res = await connectMediaRef.current(callId, kind, {
            restoreState: s.phase === "active",
          });
          if (connectGenRef.current !== gen) return; // torn down mid-attempt
          if (res === true) {
            connRetryDelayRef.current = 1500;
            setReconnecting(false);
            setError(null);
            return;
          }
          if (res === "unauthorized" || res === "livekit_not_configured") {
            // Permanent failure (server config/credentials): end for real and
            // surface the reason (e.g. missing LiveKit keys) to the user.
            const cur = sessionRef.current;
            if (cur && cur.callId === callId) {
              setError(res);
              try {
                await endCallMut({
                  callId,
                  token,
                  status: cur.phase === "active" ? "ended" : "declined",
                });
              } catch {
                /* noop */
              }
              cleanup();
            }
            return;
          }
          // Transient: the call stays up, try again with more backoff.
          scheduleConnectRetry(callId, kind);
        })();
      }, delay);
    },
    [cleanup, endCallMut, token],
  );

  // ---- Connect to a LiveKit room for a call ----
  const connectMedia = useCallback(
    async (
      callId: Id<"calls">,
      kind: CallKind,
      opts?: { restoreState?: boolean },
    ): Promise<ConnectResult> => {
      if (!token) return "retryable";
      // Already connected to this call's room (e.g. a scheduled retry that
      // fired just after another path reconnected)? Don't connect twice —
      // LiveKit would kick the older identity connection.
      const liveRoom = roomRef.current;
      if (liveRoom && liveRoom.state === ConnectionState.Connected) return true;
      let room: Room | null = null;
      try {
        const { url, token: jwt } = await withTimeout(
          getToken({ token, callId }),
          20_000,
          "token_timeout",
        );
        // A fresh call starts at the tier its network class allows; a REJOIN
        // keeps whatever tier congestion had already settled on, so recovering
        // from a dead spot doesn't burst back to full quality and freeze again.
        const startTier = opts?.restoreState ? captureTierRef.current : desiredTier();
        captureTierRef.current = startTier;
        setCamQuality(CAM_TIERS[startTier].label);
        room = new Room({
          adaptiveStream: true,
          dynacast: true,
          publishDefaults: {
            videoCodec: "vp8",
            // Opus resilience for phone networks: RED re-sends lost audio
            // frames and DTX saves bandwidth during silence. Both keep voice
            // intelligible on flaky mobile links.
            red: true,
            dtx: true,
            // Three spatial layers (q/h/f). The SFU then forwards only what a
            // given receiver's link can carry — a weak connection gets a
            // smaller-but-moving picture instead of frozen full-res frames.
            simulcast: true,
            videoEncoding: CAM_TIERS[startTier].encoding,
          },
          videoCaptureDefaults: {
            resolution: CAM_TIERS[startTier].resolution,
            frameRate: CAM_TIERS[startTier].frameRate,
          },
          audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          // NEVER give up: an unbounded reconnect policy with capped, jittered
          // backoff keeps retrying while the tab is alive, so a call that hits
          // a dead spot (tunnel, elevator, dropped cell signal, ISP outage)
          // resumes automatically whenever the network returns — even minutes
          // later — instead of dying after the default ~10 attempts. Each
          // attempt is bounded by LiveKit's own websocket/peer timeouts, so a
          // half-open link can't wedge the loop. Real teardown (hangup, peer
          // ended the call) still ends it: teardown() disconnects the room.
          reconnectPolicy: {
            nextRetryDelayInMs: (ctx) =>
              Math.min(2_000 * Math.pow(1.5, Math.min(ctx.retryCount, 10)), 20_000) +
              Math.floor(Math.random() * 2_000),
          },
        });
        // Register ref BEFORE connecting so early events find it.
        roomRef.current = room;
        const r: Room = room; // stable, narrowed handle for the handlers below

        room.on(RoomEvent.LocalTrackPublished, (publication) => {
          if (roomRef.current !== r) return;
          if (publication.source === Track.Source.Camera) {
            setLocal(one(publication.track?.mediaStreamTrack));
            // Keep the UI state in sync with the publication even when the
            // track was enabled outside toggleCam (right after the room
            // connects) or re-published muted after a reconnect.
            setCamOn(!publication.isMuted);
          } else if (publication.source === Track.Source.ScreenShare) {
            setScreenLocal(one(publication.track?.mediaStreamTrack));
          } else if (publication.source === Track.Source.Microphone) {
            setMicOn(!publication.isMuted);
          }
        });
        room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
          if (roomRef.current !== r) return;
          if (publication.source === Track.Source.Camera) setLocal(null);
          else if (publication.source === Track.Source.ScreenShare) setScreenLocal(null);
        });
        room.on(RoomEvent.TrackSubscribed, (track, publication) => {
          if (roomRef.current !== r) return;
          if (publication.source === Track.Source.Microphone) {
            micTrackRef.current = track.mediaStreamTrack;
            setRemoteMicOn(!publication.isMuted);
            const audio = track.attach() as HTMLAudioElement;
            audio.autoplay = true;
            audio.setAttribute("playsinline", "true");
            audio.volume = speakerOn ? 1 : 0;
            document.body.appendChild(audio);
            remoteAudioElsRef.current.add(audio);
          } else if (publication.source === Track.Source.Camera) {
            camTrackRef.current = track.mediaStreamTrack;
            setRemoteCamOn(!publication.isMuted);
          } else if (publication.source === Track.Source.ScreenShare) {
            screenTrackRef.current = track.mediaStreamTrack;
            setScreenRemote(one(track.mediaStreamTrack));
          }
          rebuildRemote();
        });
        room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
          if (roomRef.current !== r) return;
          if (publication.source === Track.Source.Microphone) {
            track.detach().forEach((element) => {
              remoteAudioElsRef.current.delete(element as HTMLAudioElement);
              element.remove();
            });
            micTrackRef.current = null;
            setRemoteMicOn(true);
          } else if (publication.source === Track.Source.Camera) {
            camTrackRef.current = null;
            setRemoteCamOn(true);
          } else if (publication.source === Track.Source.ScreenShare) {
            screenTrackRef.current = null;
            setScreenRemote(null);
          }
          rebuildRemote();
        });
        // Only remote track mutes matter here. Our own mute/unmute must never
        // flip the partner's badges (this was previously a timing guess and
        // could misfire whenever a re-capture took longer than 500ms).
        const isLocalPub = (publication: TrackPublication) =>
          r.localParticipant.getTrackPublications().includes(publication);
        room.on(RoomEvent.TrackMuted, (publication) => {
          if (roomRef.current !== r || isLocalPub(publication)) return;
          if (publication.source === Track.Source.Camera) setRemoteCamOn(false);
          else if (publication.source === Track.Source.Microphone) setRemoteMicOn(false);
        });
        room.on(RoomEvent.TrackUnmuted, (publication) => {
          if (roomRef.current !== r || isLocalPub(publication)) return;
          if (publication.source === Track.Source.Camera) setRemoteCamOn(true);
          else if (publication.source === Track.Source.Microphone) setRemoteMicOn(true);
        });
        // LiveKit scores the remote peer's link to us (their uplink -> SFU ->
        // us) every few seconds. Surface a sustained poor reading so the UI
        // can explain why their picture is blurry/frozen instead of leaving
        // the caller to blame their own phone.
        room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
          if (roomRef.current !== r) return;
          if (!participant || participant === r.localParticipant) return;
          setRemotePoor(quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost);
        });
        room.on(RoomEvent.Reconnecting, () => {
          if (roomRef.current !== r) return;
          setReconnecting(true);
        });
        room.on(RoomEvent.Reconnected, () => {
          if (roomRef.current !== r) return;
          setReconnecting(false);
        });
        // A FULL disconnect — server restarted / closed the room, or the
        // socket was down so long the SFU dropped us. This must NOT end the
        // call: while the Convex row is still ringing/active (nobody hung up)
        // we rejoin the room in the background and keep the overlay alive.
        // The per-room guard makes stale rooms inert.
        room.on(RoomEvent.Disconnected, () => {
          if (roomRef.current !== r) return;
          const s = sessionRef.current;
          const keepAlive = s && (s.phase === "active" || s.phase === "outgoing");
          roomRef.current = null;
          clearQualityWatch();
          if (!keepAlive) {
            cleanup();
            setError("connection_lost");
            return;
          }
          // Forget the dead room's media; the rejoin re-publishes exactly
          // what the user still has enabled (mic/camera intents below).
          micTrackRef.current = null;
          camTrackRef.current = null;
          screenTrackRef.current = null;
          remoteAudioElsRef.current.forEach((el) => {
            el.pause();
            el.srcObject = null;
            el.remove();
          });
          remoteAudioElsRef.current.clear();
          setRemote(null);
          setScreenRemote(null);
          setScreenLocal(null);
          setLocal(null);
          setReconnecting(true);
          connRetryDelayRef.current = 1500;
          scheduleConnectRetry(s.callId, s.kind);
        });

        // Generous initial-connection budget for the slowest links: up to 45s
        // for the websocket + DTLS/ICE dance, with roomier per-step timeouts.
        // A failure is classified as "retryable" and handed to the rejoin
        // loop rather than killing the call.
        await withTimeout(
          r.connect(url, jwt, {
            maxRetries: 5,
            websocketTimeout: 20_000,
            peerConnectionTimeout: 25_000,
          }),
          45_000,
          "connect_timeout",
        );

        // iOS/Safari gate media playback behind a user gesture; startAudio()
        // resumes the playback context (harmless elsewhere, and needed so the
        // callee actually hears the caller after tapping "پاسخ").
        try {
          await r.startAudio();
        } catch {
          /* noop */
        }

        // A hangup / peer-end / teardown can land while this attempt was in
        // flight. Check BEFORE publishing so a stale attempt never flashes
        // the mic/camera on for a call that is no longer this device's call.
        if (sessionRef.current?.callId !== callId) {
          try {
            r.disconnect();
          } catch {
            /* noop */
          }
          if (roomRef.current === r) roomRef.current = null;
          return "retryable";
        }

        // Publish mic always, camera for video calls — at the tier chosen for
        // this connection. A fresh call starts with camera+mic on; a REJOIN
        // (restoreState) publishes only what the user still has enabled, so a
        // mute or a switched-off camera from mid-call is honored after an
        // automatic reconnection instead of startling the other side.
        const restore = opts?.restoreState === true;
        const enableMic = restore ? micIntentRef.current : true;
        const enableCam = restore ? camIntentRef.current : kind === "video";
        if (enableMic) micIntentRef.current = true;
        await Promise.allSettled([
          kind === "video" && enableCam
            ? captureCameraAt(startTier, { enable: true })
            : kind === "video" && restore
              ? r.localParticipant.setCameraEnabled(false)
              : Promise.resolve(),
          r.localParticipant.setMicrophoneEnabled(enableMic),
        ]);

        // Measured-quality sampler (LiveKit estimates connection quality from
        // real loss/jitter every few seconds — more honest than the coarse
        // Network Information API). In auto mode, 2 consecutive poor samples
        // (~10s) step the camera down a tier so the SFU keeps video flowing to
        // the other side; 6 consecutive good samples (~30s of a healthy link)
        // step it back up. Sampling is interval-driven because LiveKit only
        // *emits* quality change events — a steady "poor" would otherwise
        // never re-trigger.
        qualityWatchRef.current = window.setInterval(() => {
          if (roomRef.current !== r) {
            clearQualityWatch();
            return;
          }
          if (r.state !== ConnectionState.Connected) return;
          if (camModeRef.current !== "auto") return;
          if (sessionRef.current?.kind !== "video") return;
          const q = r.localParticipant.connectionQuality;
          const c = qualityCountsRef.current;
          if (q === ConnectionQuality.Poor || q === ConnectionQuality.Lost) {
            c.poor += 1;
            c.good = 0;
            // Downgrade fast (2 poor readings ≈ 10s): on a collapsing link a
            // smaller-but-moving picture beats a frozen full-res one.
            if (c.poor >= 2 && captureTierRef.current > 0) {
              c.poor = 0;
              void captureCameraAt(captureTierRef.current - 1);
            }
          } else {
            c.good += 1;
            c.poor = 0;
            // Upgrade slowly (6 good readings ≈ 30s of a healthy link) and
            // never past the ceiling the current network class allows.
            const ceiling = netCeilingTier();
            if (c.good >= 6 && captureTierRef.current < ceiling) {
              c.good = 0;
              void captureCameraAt(captureTierRef.current + 1);
            }
          }
        }, 5_000);

        setError(null);
        return true;
      } catch (e) {
        clearQualityWatch();
        if (room && roomRef.current === room) roomRef.current = null;
        try {
          room?.disconnect();
        } catch {
          /* noop */
        }
        // Classify: config/permission problems are permanent; everything else
        // (timeouts, dead sockets, media failures) is retryable — the rejoin
        // loop keeps the call alive through transient outages.
        const msg = e instanceof Error ? e.message : "";
        if (msg === "livekit_not_configured" || msg === "unauthorized") return msg;
        return "retryable";
      }
    },
    [
      captureCameraAt,
      cleanup,
      clearQualityWatch,
      desiredTier,
      getToken,
      rebuildRemote,
      scheduleConnectRetry,
      speakerOn,
      token,
    ],
  );
  connectMediaRef.current = connectMedia;

  /**
   * Re-join a call that has no live screen on this device yet: the app was
   * (re)loaded while the call was ringing or already active. Starts a media
   * connect for the given call and keeps the session/overlay consistent.
   * Used only from the lifecycle reconcile below, which itself only fires
   * when there is NO current session, so it can't race startCall/accept.
   */
  const joinResume = useCallback(
    (call: CallRow, phase: "outgoing" | "active") => {
      if (!token) return; // the reconcile only runs when a token exists
      setReconnecting(phase === "active");
      // A start/accept/hangup owns the UI right now: hand the rejoin to the
      // retry loop instead of racing it (and never leave the overlay stuck).
      if (busyRef.current) {
        scheduleConnectRetry(call.callId, call.kind);
        return;
      }
      void (async () => {
        const res = await connectMediaRef.current(call.callId, call.kind, {
          restoreState: phase === "active",
        });
        const s = sessionRef.current;
        if (!s || s.callId !== call.callId) return; // user moved on meanwhile
        if (res === true) {
          setReconnecting(false);
          setError(null);
        } else if (res === "unauthorized" || res === "livekit_not_configured") {
          // Permanent failure (server config/credentials): end for real and
          // surface the reason.
          setError(res);
          try {
            await endCallMut({
              callId: call.callId,
              token,
              status: phase === "active" ? "ended" : "declined",
            });
          } catch {
            /* noop */
          }
          cleanup();
        } else {
          // Transient: keep the call up and rejoin in the background.
          setReconnecting(phase === "active");
          scheduleConnectRetry(call.callId, call.kind);
        }
      })();
    },
    [cleanup, endCallMut, scheduleConnectRetry, token],
  );
  const joinResumeRef = useRef(joinResume);
  joinResumeRef.current = joinResume;

  // ---- Reconcile call lifecycle from Convex ----
  // How long a ringing call is allowed to sit unanswered before it's treated
  // as missed. Real timers (not query-driven checks): the Convex row never
  // changes while a call rings unanswered, so a check gated on query updates
  // would never fire and both screens would ring forever.
  const RING_TTL = 45_000;
  const CALLER_RING_TTL = 60_000;

  useEffect(() => {
    if (!myCalls) return;
    if (!token) return; // myCalls is only defined when a token exists
    const cur = sessionRef.current;
    const curCall = cur?.callId;

    // The current session's call disappeared server-side (peer hung up, they
    // declined, or it was retired as stale): tear the local session down.
    if (cur && curCall && !myCalls.some((c) => c.callId === curCall)) {
      if (sawCallRef.current) cleanup();
      return;
    }
    const call = myCalls[0];
    if (!call) {
      if (cur && sawCallRef.current) cleanup();
      // Nothing ringing/active anymore — any "leave" intent is fulfilled.
      leaveRef.current = null;
      return;
    }
    sawCallRef.current = true;

    const ringing = call.status === "ringing";
    const isIncomingForMe = !call.initiatedByMe;
    const myPhase = cur?.phase ?? "idle";

    // ---- Ring lifecycle guards ----
    // These keep a ring honest when the screen that owns it is gone: a stale
    // ring must never resurrect on a later app open, and a second call
    // ringing in while we're already in one is declined instead of stacking.
    if (ringing && curCall !== call.callId) {
      const ttl = isIncomingForMe ? RING_TTL : CALLER_RING_TTL;
      const age = Date.now() - call.startedAt;
      // Already busy in another call (live session, or a still-active call
      // this screen will resume after a reload): politely decline so the
      // caller's phone stops ringing now instead of burning the full timeout.
      const hasLiveCall =
        !!cur || myCalls.some((c) => c.callId !== call.callId && c.status === "active");
      if (hasLiveCall) {
        void endCallMut({ callId: call.callId, token, status: "declined" });
        return;
      }
      // The ring outlived its screen (app closed / relaunched too late):
      // close it as missed so it can never resurrect on the next launch.
      if (age > ttl) {
        void endCallMut({ callId: call.callId, token, status: "missed" });
        return;
      }
      // The user already declined/hung up THIS call on this screen but the
      // end mutation hasn't landed yet (dead link): stay quiet until the row
      // disappears instead of ringing it back. Retry the end whenever the
      // subscription refreshes — cheap online, silent offline.
      const leave = leaveRef.current;
      if (leave && leave.callId === call.callId) {
        void endCallMut({ callId: call.callId, token, status: leave.wanted }).catch(() => {});
        return;
      }
      // My own outgoing ring with no live screen (the app was relaunched
      // while the call was still ringing): bring the ring back so the caller
      // can see/hear it connect when the other side answers. The missed-call
      // timer is re-armed with only the remaining TTL.
      if (!isIncomingForMe && !cur) {
        setSession({
          callId: call.callId,
          phase: "outgoing",
          kind: call.kind,
          otherName: call.otherName,
          otherColor: call.otherColor,
          initiatedByMe: true,
        });
        if (ringTtlRef.current == null) {
          const remain = Math.max(500, ttl - age);
          ringTtlRef.current = window.setTimeout(() => {
            const s = sessionRef.current;
            if (!s || s.callId !== call.callId || s.phase !== "outgoing") return;
            // Mark this ring as over locally BEFORE the end mutation: if it
            // fails on a dead link, don't re-present the call every re-render.
            leaveRef.current = { callId: call.callId, wanted: "missed" };
            void endCallMut({ callId: call.callId, token, status: "missed" });
            cleanup();
          }, remain);
        }
        joinResumeRef.current(call, "outgoing");
        return;
      }
      // Fresh incoming ring with no busy call: fall through and present it.
    }

    // A brand-new unanswered incoming ring: present it and arm the missed-call
    // timer (only when the ring first appears, not on every query re-delivery).
    if (isIncomingForMe && ringing && myPhase === "idle") {
      setSession({
        callId: call.callId,
        phase: "incoming",
        kind: call.kind,
        otherName: call.otherName,
        otherColor: call.otherColor,
        initiatedByMe: false,
      });
      startRing();
      if (ringTtlRef.current == null) {
        ringTtlRef.current = window.setTimeout(() => {
          const s = sessionRef.current;
          if (!s || s.callId !== call.callId || s.phase !== "incoming") return;
          // Mark this ring as over locally BEFORE the end mutation: if it
          // fails on a dead link, don't re-ring it on the next re-render.
          leaveRef.current = { callId: call.callId, wanted: "missed" };
          void endCallMut({ callId: call.callId, token, status: "missed" });
          cleanup();
        }, RING_TTL);
      }
      return;
    }

    // I was in an ACTIVE call and the app was (re)loaded while it was still
    // live — nobody is ringing, we just need to rejoin the room and show the
    // overlay again instead of stranding the other side in silence. Skipped
    // when the user just hung up (leaveRef) — instead the end mutation is
    // retried until the row actually dies.
    if (call.status === "active" && !cur) {
      const leave = leaveRef.current;
      if (leave && leave.callId === call.callId) {
        void endCallMut({ callId: call.callId, token, status: "ended" }).catch(() => {});
        return;
      }
      setSession({
        callId: call.callId,
        phase: "active",
        kind: call.kind,
        otherName: call.otherName,
        otherColor: call.otherColor,
        initiatedByMe: call.initiatedByMe,
      });
      setReconnecting(true);
      joinResumeRef.current(call, "active");
      return;
    }

    // The callee answered our outgoing call: flip to the active phase.
    if (!isIncomingForMe && call.status === "active" && cur?.phase === "outgoing") {
      stopRing();
      clearRingTtl();
      setSession({ ...cur, phase: "active" });
    }
  }, [myCalls, cleanup, startRing, stopRing, clearRingTtl, endCallMut, token]);

  const startCall = useCallback(
    async (
      conversationId: Id<"conversations">,
      otherId: Id<"users">,
      otherName: string,
      otherColor: string,
      kind: CallKind,
    ) => {
      // Re-entrancy guard: a double-tap on the call button must never create
      // two calls / two LiveKit rooms.
      if (!token || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await primeMedia(kind);
        if (sessionRef.current) cleanup();
        let callId: Id<"calls">;
        try {
          callId = await startCallMut({ conversationId, token, kind });
        } catch {
          return;
        }
        setSession({ callId, phase: "outgoing", kind, otherId, otherName, otherColor, initiatedByMe: true });
        sawCallRef.current = false;
        // A new call means any earlier "leave" intent is obsolete.
        leaveRef.current = null;
        // Ring every other device even if the app is closed there. Fire and
        // forget — a push failure must never block the call itself. The
        // server derives the callees from the call's participants.
        void notifyIncoming({ token, callId, kind }).catch(() => {});
        // If no one answers, hang up on our own after a while (a real timer —
        // see RING_TTL note above). Guarded so it can't touch an active call.
        if (ringTtlRef.current == null) {
          ringTtlRef.current = window.setTimeout(() => {
            const s = sessionRef.current;
            if (!s || s.callId !== callId || s.phase !== "outgoing") return;
            // Ring timed out with nobody answering — mark it over locally so
            // a failed end mutation can't re-present it on the next render.
            leaveRef.current = { callId, wanted: "missed" };
            void endCallMut({ callId, token, status: "missed" });
            cleanup();
          }, CALLER_RING_TTL);
        }
        const res = await connectMedia(callId, kind);
        if (res === true) return; // media live; the effect flips phase on answer
        if (res === "unauthorized" || res === "livekit_not_configured") {
          setError(res);
          try {
            await endCallMut({ callId, token, status: "declined" });
          } catch {
            /* noop */
          }
          cleanup();
          return;
        }
        // Transient failure (dead link): keep the ring alive and rejoin in
        // the background — the call must survive the caller's own dead spot.
        scheduleConnectRetry(callId, kind);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [
      cleanup,
      connectMedia,
      endCallMut,
      notifyIncoming,
      primeMedia,
      scheduleConnectRetry,
      startCallMut,
      token,
    ],
  );

  const accept = useCallback(async () => {
    // Re-entrancy guard: repeated taps while getUserMedia/LiveKit connect are
    // in flight must not answer twice or spawn parallel rooms.
    if (busyRef.current) return;
    const s = sessionRef.current;
    if (!s || !token) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await primeMedia(s.kind);
      stopRing();
      // The user responded, so the ring no longer needs a missed-call timer.
      clearRingTtl();
      try {
        await answerCallMut({ callId: s.callId, token });
      } catch {
        /* noop */
      }
      const res = await connectMedia(s.callId, s.kind);
      if (res === true) {
        setSession({ ...s, phase: "active" });
      } else if (res === "unauthorized" || res === "livekit_not_configured") {
        setError(res);
        try {
          await endCallMut({ callId: s.callId, token, status: "ended" });
        } catch {
          /* noop */
        }
        cleanup();
      } else {
        // The call is answered and alive — keep the active overlay up and
        // rejoin in the background instead of dropping the callee.
        setSession({ ...s, phase: "active" });
        setReconnecting(true);
        scheduleConnectRetry(s.callId, s.kind);
      }
    } finally {
      // Always released — the timeout wrapper above guarantees the promise
      // settles, so the accept button can never stay permanently disabled.
      busyRef.current = false;
      setBusy(false);
    }
  }, [
    answerCallMut,
    cleanup,
    clearRingTtl,
    connectMedia,
    endCallMut,
    primeMedia,
    scheduleConnectRetry,
    stopRing,
    token,
  ]);

  const decline = useCallback(async () => {
    if (busyRef.current) return;
    const s = sessionRef.current;
    if (!s || !token) return;
    busyRef.current = true;
    setBusy(true);
    try {
      stopRing();
      // Remember this call as "user left" BEFORE the end mutation resolves:
      // if it fails on a dead link the reconcile must not re-present the ring.
      leaveRef.current = { callId: s.callId, wanted: "declined" };
      try {
        await endCallMut({ callId: s.callId, token, status: "declined" });
      } catch {
        /* noop */
      }
      cleanup();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [cleanup, endCallMut, stopRing, token]);

  const hangup = useCallback(async () => {
    if (busyRef.current) return;
    const s = sessionRef.current;
    if (!s || !token) return;
    busyRef.current = true;
    setBusy(true);
    try {
      stopRing();
      const wasActive = s.phase === "active";
      // Remember this call as "user left": if the end mutation fails (dead
      // link) the reconcile must not auto-rejoin a call they just hung up.
      leaveRef.current = { callId: s.callId, wanted: wasActive ? "ended" : "declined" };
      try {
        await endCallMut({ callId: s.callId, token, status: wasActive ? "ended" : "declined" });
      } catch {
        /* noop */
      }
      cleanup();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [cleanup, endCallMut, stopRing, token]);

  // ---- Controls (routed through LiveKit) ----
  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micOn;
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
    } catch {
      /* noop */
    }
    micIntentRef.current = next;
    setMicOn(next);
  }, [micOn]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !camOn;
    if (!next) {
      camIntentRef.current = false;
      try {
        await room.localParticipant.setCameraEnabled(false);
      } catch {
        /* noop */
      }
      setCamOn(false);
      return;
    }
    // Turning back on: (re)capture at the tier the current quality mode /
    // network dictates instead of the stale room defaults. captureCameraAt
    // records the intent; the LocalTrackPublished event flips camOn when the
    // track actually goes live.
    camIntentRef.current = true;
    if (await captureCameraAt(desiredTier(), { enable: true })) {
      setCamOn(true);
    } else {
      // Couldn't publish (permission, no camera, capture already busy) — keep
      // the switch state honest instead of showing a camera that isn't on.
      camIntentRef.current = false;
    }
  }, [camOn, captureCameraAt, desiredTier]);

  const switchCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");
      if (cams.length < 2) return;
      const idx = cams.findIndex((d) => d.deviceId === lastCamIdRef.current);
      const next = cams[(idx + 1) % cams.length];
      lastCamIdRef.current = next.deviceId;
      await room.switchActiveDevice("videoinput" as MediaDeviceKind, next.deviceId);
    } catch {
      /* noop */
    }
  }, []);

  const toggleShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !sharing;
    try {
      await room.localParticipant.setScreenShareEnabled(next, undefined, {
        // Screen sharing is the hungriest thing on the link; publishing it
        // without a cap could starve voice/video on a weak uplink. No capture
        // resolution is requested on purpose: on Safari 17 specifying a
        // resolution makes getDisplayMedia capture even lower than asked.
        simulcast: false,
        screenShareEncoding: { maxBitrate: 1_500_000, maxFramerate: 15 },
      });
      setSharing(next);
    } catch {
      /* noop */
    }
  }, [sharing]);

  const toggleSpeaker = useCallback(() => {
    setSpeakerOn((current) => {
      const next = !current;
      remoteAudioElsRef.current.forEach((el) => {
        el.volume = next ? 1 : 0;
      });
      return next;
    });
  }, []);

  return {
    session,
    startCall,
    accept,
    decline,
    hangup,
    toggleMic,
    toggleCam,
    switchCamera,
    toggleShare,
    toggleSpeaker,
    micOn,
    camOn,
    speakerOn,
    sharing,
    remoteMicOn,
    remoteCamOn,
    local,
    remote,
    screenLocal,
    screenRemote,
    error,
    busy,
    reconnecting,
    camQuality,
    remotePoor,
    cycleQuality,
  };
}
