import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
// livekit-client is imported lazily (see livekitLoader) so the app shell
// never has to download it — it only loads once a call actually starts.
import type { Room, TrackPublication, VideoEncoding } from "livekit-client";
import { livekit, loadLiveKit } from "./livekitLoader";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

export type CallPhase = "idle" | "outgoing" | "incoming" | "active";
export type CallKind = "audio" | "video";

/** One other person on/being rung for a call (me excluded). */
export interface CallPeer {
  userId: Id<"users">;
  displayName: string;
  themeColor: string;
  /** True once they answered and are in the media room. */
  joined: boolean;
}

export interface CallSession {
  callId: Id<"calls">;
  phase: CallPhase;
  kind: CallKind;
  initiatedByMe: boolean;
  /**
   * I was rung for a call that is ALREADY ACTIVE (someone else answered):
   * this screen offers "join", it does not ring like a fresh incoming call.
   */
  joinOffer: boolean;
  /** The person who started the call (who the incoming ring names). */
  callerId?: Id<"users">;
  callerName: string;
  callerColor: string;
  /** Everyone else in the conversation/call with their join state. */
  peers: CallPeer[];
}

/** One remote participant's live media, keyed by their user id. */
export interface RemotePeer {
  userId: string;
  displayName: string;
  themeColor: string;
  mic: MediaStream | null;
  cam: MediaStream | null;
  screen: MediaStream | null;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  /** LiveKit scored their uplink to us as poor. */
  poor: boolean;
}

export interface GarmaCallkit {
  session: CallSession | null;
  startCall: (
    conversationId: Id<"conversations">,
    kind: CallKind,
    peers: CallPeer[],
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
  /** True while the browser's share picker/capture is in flight. */
  shareStarting: boolean;
  /** Human-readable (Persian) screen-share failure, if the last attempt failed. */
  shareError: string | null;
  clearShareError: () => void;
  local: MediaStream | null;
  screenLocal: MediaStream | null;
  /** Live remote participants (in the media room, tracks flowing or muted). */
  remotes: RemotePeer[];
  error: string | null;
  /** True while an accept/decline/hangup/start mutation is in flight. */
  busy: boolean;
  /** True while LiveKit is re-establishing a dropped connection. */
  reconnecting: boolean;
  /** Active camera tier label ("1080p" / "720p" / "480p"). */
  camQuality: string | null;
  /** Cycle the camera quality between automatic and a fixed cap. */
  cycleQuality: () => void;
}

type CallRow = {
  callId: Id<"calls">;
  conversationId: Id<"conversations">;
  kind: CallKind;
  status: "ringing" | "active" | "ended" | "declined" | "missed";
  initiatorId: Id<"users">;
  startedAt: number;
  initiatedByMe: boolean;
  acceptedByMe: boolean;
  caller: { userId: Id<"users">; displayName: string; themeColor: string } | null;
  peers: CallPeer[];
  /**
   * Legacy (pre-group) backend rows named the other participant directly and
   * had no `peers`/`caller`/`acceptedByMe`. During a rolling deploy the
   * backend can answer with either shape for a while — the client must never
   * crash on the old one (a hard crash unmounts React and leaves the phone
   * on a black screen). Everything below reads rows only through the
   * normalizers, which synthesize a single peer from the legacy fields.
   */
  otherName?: string;
  otherColor?: string;
};

/** A valid, non-empty peer list for a call row (never undefined, never empty
 * when the legacy fields name someone). */
function peersOf(call: CallRow): CallPeer[] {
  if (Array.isArray(call.peers) && call.peers.length > 0) return call.peers;
  if (call.otherName) {
    return [
      {
        // Legacy rows carry no id for the other person; an empty id just
        // means media lookups never match it (avatar-only UI shows fine).
        userId: (call.caller?.userId ?? "") as Id<"users">,
        displayName: call.otherName,
        themeColor: call.otherColor ?? "#8a6340",
        // The old backend had no per-participant join state — an active row
        // meant the other side had picked up.
        joined: call.status === "active",
      },
    ];
  }
  return [];
}

/** The person this row is about, across both backend shapes. */
function callerOf(call: CallRow): { userId: Id<"users">; displayName: string; themeColor: string } | null {
  if (call.caller) return call.caller;
  // Old rows only name the other participant; from the callee's side that
  // other person IS the caller.
  if (!call.initiatedByMe && call.otherName) {
    return {
      userId: ("" as Id<"users">),
      displayName: call.otherName,
      themeColor: call.otherColor ?? "#8a6340",
    };
  }
  return null;
}

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

/**
 * Dismiss the OS "incoming call" notification for a call (the one the service
 * worker showed while the app was closed/backgrounded) once this screen has
 * answered, declined or left it — otherwise it stays pinned in the tray and
 * looks like the phone is still ringing.
 */
async function closeCallNotification(callId: string) {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const notifs = await reg.getNotifications({ tag: `incoming-call-${callId}` });
    for (const n of notifs) n.close();
  } catch {
    /* noop */
  }
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
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [shareStarting, setShareStarting] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [camQuality, setCamQuality] = useState<string | null>(null);
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [screenLocal, setScreenLocal] = useState<MediaStream | null>(null);

  const roomRef = useRef<Room | null>(null);
  const lastCamIdRef = useRef<string>("");
  const busyRef = useRef(false);
  const shareBusyRef = useRef(false);
  const sawCallRef = useRef(false);
  const ringRef = useRef<AudioContext | null>(null);
  const ringTimerRef = useRef<number | null>(null);
  const ringVibrateTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // ---- Per-remote-participant media --------------------------------------
  // A call can have several remote participants now (group calls), each with
  // their own mic/camera/screen tracks. Keyed by LiveKit identity (== user
  // id); a version tick re-renders the snapshot below after any mutation.
  interface Part {
    userId: string;
    micEls: Set<HTMLAudioElement>;
    micStream: MediaStream | null;
    camStream: MediaStream | null;
    screenStream: MediaStream | null;
    micOn: boolean;
    camOn: boolean;
    screenOn: boolean;
    poor: boolean;
  }
  const partsRef = useRef<Map<string, Part>>(new Map());
  const [partsTick, setPartsTick] = useState(0);
  const commitParts = useCallback(() => setPartsTick((t) => t + 1), []);

  const partOf = useCallback((userId: string): Part => {
    let p = partsRef.current.get(userId);
    if (!p) {
      p = {
        userId,
        micEls: new Set(),
        micStream: null,
        camStream: null,
        screenStream: null,
        micOn: true,
        camOn: true,
        screenOn: false,
        poor: false,
      };
      partsRef.current.set(userId, p);
    }
    return p;
  }, []);

  const partNames = useMemo(() => {
    const map = new Map<string, { displayName: string; themeColor: string }>();
    if (session) {
      for (const p of session.peers) {
        map.set(p.userId, { displayName: p.displayName, themeColor: p.themeColor });
      }
    }
    return map;
  }, [session]);

  /** Snapshot of live remote media for the overlay, ordered by joined peers. */
  const remotes: RemotePeer[] = useMemo(() => {
    const joined = partsRef.current;
    const out: RemotePeer[] = [];
    for (const [userId, part] of joined) {
      const meta = partNames.get(userId) ?? { displayName: "…", themeColor: "#8a6340" };
      out.push({
        userId,
        displayName: meta.displayName,
        themeColor: meta.themeColor,
        mic: part.micStream,
        cam: part.camStream,
        screen: part.screenStream,
        micOn: part.micOn,
        camOn: part.camOn,
        screenOn: part.screenOn,
        poor: part.poor,
      });
    }
    // Stable-ish order: peers that are already on the call first (they matter
    // visually), then late joiners in arrival order.
    out.sort((a, b) => {
      const ja = session?.peers.find((p) => p.userId === a.userId)?.joined ? 0 : 1;
      const jb = session?.peers.find((p) => p.userId === b.userId)?.joined ? 0 : 1;
      if (ja !== jb) return ja - jb;
      return 0;
    });
    return out;
  }, [partsTick, partNames, session]);

  // ---- Adaptive camera quality state ----
  const camModeRef = useRef<CamMode>(loadCamMode());
  const captureTierRef = useRef<number>(CAM_TIERS.length - 1);
  const tierBusyRef = useRef(false);
  const camIntentRef = useRef(false);
  const micIntentRef = useRef(true);
  /** Whether THIS device is currently sharing its screen. */
  const sharingRef = useRef(false);
  const speakerOnRef = useRef(true);
  speakerOnRef.current = speakerOn;
  useEffect(() => {
    sharingRef.current = sharing;
  }, [sharing]);
  /**
   * The call this screen's user (or a local ring timeout) ended while its
   * server row is still ringing/active. The lifecycle reconcile below must
   * not re-present/re-join that call; the ref is cleared once the row
   * actually disappears from myCalls, and the end mutation is retried
   * whenever connectivity returns.
   */
  const leaveRef = useRef<{ callId: Id<"calls">; wanted: "ended" | "declined" | "missed" } | null>(null);
  // ---- App-level "never drop the call" machinery ----
  const connectGenRef = useRef(0); // bumped on teardown → invalidates retries
  const connectTimerRef = useRef<number | null>(null);
  const connRetryDelayRef = useRef(1500);
  const connectMediaRef = useRef<
    (callId: Id<"calls">, kind: CallKind, opts?: { restoreState?: boolean }) => Promise<ConnectResult>
  >(async () => "retryable");
  const ringTtlRef = useRef<number | null>(null);
  const qualityWatchRef = useRef<number | null>(null);
  const qualityCountsRef = useRef({ poor: 0, good: 0 });

  const startCallMut = useMutation(api.calls.start);
  const endCallMut = useMutation(api.calls.end);
  const answerCallMut = useMutation(api.calls.answer);
  const getToken = useAction(api.livekit.getToken);
  const notifyIncoming = useAction(api.push.notifyIncomingCall);

  const clearShareError = useCallback(() => setShareError(null), []);

  // Auto-dismiss call errors after a few seconds so a stale toast never
  // blocks the buttons underneath it.
  useEffect(() => {
    if (!error) return;
    const t = window.setTimeout(() => setError(null), 7000);
    return () => window.clearTimeout(t);
  }, [error]);

  /**
   * iOS/Safari only grant mic/camera if the request happens inside (or very
   * soon after) a user tap, before any slow network round-trips. We warm the
   * permission synchronously so the LiveKit connect that follows can't be
   * blocked, then release the tracks.
   */
  const primeMedia = useCallback(async (kind: CallKind) => {
    void loadLiveKit().catch(() => {});
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
    connectGenRef.current += 1;
    if (connectTimerRef.current != null) {
      window.clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    connRetryDelayRef.current = 1500;
    for (const part of partsRef.current.values()) {
      part.micEls.forEach((el) => {
        el.pause();
        el.srcObject = null;
        el.remove();
      });
      part.micEls.clear();
    }
    partsRef.current.clear();
    commitParts();
    clearRingTtl();
    clearQualityWatch();
    const room = roomRef.current;
    if (room) {
      roomRef.current = null;
      try {
        room.disconnect();
      } catch {
        /* noop */
      }
    }
    lastCamIdRef.current = "";
    setLocal(null);
    setScreenLocal(null);
    setMicOn(true);
    micIntentRef.current = true;
    setCamOn(false);
    camIntentRef.current = false;
    setSharing(false);
    sharingRef.current = false;
    setShareError(null);
    setShareStarting(false);
    setCamQuality(null);
    setReconnecting(false);
    qualityCountsRef.current = { poor: 0, good: 0 };
    setError(null);
    setSession(null);
  }, [clearQualityWatch, clearRingTtl, commitParts]);

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

  const cleanup = useCallback(() => {
    teardown();
    stopRing();
    sawCallRef.current = false;
  }, [teardown, stopRing]);

  /**
   * Classic analog-phone ring: a 440+480 Hz dual tone, rung for 2s then
   * paused for 4s — the cadence every real phone uses. Also vibrates.
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
   */
  const captureCameraAt = useCallback(
    async (tier: number, opts?: { enable?: boolean }): Promise<boolean> => {
      const room = roomRef.current;
      if (!room || tierBusyRef.current) return false;
      const { Track } = livekit();
      const plan = CAM_TIERS[tier];
      if (!plan) return false;
      if (sessionRef.current?.kind !== "video") return false;
      if (opts?.enable) camIntentRef.current = true;
      else if (!camIntentRef.current) {
        captureTierRef.current = tier;
        return false;
      }
      tierBusyRef.current = true;
      try {
        const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
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
        return false;
      } finally {
        tierBusyRef.current = false;
      }
    },
    [],
  );

  const desiredTier = useCallback((): number => {
    const mode = camModeRef.current;
    if (mode === "auto") return netCeilingTier();
    return TIER_OF_MODE[mode];
  }, []);

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
   * media connect fails transiently or when LiveKit fully disconnects.
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
      const LK = await loadLiveKit();
      const { Room, RoomEvent, Track, ConnectionQuality, ConnectionState } = LK;
      const liveRoom = roomRef.current;
      if (liveRoom && liveRoom.state === ConnectionState.Connected) return true;
      let room: Room | null = null;
      try {
        const { url, token: jwt } = await withTimeout(
          getToken({ token, callId }),
          20_000,
          "token_timeout",
        );
        const startTier = opts?.restoreState ? captureTierRef.current : desiredTier();
        captureTierRef.current = startTier;
        setCamQuality(CAM_TIERS[startTier].label);
        room = new Room({
          adaptiveStream: true,
          dynacast: true,
          publishDefaults: {
            videoCodec: "vp8",
            red: true,
            dtx: true,
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
          reconnectPolicy: {
            nextRetryDelayInMs: (rctx) =>
              Math.min(2_000 * Math.pow(1.5, Math.min(rctx.retryCount, 10)), 20_000) +
              Math.floor(Math.random() * 2_000),
          },
        });
        roomRef.current = room;
        const r: Room = room; // stable, narrowed handle for the handlers below

        room.on(RoomEvent.LocalTrackPublished, (publication) => {
          if (roomRef.current !== r) return;
          if (publication.source === Track.Source.Camera) {
            setLocal(one(publication.track?.mediaStreamTrack));
            setCamOn(!publication.isMuted);
          } else if (publication.source === Track.Source.ScreenShare) {
            setScreenLocal(one(publication.track?.mediaStreamTrack));
            setSharing(true);
            sharingRef.current = true;
          } else if (publication.source === Track.Source.Microphone) {
            setMicOn(!publication.isMuted);
          }
        });
        room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
          if (roomRef.current !== r) return;
          if (publication.source === Track.Source.Camera) setLocal(null);
          else if (publication.source === Track.Source.ScreenShare) {
            setScreenLocal(null);
            setSharing(false);
            sharingRef.current = false;
          }
        });

        room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (roomRef.current !== r) return;
          const uid = participant?.identity ?? "?";
          const part = partOf(uid);
          if (publication.source === Track.Source.Microphone) {
            part.micStream = new MediaStream([track.mediaStreamTrack]);
            part.micOn = !publication.isMuted;
            // Remote voice plays through a dedicated element (per person) —
            // video tiles stay muted so audio is never doubled/phasey.
            const audio = track.attach() as HTMLAudioElement;
            audio.autoplay = true;
            audio.setAttribute("playsinline", "true");
            audio.volume = speakerOnRef.current ? 1 : 0;
            document.body.appendChild(audio);
            part.micEls.add(audio);
          } else if (publication.source === Track.Source.Camera) {
            part.camStream = new MediaStream([track.mediaStreamTrack]);
            part.camOn = !publication.isMuted;
          } else if (publication.source === Track.Source.ScreenShare) {
            part.screenStream = new MediaStream([track.mediaStreamTrack]);
            part.screenOn = true;
          }
          commitParts();
        });
        room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
          if (roomRef.current !== r) return;
          const uid = participant?.identity ?? "?";
          const part = partOf(uid);
          if (publication.source === Track.Source.Microphone) {
            track.detach().forEach((element) => {
              part.micEls.delete(element as HTMLAudioElement);
              element.remove();
            });
            part.micStream = null;
            part.micOn = true;
          } else if (publication.source === Track.Source.Camera) {
            part.camStream = null;
            part.camOn = true;
          } else if (publication.source === Track.Source.ScreenShare) {
            part.screenStream = null;
            part.screenOn = false;
          }
          commitParts();
        });
        // Only remote track mutes matter here.
        const isLocalPub = (publication: TrackPublication) =>
          r.localParticipant.getTrackPublications().includes(publication);
        room.on(RoomEvent.TrackMuted, (publication, participant) => {
          if (roomRef.current !== r || isLocalPub(publication)) return;
          const part = partOf(participant?.identity ?? "?");
          if (publication.source === Track.Source.Camera) part.camOn = false;
          else if (publication.source === Track.Source.Microphone) part.micOn = false;
          commitParts();
        });
        room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
          if (roomRef.current !== r || isLocalPub(publication)) return;
          const part = partOf(participant?.identity ?? "?");
          if (publication.source === Track.Source.Camera) part.camOn = true;
          else if (publication.source === Track.Source.Microphone) part.micOn = true;
          commitParts();
        });
        // LiveKit scores each remote participant's link to us — a poor
        // reading explains why THEIR picture is blurry/frozen.
        room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
          if (roomRef.current !== r) return;
          if (!participant || participant === r.localParticipant) return;
          const part = partOf(participant.identity);
          part.poor = quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost;
          commitParts();
        });
        room.on(RoomEvent.Reconnecting, () => {
          if (roomRef.current !== r) return;
          setReconnecting(true);
        });
        room.on(RoomEvent.Reconnected, () => {
          if (roomRef.current !== r) return;
          setReconnecting(false);
        });
        // A FULL disconnect — server restarted / closed the room. This must
        // NOT end the call: while the Convex row is still ringing/active we
        // rejoin the room in the background and keep the overlay alive.
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
          for (const part of partsRef.current.values()) {
            part.micEls.forEach((el) => {
              el.pause();
              el.srcObject = null;
              el.remove();
            });
            part.micEls.clear();
            part.micStream = null;
            part.camStream = null;
            part.screenStream = null;
          }
          commitParts();
          setScreenLocal(null);
          setLocal(null);
          setReconnecting(true);
          connRetryDelayRef.current = 1500;
          scheduleConnectRetry(s.callId, s.kind);
        });

        await withTimeout(
          r.connect(url, jwt, {
            maxRetries: 5,
            websocketTimeout: 20_000,
            peerConnectionTimeout: 25_000,
          }),
          45_000,
          "connect_timeout",
        );

        try {
          await r.startAudio();
        } catch {
          /* noop */
        }

        if (sessionRef.current?.callId !== callId) {
          try {
            r.disconnect();
          } catch {
            /* noop */
          }
          if (roomRef.current === r) roomRef.current = null;
          return "retryable";
        }

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

        // Measured-quality sampler: in auto mode, 2 consecutive poor samples
        // (~10s) step the camera down a tier; 6 good ones step back up.
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
            if (c.poor >= 2 && captureTierRef.current > 0) {
              c.poor = 0;
              void captureCameraAt(captureTierRef.current - 1);
            }
          } else {
            c.good += 1;
            c.poor = 0;
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
        const msg = e instanceof Error ? e.message : "";
        if (msg === "livekit_not_configured" || msg === "unauthorized") return msg;
        return "retryable";
      }
    },
    [
      captureCameraAt,
      cleanup,
      clearQualityWatch,
      commitParts,
      desiredTier,
      getToken,
      partOf,
      scheduleConnectRetry,
      token,
    ],
  );
  connectMediaRef.current = connectMedia;

  /**
   * Re-join a call that has no live screen on this device yet: the app was
   * (re)loaded while the call was ringing or already active.
   */
  const joinResume = useCallback(
    (call: CallRow, phase: "outgoing" | "active") => {
      if (!token) return;
      setReconnecting(phase === "active");
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
  const RING_TTL = 45_000;
  const CALLER_RING_TTL = 60_000;

  /** Build the session object a screen should show for a given call row. */
  const sessionForRow = useCallback(
    (call: CallRow, phase: "outgoing" | "incoming" | "active", joinOffer = false): CallSession => {
      const caller = callerOf(call);
      return {
        callId: call.callId,
        phase,
        kind: call.kind,
        initiatedByMe: call.initiatedByMe,
        joinOffer,
        callerId: caller?.userId,
        callerName: caller?.displayName ?? "…",
        callerColor: caller?.themeColor ?? "#8a6340",
        peers: peersOf(call),
      };
    },
    [],
  );

  useEffect(() => {
    if (!myCalls) return;
    if (!token) return;
    const cur = sessionRef.current;
    const curCall = cur?.callId;

    // The current session's call disappeared server-side (peer hung up, they
    // declined, or it was retired as stale): tear the local session down.
    if (cur && curCall && !myCalls.some((c) => c.callId === curCall)) {
      void closeCallNotification(curCall);
      if (sawCallRef.current) cleanup();
      return;
    }

    // Keep a live session's caller/peer list in step with the server (new
    // people joining a group call, names, join states). Rows are normalized
    // so a legacy backend shape (no peers/caller) can never crash this — a
    // crash here unmounts React and leaves a black screen on the phone.
    if (cur && curCall) {
      const row = myCalls.find((c) => c.callId === curCall);
      if (row) {
        const rowCaller = callerOf(row);
        const rowPeers = peersOf(row);
        const changed =
          cur.callerName !== (rowCaller?.displayName ?? "…") ||
          cur.callerColor !== (rowCaller?.themeColor ?? "#8a6340") ||
          cur.peers.length !== rowPeers.length ||
          cur.peers.some(
            (p, i) => p.userId !== rowPeers[i]?.userId || p.joined !== rowPeers[i]?.joined,
          );
        // The callee answered our outgoing call: flip to the active phase.
        if (row.status === "active" && cur.phase === "outgoing") {
          stopRing();
          clearRingTtl();
          setSession({ ...cur, phase: "active", peers: rowPeers });
        } else if (
          row.status === "active" &&
          cur.phase === "incoming" &&
          !cur.initiatedByMe &&
          !cur.joinOffer
        ) {
          // Someone else answered the group call I was still ringing for:
          // stop ringing and offer a quiet join instead.
          stopRing();
          clearRingTtl();
          setSession({ ...cur, joinOffer: true, peers: rowPeers });
        }
        if (changed) {
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  callerName: rowCaller?.displayName ?? prev.callerName,
                  callerColor: rowCaller?.themeColor ?? prev.callerColor,
                  peers: rowPeers,
                }
              : prev,
          );
        }
      }
    }

    const call = myCalls[0];
    if (!call) {
      if (cur && sawCallRef.current) cleanup();
      if (curCall) void closeCallNotification(curCall);
      leaveRef.current = null;
      return;
    }
    sawCallRef.current = true;

    // ----- A DIFFERENT call than my current one is ringing me ----------
    if (cur && curCall !== call.callId) {
      if (call.status === "ringing") {
        // Busy (live session or another active call I must resume after a
        // reload): politely decline so the caller's phone stops ringing now.
        void endCallMut({ callId: call.callId, token, status: "declined" });
        return;
      }
      // An active join-offer for another call while I'm busy: ignore it here;
      // once my current call ends it will surface through the !cur branch.
      return;
    }
    if (cur) return; // my own call is being presented already

    // ----- No live screen: present whatever myCalls says is newest ---------
    const ringing = call.status === "ringing";
    const isIncomingForMe = !call.initiatedByMe;
    const age = Date.now() - call.startedAt;

    if (ringing) {
      const ttl = isIncomingForMe ? RING_TTL : CALLER_RING_TTL;
      // A ring that outlived its screen (app closed / relaunched too late):
      // close it as missed so it can never resurrect on the next launch.
      if (age > ttl) {
        leaveRef.current = { callId: call.callId, wanted: "missed" };
        void closeCallNotification(call.callId);
        void endCallMut({ callId: call.callId, token, status: "missed" }).catch(() => {});
        return;
      }
      // The user already declined/hung up THIS call on this screen but the
      // end mutation hasn't landed yet (dead link): stay quiet until the row
      // disappears instead of ringing it back.
      const leave = leaveRef.current;
      if (leave && leave.callId === call.callId) {
        void endCallMut({ callId: call.callId, token, status: leave.wanted }).catch(() => {});
        return;
      }
      // My own outgoing ring with no live screen (app relaunched while the
      // call was still ringing): bring the ring back so I can see it connect
      // when someone answers. Timer armed with only the remaining TTL.
      if (!isIncomingForMe) {
        setSession(sessionForRow(call, "outgoing"));          if (ringTtlRef.current == null) {
            const remain = Math.max(500, ttl - age);
            ringTtlRef.current = window.setTimeout(() => {
              const s = sessionRef.current;
              if (!s || s.callId !== call.callId || s.phase !== "outgoing") return;
              leaveRef.current = { callId: call.callId, wanted: "missed" };
              void closeCallNotification(call.callId);
              void endCallMut({ callId: call.callId, token, status: "missed" });
              cleanup();
            }, remain);
          }
        joinResumeRef.current(call, "outgoing");
        return;
      }
      // Fresh incoming ring: present it, ring the phone, arm the missed-call
      // timer (only when the ring first appears, not on every re-delivery).
      setSession(sessionForRow(call, "incoming"));
      startRing();
      if (ringTtlRef.current == null) {
        ringTtlRef.current = window.setTimeout(() => {
          const s = sessionRef.current;
          if (!s || s.callId !== call.callId || s.phase !== "incoming") return;
          leaveRef.current = { callId: call.callId, wanted: "missed" };
          void closeCallNotification(call.callId);
          void endCallMut({ callId: call.callId, token, status: "missed" });
          cleanup();
        }, RING_TTL);
      }
      return;
    }

    // Active call.
    const inIt = call.acceptedByMe || call.initiatedByMe;
    const leave = leaveRef.current;
    if (leave && leave.callId === call.callId) {
      // I just hung up/declined and the row is still alive (a group call that
      // continued without me, or the end mutation hasn't landed): never
      // re-join. Retry the end only if it was a full end request.
      if (leave.wanted === "ended") {
        void endCallMut({ callId: call.callId, token, status: "ended" }).catch(() => {});
      }
      return;
    }
    if (inIt) {
      // I was in this ACTIVE call and the app was (re)loaded while it was
      // still live — rejoin the room and show the overlay again.
      setSession(sessionForRow(call, "active"));
      setReconnecting(true);
      joinResumeRef.current(call, "active");
      return;
    }
    // I was rung but the call is already active (someone else answered):
    // show a quiet join offer instead of a fresh ring.
    setSession(sessionForRow(call, "incoming", true));
  }, [
    myCalls,
    cleanup,
    sessionForRow,
    startRing,
    stopRing,
    clearRingTtl,
    endCallMut,
    token,
  ]);

  const startCall = useCallback(
    async (
      conversationId: Id<"conversations">,
      kind: CallKind,
      peers: CallPeer[],
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
        } catch (e) {
          // Never fail silently: the caller's phone must say WHY the call
          // didn't go through (busy elsewhere vs. server/network trouble).
          const msg = e instanceof Error ? e.message : "";
          setError(msg === "already_in_call" ? "already_in_call" : "start_failed");
          return;
        }
        setSession({
          callId,
          phase: "outgoing",
          kind,
          initiatedByMe: true,
          joinOffer: false,
          callerName: "",
          callerColor: "",
          peers,
        });
        sawCallRef.current = false;
        leaveRef.current = null;
        // Ring every other device even if the app is closed there. Fire and
        // forget — a push failure must never block the call itself.
        void notifyIncoming({ token, callId, kind }).catch(() => {});
        if (ringTtlRef.current == null) {
          ringTtlRef.current = window.setTimeout(() => {
            const s = sessionRef.current;
            if (!s || s.callId !== callId || s.phase !== "outgoing") return;
            leaveRef.current = { callId, wanted: "missed" };
            void closeCallNotification(callId);
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
    if (busyRef.current) return;
    const s = sessionRef.current;
    if (!s || !token) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await primeMedia(s.kind);
      stopRing();
      clearRingTtl();
      void closeCallNotification(s.callId);
      try {
        await answerCallMut({ callId: s.callId, token });
      } catch {
        /* noop */
      }
      const res = await connectMedia(s.callId, s.kind);
      if (res === true) {
        setSession({ ...s, phase: "active", joinOffer: false });
      } else if (res === "unauthorized" || res === "livekit_not_configured") {
        setError(res);
        try {
          await endCallMut({ callId: s.callId, token, status: "ended" });
        } catch {
          /* noop */
        }
        cleanup();
      } else {
        setSession({ ...s, phase: "active", joinOffer: false });
        setReconnecting(true);
        scheduleConnectRetry(s.callId, s.kind);
      }
    } finally {
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
      void closeCallNotification(s.callId);
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
      void closeCallNotification(s.callId);
      const wasActive = s.phase === "active";
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
    camIntentRef.current = true;
    if (await captureCameraAt(desiredTier(), { enable: true })) {
      setCamOn(true);
    } else {
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

  /**
   * Screen share — hardened:
   * - state is driven by the actual LiveKit publication events, so a failed
   *   capture or a cancelled browser picker can never leave the UI believing
   *   it is sharing (or believing it isn't while a track is live).
   * - errors surface to the user in Persian instead of silently doing nothing.
   * - double-taps are serialized; LiveKit's own pending-publication handling
   *   would otherwise queue two captures on a fast double tap.
   */
  const toggleShare = useCallback(async () => {
    const room = roomRef.current;
    if (!room || shareBusyRef.current) return;
    shareBusyRef.current = true;
    try {
      const next = !sharingRef.current;
      setShareError(null);
      if (next) setShareStarting(true);
      try {
        const pub = await room.localParticipant.setScreenShareEnabled(
          next,
          {
            // No resolution request on purpose: on Safari 17 specifying a
            // resolution makes getDisplayMedia capture far below it.
            audio: false,
            selfBrowserSurface: "include",
            surfaceSwitching: "include",
          },
          {
            // Screen sharing is the hungriest thing on the link; publishing
            // it uncapped could starve voice/video on a weak uplink. Single
            // layer (simulcast off) keeps the SFU cost low for 2–3 viewers.
            simulcast: false,
            screenShareEncoding: { maxBitrate: 2_000_000, maxFramerate: 15 },
          },
        );
        if (next && !pub && !sharingRef.current) {
          setShareError("اشتراک صفحه شروع نشد؛ دوباره تلاش کن");
        }
      } catch (e) {
        if (!next) {
          // Stopping never really fails; ignore.
        } else {
          const name = e instanceof DOMException ? e.name : "";
          const msg = e instanceof Error ? e.message : "";
          setShareError(
            name === "NotAllowedError" || /permission|cancel/i.test(msg)
              ? "برای اشتراک صفحه باید اجازه بدهی"
              : "اشتراک صفحه ممکن نشد؛ دوباره تلاش کن",
          );
        }
        // Keep the UI honest even if LiveKit got confused: if no track is
        // actually live, clear any stale sharing flag.
        const existing = room.localParticipant.getTrackPublications().find(
          (p) => p.source === "screen_share",
        );
        if (!existing && sharingRef.current) {
          setSharing(false);
          sharingRef.current = false;
        }
      } finally {
        setShareStarting(false);
        shareBusyRef.current = false;
      }
    } finally {
      shareBusyRef.current = false;
    }
  }, []);

  const toggleSpeaker = useCallback(() => {
    setSpeakerOn((current) => {
      const next = !current;
      speakerOnRef.current = next;
      for (const part of partsRef.current.values()) {
        part.micEls.forEach((el) => {
          el.volume = next ? 1 : 0;
        });
      }
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
    shareStarting,
    shareError,
    clearShareError,
    local,
    screenLocal,
    remotes,
    error,
    busy,
    reconnecting,
    camQuality,
    cycleQuality,
  };
}
