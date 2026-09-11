import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation } from "convex/react";
// livekit-client is imported lazily (see livekitLoader) so the app shell
// never has to download it — it only loads once a call actually starts.
import type { LocalVideoTrack, RemoteVideoTrack, Room, TrackPublication, VideoEncoding } from "livekit-client";
import { livekit, loadLiveKit } from "./livekitLoader";
import { IS_EMBEDDED, IS_IOS, IS_PHONE } from "./browser";
import {
  cancelOp,
  classifyConnectError,
  createOp,
  createOwner,
  deadline,
  opCurrent,
  safeDisconnect,
  safeStopTrack,
  TimerRegistry,
  withTimeout,
  type CallOwner,
  type ConnectResult,
  type OpHandle,
} from "./callLifecycle";
import { api } from "../convex/_generated/api";
import { useSoftQuery } from "./softQuery";
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
  /** The exact subscribed SDK track; the renderer attaches it. */
  cam: RemoteVideoTrack | null;
  /** The exact subscribed SDK track; the renderer attaches it. */
  screen: RemoteVideoTrack | null;
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
  /** Human-readable (Persian) camera toggle/switch failure, if the last attempt failed. */
  camError: string | null;
  clearCamError: () => void;
  /** Human-readable (Persian) microphone failure, if the last attempt failed. */
  micError: string | null;
  clearMicError: () => void;
  /** True when this device actually lists a second camera to flip to. */
  canSwitchCamera: boolean;
  /** Which physical side of the phone the live camera points at (drives
   *  whether the self preview is mirrored): "user" = front, "environment" =
   *  back, "" = unknown (desktop webcam). */
  camFacing: "user" | "environment" | "";
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

// ConnectResult (including "cancelled") and withTimeout/deadline live in
// ./callLifecycle — the single ownership model every async call op shares.

/** A human-readable Persian explanation for a failed camera start. */
function camFailureMessage(denied: boolean): string {
  if (IS_EMBEDDED) {
    return "دوربین و میکروفون در این نمای جاسازی‌شده قفل هستند؛ لینک اپ را مستقیم در مرورگر گوشی باز کن (یا اپ را «نصب» کن) تا اجازهٔ دوربین داده شود.";
  }
  if (denied) {
    return "اجازهٔ دوربین داده نشده است؛ در مرورگر روی آیکون قفل بزن و دسترسی دوربین را فعال کن، بعد دوباره دکمهٔ دوربین را بزن.";
  }
  return "دوربین روشن نشد؛ دوباره روی دکمهٔ دوربین بزن تا دوباره تلاش کند.";
}

function one(media: MediaStreamTrack | null | undefined): MediaStream | null {
  return media ? new MediaStream([media]) : null;
}

/** The camera's physical facing ("" when the browser doesn't report one). */
function facingOf(track: MediaStreamTrack | null | undefined): "user" | "environment" | "" {
  const f = track?.getSettings().facingMode;
  return f === "user" || f === "environment" ? f : "";
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
 * back up to): 2g/slow-2g → 180p, 3g → 480p, 4g/5g/WiFi/unknown → 720p.
 *
 * 1080p is deliberately NOT the automatic ceiling for fast links: the auto
 * tier is what two phones on mobile data (often asymmetric 4G with a weak
 * uplink) start at, and 1080p@30 ~2.5 Mbps will choke that uplink — the
 * call then looks "connected but no video". 720p@24 ~1.2 Mbps is visually
 * identical on phone screens and fits a real-world mobile uplink; anyone on
 * solid WiFi/desktop can still step up to 1080p manually via the quality
 * chip in the call.
 */
const TIER_BY_NET_CLASS: ReadonlyArray<number> = [0, 1, 2];

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
 * - 4g/5g/WiFi:   720p @ 24fps (auto ceiling; 1080p stays selectable
 *                  via the in-call quality chip when the link is healthy)
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

/**
 * One remote video source (camera or screen) of a participant: the SDK
 * `RemoteVideoTrack` currently occupying that slot plus bookkeeping to
 * release it. Disposal never stops the track, never detaches every SDK
 * element and never touches audio — component unmounts own element
 * attachments, participant storage owns listeners, the room lifecycle owns
 * the media session.
 */
type RemoteVideoSlot = {
  track: RemoteVideoTrack;
  publicationSid: string;
  removeEndedListener: () => void;
};

/**
 * Per-remote-participant bookkeeping, keyed by LiveKit identity (== user id);
 * a version tick re-renders the snapshot after any mutation. Video is stored
 * as SDK tracks (slots), never reconstructed browser streams, so the SDK's
 * adaptive-stream visibility observation and the element renderer can both
 * act on the real object.
 */
interface Part {
  userId: string;
  micEls: Set<HTMLAudioElement>;
  micStream: MediaStream | null;
  camVideo: RemoteVideoSlot | null;
  screenVideo: RemoteVideoSlot | null;
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  poor: boolean;
}

/**
 * Remove one participant's video slot (camera or screen): drop its native
 * `ended` listener, null the slot and clear the matching on flag. It never
 * stops a track, never detaches SDK elements, never touches the other source
 * or audio, and never connects/disconnects a room. Repeated clears are
 * harmless no-ops. Returns whether a slot was actually removed so callers can
 * skip pointless version bumps.
 */
function clearPartVideo(part: Part, source: "camera" | "screen"): boolean {
  const slot = source === "camera" ? part.camVideo : part.screenVideo;
  if (!slot) return false;
  slot.removeEndedListener();
  if (source === "camera") {
    part.camVideo = null;
    part.camOn = true; // publication gone; snapshot masks it until a new one
  } else {
    part.screenVideo = null;
    part.screenOn = false;
  }
  return true;
}

/**
 * Opt-in call-video diagnostics (VITE_CALL_VIDEO_DEBUG=1). Default operation
 * logs nothing: no call telemetry, no user names, tokens or room credentials.
 */
const callVideoDebug = (...args: unknown[]) => {
  if (import.meta.env.VITE_CALL_VIDEO_DEBUG === "1") {
    // eslint-disable-next-line no-console
    console.debug("[call-video]", ...args);
  }
};

export function useCallkit(token: string | null): GarmaCallkit {
  const [session, setSession] = useState<CallSession | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [shareStarting, setShareStarting] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [camCount, setCamCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [camQuality, setCamQuality] = useState<string | null>(null);
  const [camFacing, setCamFacing] = useState<"user" | "environment" | "">("");
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [screenLocal, setScreenLocal] = useState<MediaStream | null>(null);

  const roomRef = useRef<Room | null>(null);
  const lastCamIdRef = useRef<string>("");
  const busyRef = useRef(false);
  /**
   * An end (hangup/decline) is in flight. Busy no longer blocks the end
   * button during a connect (see accept/decline/hangup): cancellation must
   * stay available while the media connection is being established — a
   * WhatsApp-style ring screen is cancellable at every instant. This ref
   * makes that second tap a no-op for a moment that is already ending
   * instead of a silent ignored tap.
   */
  const endingRef = useRef(false);
  const shareBusyRef = useRef(false);
  const micBusyRef = useRef(false);
  const sawCallRef = useRef(false);
  const ringRef = useRef<AudioContext | null>(null);
  const ringTimerRef = useRef<number | null>(null);
  const ringVibrateTimerRef = useRef<number | null>(null);
  /** Owner-scoped timers of the ring (incl. the 2s tone-decay timeout):
   *  teardown clears ALL of them at once; a decay timeout can never fire into
   *  a closed AudioContext, and stopRing cannot clear a newer ring's timers. */
  const ringTimersRef = useRef<TimerRegistry>(new TimerRegistry());
  const sessionRef = useRef<CallSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // ---- Per-remote-participant media --------------------------------------
  // A call can have several remote participants now (group calls), each with
  // their own mic/camera/screen tracks. Keyed by LiveKit identity (== user
  // id); a version tick re-renders the snapshot below after any mutation.
  // `Part` and the video slot helpers live at module scope (see above).
  const partsRef = useRef<Map<string, Part>>(new Map());
  const [partsTick, setPartsTick] = useState(0);
  const commitParts = useCallback(() => setPartsTick((t) => t + 1), []);

  // ---- Camera availability (drives the switch-camera button) -----------
  // The flip control is only useful when the device has ≥2 cameras. Count
  // them while a video session is up and keep the count live on device
  // changes (USB webcams, phone cameras appearing after permission).
  const videoSessionActive = session?.kind === "video";
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!videoSessionActive || !md?.enumerateDevices) {
      setCamCount(0);
      return;
    }
    const refresh = () => {
      md.enumerateDevices()
        .then((devices) =>
          // Browser permission gates the real device ids: until the camera
          // has been opened, devices come back with empty ids/labels and the
          // count would read 0. Re-run whenever the camera turns on (that's
          // when the ids appear) as well as on devicechange.
          setCamCount(devices.filter((d) => d.kind === "videoinput" && d.deviceId).length),
        )
        .catch(() => {});
    };
    refresh();
    md.addEventListener?.("devicechange", refresh);
    return () => md.removeEventListener?.("devicechange", refresh);
  }, [videoSessionActive, camOn]);

  const partOf = useCallback((userId: string): Part => {
    let p = partsRef.current.get(userId);
    if (!p) {
      p = {
        userId,
        micEls: new Set(),
        micStream: null,
        camVideo: null,
        screenVideo: null,
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

  /** Snapshot of live remote media for the overlay, ordered by joined peers.
   *  Video whose browser track ended is masked to null: a remote track can die
   *  (sharer closed the picker, their app was killed, SFU glitch) and the
   *  unsubscribe event can race/reconnect away — never hand the UI a frozen
   *  or black picture to keep rendering. The snapshot references the original
   *  SDK object (no clone/spread): attachment relies on that identity. */
  const remotes: RemotePeer[] = useMemo(() => {
    const joined = partsRef.current;
    const out: RemotePeer[] = [];
    const liveOnly = (s: MediaStream | null): MediaStream | null =>
      s && s.getTracks().some((t) => t.readyState === "live") ? s : null;
    const liveVideo = (slot: RemoteVideoSlot | null): RemoteVideoTrack | null =>
      slot?.track.mediaStreamTrack.readyState === "live" ? slot.track : null;
    for (const [userId, part] of joined) {
      const meta = partNames.get(userId) ?? { displayName: "…", themeColor: "#8a6340" };
      const cam = liveVideo(part.camVideo);
      const screen = liveVideo(part.screenVideo);
      const mic = liveOnly(part.micStream);
      out.push({
        userId,
        displayName: meta.displayName,
        themeColor: meta.themeColor,
        mic,
        cam,
        screen,
        micOn: part.micOn,
        // A track that died mid-call reads as "off" — a mute flag without a
        // usable SDK track would show a camera-off badge over a black tile.
        camOn: part.camOn && !!cam,
        screenOn: part.screenOn && !!screen,
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
  /** Permission for mic/camera was refused (or is blocked by the embedding
   *  page), so a later silent LiveKit capture failure can be explained. */
  const mediaDeniedRef = useRef(false);
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
  // ---- Ownership model (src/lib/callLifecycle.ts) ----
  // One CallOwner per local call lifecycle. Teardown disposes it
  // SYNCHRONOUSLY, so every async operation holding its handle can see —
  // the moment it resolves — that the call it belonged to is over, without
  // guessing from session state.
  const ownerRef = useRef<CallOwner | null>(null);
  /** The one current operation of each kind inside the live lifecycle. */
  const opRefs = useRef<Record<"connect" | "camera" | "share" | "switch", OpHandle | null>>({
    connect: null,
    camera: null,
    share: null,
    switch: null,
  });
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
  const clearCamError = useCallback(() => setCamError(null), []);
  const clearMicError = useCallback(() => setMicError(null), []);

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
      if (!navigator.mediaDevices?.getUserMedia) {
        mediaDeniedRef.current = true;
        return;
      }
      const gUM = navigator.mediaDevices.getUserMedia({ audio: true, video: kind === "video" });
      // CANCELLATION-SAFE WARM-UP: withTimeout can abandon a getUserMedia that
      // is still running (permission prompt / slow camera on some Androids).
      // The abandoned promise stays pending with no owner, so a stream that
      // resolves AFTER we gave up would leave a live capture driver behind —
      // the green dot / LED stays on with no call. This side-handler is the
      // late result's owner: it stops the tracks whenever the main await no
      // longer needs them (timeout, hangup race, error). The real connect
      // below always opens its own fresh capture, so stopping here is safe.
      gUM.then(
        (stream) => stream.getTracks().forEach((t) => t.stop()),
        () => {},
      );
      const stream = await withTimeout(gUM, 10_000, "prime_timeout");
      stream.getTracks().forEach((t) => t.stop());
    } catch (e) {
      // Remember a refusal (user denied, or the embedding page withholds the
      // permission) so connectMedia can explain a silent capture failure
      // instead of leaving the call looking connected with no media.
      const name = e instanceof Error ? e.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        mediaDeniedRef.current = true;
      }
    }
  }, []);

  // Soft query: an unanswered `calls:myCalls` (backend mid-deploy, function
  // missing) must mean "no live call right now", never a crash — the call
  // reconciler below simply stays idle until the query answers.
  const { data: myCalls } = useSoftQuery(api.calls.myCalls, token ? { token } : "skip") as unknown as {
    data: CallRow[] | undefined;
    unavailable: boolean;
  };

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
    // ---- OWNER DISPOSAL (synchronous, first) ----
    // From here on, EVERY in-flight operation of this lifecycle (connect,
    // camera capture, screen share, camera switch, pending retries) observes
    // ownerRef.disposed === true when it resolves and must dispose of its own
    // resources without touching anything a NEWER lifecycle owns. Cancelling
    // the current op handles also marks superseded attempts so their results
    // are classified "cancelled", not retried and never shown as errors.
    const owner = ownerRef.current;
    if (owner) owner.disposed = true;
    for (const key of ["connect", "camera", "share", "switch"] as const) {
      cancelOp(opRefs.current[key]);
      opRefs.current[key] = null;
    }
    ownerRef.current = null;
    connRetryDelayRef.current = 1500;
    for (const part of partsRef.current.values()) {
      part.micEls.forEach((el) => {
        el.pause();
        el.srcObject = null;
        el.remove();
      });
      part.micEls.clear();
      clearPartVideo(part, "camera");
      clearPartVideo(part, "screen");
    }
    partsRef.current.clear();
    commitParts();
    clearRingTtl();
    clearQualityWatch();
    const room = roomRef.current;
    // ---- END-OF-CALL LOCAL-MEDIA OWNERSHIP ----
    // Teardown is where this device's captured media dies. The room's
    // publication map is the single truthful inventory of every local track
    // that was captured (mic, camera, screen share; live, muted, or
    // mid-swap): primeMedia never keeps tracks, and a capture made inside
    // LiveKit's own publish calls is registered there the moment it exists.
    // A clean disconnect already stops what it holds, but hangup DURING a
    // reconnect/publish that is still in flight leaves the capture driver
    // running — the mic keeps listening, the camera LED stays on, the share
    // track is orphaned. So the map is swept explicitly here, BEFORE the
    // disconnect below; stopping an already-ended track is a no-op.
    if (room) {
      try {
        for (const pub of room.localParticipant.trackPublications.values()) {
          const t = pub.track?.mediaStreamTrack;
          if (t && t.readyState !== "ended") {
            try {
              t.stop();
            } catch {
              /* noop */
            }
          }
        }
      } catch {
        /* a torn-down room no longer owns anything to release */
      }
    }
    // 3) The connection itself, last. A connect() that has not resolved yet
    //    still belongs to this call until it does: nulling roomRef FIRST
    //    makes every handler's `roomRef.current !== r` guard inert, so the
    //    disconnect below cannot fire Disconnected at a live handler and
    //    schedule a reconnect for a call the user just ended.
    if (room) {
      // Null roomRef FIRST so every handler's `roomRef.current !== r` guard
      // goes inert before the disconnect can fire Disconnected at them; then
      // disconnect through safeDisconnect, which also absorbs a synchronous
      // throw and the rejected-promise edge so disposal can never throw into
      // the caller (or leave an unhandled rejection).
      roomRef.current = null;
      safeDisconnect(room);
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
    setCamFacing("");
    setReconnecting(false);
    setCamError(null);
    setMicError(null);
    mediaDeniedRef.current = false;
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
    // The registry holds the tone-decay timeouts (and any other ring-scoped
    // timer); clearing everything here means a decay callback can never run
    // against a closed AudioContext.
    ringTimersRef.current.clearAll();
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
      // iOS/Safari create every AudioContext "suspended" until the page has
      // seen a user gesture. Ask to resume right away — once the app has had
      // any tap (signup, opening a chat…) this is what actually makes the
      // ring audible; on desktop it is a no-op.
      const ensureRunning = () => {
        try {
          if (ctx.state !== "running") void ctx.resume();
        } catch {
          /* noop */
        }
      };
      ensureRunning();
      const tone = () => {
        ensureRunning();
        gain.gain.setTargetAtTime(0.22, ctx.currentTime, 0.02);
        // Registered on the ring's own registry: stopRing()/cleanup() clears
        // it, so the decay can never land on an already-closed context.
        ringTimersRef.current.setTimeout(() => {
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

  // Unmounting a screen that still owns a call must release EVERYTHING the
  // way hangup does — not only the ring. Before this, an unmount mid-ring or
  // mid-call left the ring tone, vibration, the LiveKit room and this
  // device's captured mic/camera/screen running with no UI to stop them:
  // exactly the "app closed but the green dot / LED stayed on" bug.
  // cleanup() = teardown() + stopRing(); it is idempotent, so the extra
  // call from decline/hangup costs nothing.
  useEffect(() => () => cleanup(), [cleanup]);

  /**
   * (Re)capture and publish the camera at a given tier. Used for the initial
   * publish, network upgrades/downgrades, congestion stepping and manual caps.
   *
   * LATE-RESULT OWNERSHIP: the capture is bounded with `deadline`, not
   * `withTimeout` — a getUserMedia that resolves after its deadline keeps
   * running in the browser, so its eventual result MUST be observed and
   * released (track stopped) instead of leaking a live capture. A capture
   * that resolves on a lifecycle that was already disposed (hangup during
   * the capture) is stopped here too.
   */
  const captureCameraAt = useCallback(
    async (tier: number, opts?: { enable?: boolean; force?: boolean }): Promise<boolean> => {
      const room = roomRef.current;
      // `force` bypasses the busy lock for callers that ALREADY hold it (the
      // switch-camera fallback runs while the switch holds tierBusy) — without
      // it that fallback would always early-return false and never republish.
      if (!room || (tierBusyRef.current && !opts?.force)) return false;
      const { Track } = livekit();
      const plan = CAM_TIERS[tier];
      if (!plan) return false;
      if (sessionRef.current?.kind !== "video") return false;
      if (opts?.enable) camIntentRef.current = true;
      else if (!camIntentRef.current) {
        captureTierRef.current = tier;
        return false;
      }
      // Adopt (or supersede) the current camera op of THIS lifecycle.
      const owner = ownerRef.current ?? createOwner(sessionRef.current?.callId ?? null, sessionRef.current?.kind ?? "audio");
      if (!ownerRef.current) ownerRef.current = owner;
      const priorCamOp = opRefs.current.camera;
      if (priorCamOp) cancelOp(priorCamOp);
      const op = createOp(owner, "camera");
      opRefs.current.camera = op;
      tierBusyRef.current = true;
      try {
        const existing = room.localParticipant.getTrackPublication(Track.Source.Camera);
        // A live publication can only change camera/constraints via a fresh
        // capture: setCameraEnabled(true) on an existing publication just
        // soft-unmutes the SAME track and silently ignores the new options.
        // Unpublish it first so the publish below is a real getUserMedia —
        // the exact path that works at call connect — on the currently
        // selected device.
        if (existing?.track) {
          try {
            await room.localParticipant.unpublishTrack(existing.track);
          } catch {
            /* the fresh publish below will fail visibly if the camera stuck */
          }
        }
        // Bound the capture WITHOUT abandoning it: a getUserMedia/publish that
        // hangs (some Android Chrome builds) must never wedge the camera
        // controls forever, and its late result must still be released.
        const attempt = (deviceId?: string) => {
          const bounded = deadline(
            room.localParticipant.setCameraEnabled(
              true,
              {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                resolution: plan.resolution,
                frameRate: plan.frameRate,
              },
              { videoEncoding: plan.encoding, simulcast: true },
            ),
            15_000,
            "cam_capture_timeout",
          );
          // THE LATE HANDLER: whatever the capture eventually produces is
          // released here if the deadline already fired. OWNERSHIP RULE: an
          // obsolete op disposes of ITS OWN resource only — the late capture
          // track it produced is stopped, but the ROOM is never disconnected
          // from here: by the time a slow capture lands, the room may already
          // be serving a newer capture (tier change, switch) or a newer
          // lifecycle (hangup + new call), and killing it would end a live
          // call. (When the capture wins the race, `late` reports
          // { late: false } and this handler is inert.)
          void bounded.late.then((r) => {
            if (!r.late) return;
            const latePub = r.value as { track?: { mediaStreamTrack?: MediaStreamTrack } } | null | undefined;
            if (latePub?.track?.mediaStreamTrack) {
              safeStopTrack(latePub.track.mediaStreamTrack);
              return;
            }
            // No publication object arrived: the capture resolved inside
            // LiveKit's publish path, so the only trace is the camera source
            // of the room this attempt targeted. Sweep THAT (old) room's
            // camera source when this op no longer owns the camera slot —
            // never roomRef and never a disconnect.
            if (!opCurrent(op, opRefs.current.camera)) {
              try {
                const orphan = room.localParticipant.getTrackPublication(Track.Source.Camera);
                safeStopTrack(orphan?.track?.mediaStreamTrack);
              } catch {
                /* noop */
              }
            }
          });
          return bounded.result;
        };
        try {
          await attempt(lastCamIdRef.current || undefined);
        } catch (err) {
          // A stale/over-constrained device id (permissions were reset, the
          // device was unplugged…) must never black out the call: fall back
          // to whatever camera the browser can actually open.
          if (!lastCamIdRef.current) throw err;
          lastCamIdRef.current = "";
          await attempt();
        }
        // OWNER GUARD: the user may have hung up while the getUserMedia above
        // was still opening (teardown's publication sweep ran BEFORE this
        // fresh capture was registered), or a newer capture may have
        // superseded this one. An obsolete/op-owned-no-more result stops the
        // capture it produced and never touches the room's live state.
        if (!opCurrent(op, opRefs.current.camera)) {
          try {
            const orphan = room.localParticipant.getTrackPublication(Track.Source.Camera);
            safeStopTrack(orphan?.track?.mediaStreamTrack);
          } catch {
            /* noop */
          }
          return false;
        }
        // Remember which physical camera is actually live so a later
        // re-capture (unmute, tier change) never silently reverts to the
        // browser's default device.
        const repub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        const realId = repub?.track?.mediaStreamTrack?.getSettings().deviceId;
        if (realId) lastCamIdRef.current = realId;
        setCamFacing(facingOf(repub?.track?.mediaStreamTrack));
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
          // A user action (accept/start) is mid-flight and already owns the
          // connect path. Firing a parallel connect here would open a second
          // LiveKit room for the same identity — the server closes the older
          // connection, dropping that room's camera/mic publications mid-call.
          // Defer until the action settles instead.
          if (busyRef.current) {
            scheduleConnectRetry(callId, kind);
            return;
          }
          const res = await connectMediaRef.current(callId, kind, {
            restoreState: s.phase === "active",
          });
          if (connectGenRef.current !== gen) return; // torn down mid-attempt
          // A cancelled connect (hangup / superseded attempt) is not a
          // failure: no retry, no error — the lifecycle that owned it is gone.
          if (res === "cancelled") return;
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
      // OWNER / OP ADOPTION: this connect attempt belongs to the live call
      // lifecycle (creating the owner the first time if the lifecycle is
      // being adopted lazily from a resume path). A prior connect op of the
      // SAME lifecycle is superseded and marked cancelled, so its eventual
      // result can never act on, or retry for, the call again.
      const owner = ownerRef.current ?? createOwner(callId, kind);
      if (!ownerRef.current) ownerRef.current = owner;
      const priorConnectOp = opRefs.current.connect;
      if (priorConnectOp) cancelOp(priorConnectOp);
      const op = createOp(owner, "connect");
      opRefs.current.connect = op;
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
        // The lifecycle can end while the token action is in flight; an owner
        // that died mid-token must not open a room behind the hangup.
        if (owner.disposed) return "cancelled";
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
            setCamFacing(facingOf(publication.track?.mediaStreamTrack));
            setCamOn(!publication.isMuted);
          } else if (publication.source === Track.Source.ScreenShare) {
            setScreenLocal(one(publication.track?.mediaStreamTrack));
            // sharing flag follows the live publication (see toggleShare)
            setSharing(true);
            sharingRef.current = true;
          } else if (publication.source === Track.Source.Microphone) {
            setMicOn(!publication.isMuted);
          }
        });
        room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
          if (roomRef.current !== r) return;
          if (publication.source === Track.Source.Camera) {
            setLocal(null);
            setCamFacing("");
          } else if (publication.source === Track.Source.ScreenShare) {
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
            // Remote voice keeps SDK attachment (unchanged): a dedicated
            // element per person — video tiles stay muted so audio is never
            // doubled/phasey.
            part.micStream = new MediaStream([track.mediaStreamTrack]);
            part.micOn = !publication.isMuted;
            const audio = track.attach() as HTMLAudioElement;
            audio.autoplay = true;
            audio.setAttribute("playsinline", "true");
            audio.volume = speakerOnRef.current ? 1 : 0;
            document.body.appendChild(audio);
            part.micEls.add(audio);
          } else if (track instanceof LK.RemoteVideoTrack) {
            // Remote VIDEO keeps the SDK RemoteVideoTrack itself — the
            // renderer attaches it (adaptive reception only starts once the
            // element observes it), so a constructed browser stream would
            // break that. Camera and screen occupy separate slots; clearing
            // one never disturbs the other or the microphone.
            const source: "camera" | "screen" =
              publication.source === Track.Source.ScreenShare ? "screen" : "camera";
            const sid = publication.trackSid;
            const prior = source === "camera" ? part.camVideo : part.screenVideo;
            if (prior && prior.track === track && prior.publicationSid === sid) {
              // Same publication re-delivered: reconcile the mute flag only,
              // never stack a second ended listener or reset the slot.
              if (source === "camera") part.camOn = !publication.isMuted;
              else part.screenOn = !publication.isMuted;
            } else {
              // Replacement (A → B): release A's bookkeeping listener first so
              // a stale ended event can never delete B; React disposes A's
              // element attachment when it observes the new track.
              if (prior) clearPartVideo(part, source);
              const browserTrack = track.mediaStreamTrack;
              const endedListener = () => {
                // Old-room / stale events must never delete replacement media.
                if (roomRef.current !== r) return;
                const cur = partsRef.current.get(uid);
                if (!cur || cur !== part) return;
                const curSlot = source === "camera" ? cur.camVideo : cur.screenVideo;
                if (!curSlot) return;
                if (curSlot.track !== track || curSlot.publicationSid !== sid) return;
                if (curSlot.track.mediaStreamTrack !== browserTrack) return;
                if (clearPartVideo(cur, source)) commitParts();
              };
              const slot: RemoteVideoSlot = {
                track,
                publicationSid: sid,
                removeEndedListener: () =>
                  browserTrack.removeEventListener("ended", endedListener),
              };
              browserTrack.addEventListener("ended", endedListener);
              if (source === "camera") {
                part.camVideo = slot;
                part.camOn = !publication.isMuted;
              } else {
                part.screenVideo = slot;
                part.screenOn = !publication.isMuted;
              }
            }
            callVideoDebug("remoteVideoSubscribed", { source, sid });
          }
          commitParts();
        });
        room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
          if (roomRef.current !== r) return;
          const uid = participant?.identity ?? "?";
          if (publication.source === Track.Source.Microphone) {
            const part = partOf(uid);
            track.detach().forEach((element) => {
              part.micEls.delete(element as HTMLAudioElement);
              element.remove();
            });
            part.micStream = null;
            part.micOn = true;
            commitParts();
            return;
          }
          // Video cleanup only ever clears a slot this event actually names
          // (publication SID AND SDK track object): a replacement track can
          // reuse a publication SID, so an unsubscribe for A must not erase B.
          // A missing participant never creates a ghost video participant.
          const part = partsRef.current.get(uid);
          if (!part) return;
          if (
            publication.source === Track.Source.Camera &&
            part.camVideo?.publicationSid === publication.trackSid &&
            part.camVideo.track === track
          ) {
            clearPartVideo(part, "camera");
            commitParts();
          } else if (
            publication.source === Track.Source.ScreenShare &&
            part.screenVideo?.publicationSid === publication.trackSid &&
            part.screenVideo.track === track
          ) {
            clearPartVideo(part, "screen");
            commitParts();
          }
        });
        // A REMOTE publication can disappear without a matching unsubscribe on
        // our side (the publisher stopped it before we ever subscribed, or
        // LiveKit removed it during a reconnect reconcile). TrackUnpublished
        // fires for every remote unpublish — treat it as the authoritative
        // "gone" signal so a stopped screen share/camera can never leave a
        // stale (frozen-frame) stream behind on this screen. This is what
        // keeps the share tile honest when the sharer hits "پایان اشتراک".
        room.on(RoomEvent.TrackUnpublished, (publication, participant) => {
          if (roomRef.current !== r) return;
          const uid = participant.identity;
          const part = partsRef.current.get(uid);
          if (!part) return; // never subscribed → nothing to clean
          if (publication.source === Track.Source.Microphone) {
            part.micEls.forEach((el) => {
              el.pause();
              el.srcObject = null;
              el.remove();
            });
            part.micEls.clear();
            part.micStream = null;
            part.micOn = true;
          } else if (publication.source === Track.Source.Camera) {
            // SID match only — publication.track may already be gone. An
            // obsolete publication event must never clear a newer one.
            if (part.camVideo?.publicationSid === publication.trackSid) {
              clearPartVideo(part, "camera");
            }
          } else if (publication.source === Track.Source.ScreenShare) {
            if (part.screenVideo?.publicationSid === publication.trackSid) {
              clearPartVideo(part, "screen");
            }
          }
          commitParts();
        });
        // A remote participant left the room (hung up, app killed, network
        // drop that outlived their retries): drop their media part entirely so
        // the UI never keeps rendering a "در تماس" participant or a leftover
        // tile for someone who is gone. If they come back (rejoin), a fresh
        // ParticipantConnected + TrackSubscribed rebuilds the part from zero.
        room.on(RoomEvent.ParticipantDisconnected, (participant) => {
          if (roomRef.current !== r) return;
          const part = partsRef.current.get(participant.identity);
          if (!part) return;
          part.micEls.forEach((el) => {
            el.pause();
            el.srcObject = null;
            el.remove();
          });
          part.micEls.clear();
          // Release both video slots (ended listeners) before the part goes.
          clearPartVideo(part, "camera");
          clearPartVideo(part, "screen");
          partsRef.current.delete(participant.identity);
          commitParts();
        });
        room.on(RoomEvent.ParticipantConnected, (participant) => {
          if (roomRef.current !== r) return;
          // Ensure the participant has a part the moment they enter the media
          // room (a late joiner who has not published anything yet still has a
          // row for the overlay's participant list).
          partOf(participant.identity);
          commitParts();
        });
        // Only remote track mutes matter here.
        const isLocalPub = (publication: TrackPublication) =>
          r.localParticipant.getTrackPublications().includes(publication);
        room.on(RoomEvent.TrackMuted, (publication, participant) => {
          if (roomRef.current !== r || isLocalPub(publication)) return;
          const identity = participant?.identity ?? "?";
          if (publication.source === Track.Source.Microphone) {
            partOf(identity).micOn = false;
          } else if (publication.source === Track.Source.Camera) {
            // Match the publication SID occupying this source. Pre-subscription
            // mute events name no slot yet — ignore them (subscription reads
            // the publication's current mute state). The slot and its ended
            // listener stay while muted so an unmute can show the same track.
            const part = partsRef.current.get(identity);
            if (part?.camVideo?.publicationSid === publication.trackSid) part.camOn = false;
          } else if (publication.source === Track.Source.ScreenShare) {
            const part = partsRef.current.get(identity);
            if (part?.screenVideo?.publicationSid === publication.trackSid) part.screenOn = false;
          }
          commitParts();
        });
        room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
          if (roomRef.current !== r || isLocalPub(publication)) return;
          const identity = participant?.identity ?? "?";
          if (publication.source === Track.Source.Microphone) {
            partOf(identity).micOn = true;
          } else if (publication.source === Track.Source.Camera) {
            const part = partsRef.current.get(identity);
            if (part?.camVideo?.publicationSid === publication.trackSid) part.camOn = true;
          } else if (publication.source === Track.Source.ScreenShare) {
            const part = partsRef.current.get(identity);
            if (part?.screenVideo?.publicationSid === publication.trackSid) part.screenOn = true;
          }
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
            clearPartVideo(part, "camera");
            clearPartVideo(part, "screen");
          }
          commitParts();
          setScreenLocal(null);
          setLocal(null);
          // A full disconnect tears the whole room down, and LiveKit stops
          // every local capture track with it (including a running screen
          // share). The share cannot be re-established without a fresh
          // browser picker + user gesture (and the torn-down tracks' events
          // are unreliable after this point), so reset the UI to "not
          // sharing" NOW: otherwise the share button and the "در حال
          // اشتراک…" chip stay lit forever with no track behind them and the
          // "پایان اشتراک" tap becomes a silent no-op. After the rejoin the
          // user simply taps share again.
          setSharing(false);
          sharingRef.current = false;
          setShareStarting(false);
          setShareError(null);
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
        callVideoDebug("roomConnected", { callId });

        try {
          await r.startAudio();
        } catch {
          /* noop */
        }

        if (sessionRef.current?.callId !== callId || owner.disposed || op.cancelled) {
          safeDisconnect(r);
          if (roomRef.current === r) roomRef.current = null;
          return "cancelled";
        }

        const restore = opts?.restoreState === true;
        const enableMic = restore ? micIntentRef.current : true;
        const enableCam = restore ? camIntentRef.current : kind === "video";
        if (enableMic) micIntentRef.current = true;

        const camPub = () => r.localParticipant.getTrackPublication(Track.Source.Camera);
        const camLive = () => {
          const p = camPub();
          return !!p?.track && !p.isMuted && p.track.mediaStreamTrack.readyState === "live";
        };
        const micPub = () => r.localParticipant.getTrackPublication(Track.Source.Microphone);
        const micLive = () => {
          const p = micPub();
          return !!p?.track && !p.isMuted;
        };
        const pause = (ms: number) => new Promise<void>((res) => window.setTimeout(res, ms));

        await Promise.allSettled([
          enableCam
            ? captureCameraAt(startTier, { enable: true })
            : kind === "video" && restore
              ? r.localParticipant.setCameraEnabled(false)
              : Promise.resolve(),
          r.localParticipant.setMicrophoneEnabled(enableMic),
        ]);
        // Verify each source ACTUALLY came up and give it one automatic
        // retry — camera hardware on some Androids answers slowly or the
        // first capture trips a transient error. A silent capture failure
        // must never leave the call "connected" with no video/audio and no
        // explanation.
        if (enableMic && !micLive()) {
          await pause(700);
          if (!micLive()) await r.localParticipant.setMicrophoneEnabled(true).catch(() => {});
        }
        if (enableCam && !camLive()) {
          await pause(700);
          if (!camLive()) await captureCameraAt(startTier, { enable: true });
        }
        setCamError(null);
        setMicError(null);
        if (enableCam && !camLive()) {
          camIntentRef.current = false;
          setCamOn(false);
          setCamError(camFailureMessage(mediaDeniedRef.current));
        }
        if (enableMic && !micLive()) {
          micIntentRef.current = false;
          setMicOn(false);
          setMicError(
            IS_EMBEDDED
              ? "میکروفون در این نمای جاسازی‌شده قفل است؛ لینک اپ را مستقیم در مرورگر گوشی باز کن."
              : mediaDeniedRef.current
                ? "اجازهٔ میکروفون داده نشده است؛ در مرورگر روی آیکون قفل بزن و دسترسی میکروفون را فعال کن."
                : "میکروفون وصل نشد؛ دوباره تلاش کن یا میکروفون دستگاه را بررسی کن.",
          );
        }

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
        safeDisconnect(room);
        // CANCELLED ≠ FAILED: a hangup (disposed owner) or a superseded
        // attempt (cancelled op) is intentional cancellation, not a transient
        // failure — reporting it as "retryable" would schedule reconnects
        // (or surface an error toast) for a call the user already ended.
        if (owner.disposed || op.cancelled) return "cancelled";
        return classifyConnectError(e);
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
        // A cancelled connect (hangup while the resume was connecting) is not
        // a failure and must not schedule retries or errors.
        if (res === "cancelled") return; // user moved on meanwhile
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
          !cur.joinOffer &&
          // While an accept is in flight (busy is held from the tap until the
          // media connect settles), the row turning active is MY OWN answer —
          // not a group-mate answering for me. Don't demote my ring to a
          // quiet join offer; accept() flips this screen to active itself.
          !busyRef.current
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
        setSession(sessionForRow(call, "outgoing"));
        if (ringTtlRef.current == null) {
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
        // CANCELLATION RECHECK: the caller may hang up while this connect
        // is still running; only the live session for ITS OWN call may act.
        if (sessionRef.current?.callId !== callId) return;
        if (res === "cancelled") return; // hung up / superseded mid-connect
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
      // LATE-RESULT GUARD: primeMedia can sit on a permission prompt for
      // its whole 10s budget while the user taps the red button. Answering
      // after that would flip the call to "active" on the server with
      // nobody present - a ghost call still ringing on the peer's side.
      // Stand down here; hangup's own cleanup already stopped the ring
      // and closed the notification.
      if (sessionRef.current?.callId !== s.callId) return; // cancelled mid-prime
      stopRing();
      clearRingTtl();
      void closeCallNotification(s.callId);
      try {
        await answerCallMut({ callId: s.callId, token });
      } catch {
        /* noop */
      }
      // The session can move on while the media connect runs: as soon as the
      // call row flips to "active" (this very answer committing), the myCalls
      // effect refreshes this session — marking the caller/others as joined.
      // Painting the tap-time snapshot `s` over that fresh state would rebuild
      // the active overlay from a stale peer list (the other side still
      // "unjoined"), leaving the person who just answered on the
      // "در انتظار پیوستن بقیه…" wait screen — no remote video, no self
      // preview — for the rest of the call. Activate by merging into the
      // freshest session instead, and if the session is gone or belongs to
      // another call by now (hung up / moved on), don't resurrect it.
      const activate = () =>
        setSession((prev) =>
          prev && prev.callId === s.callId
            ? { ...prev, phase: "active", joinOffer: false }
            : prev,
        );
      // CANCELLATION GUARD: hangup/decline may now run while connectMedia is
      // still awaited. cleanup() nulls sessionRef, and the room-ref identity
      // guard keeps the media itself from being adopted, but ONLY this
      // re-check stops the RESULT from acting on a call the user already
      // cancelled: without it, a slow connect resolving after the red
      // button was tapped would re-activate the session (the overlay comes
      // back), schedule retries, and look like a call that refuses to die.
      if (sessionRef.current?.callId !== s.callId) return; // cancelled mid-connect
      const res = await connectMedia(s.callId, s.kind);
      // CANCELLATION RECHECK: the connect above can settle AFTER the user
      // tapped the red button (the unblock above made that tap possible).
      // cleanup() has already run in that case — sessionRef is null — so
      // acting on the result would resurrect a cancelled call.
      if (sessionRef.current?.callId !== s.callId) return;
      if (res === "cancelled") return; // hung up / superseded mid-connect
      if (res === true) {
        activate();
      } else if (res === "unauthorized" || res === "livekit_not_configured") {
        setError(res);
        try {
          await endCallMut({ callId: s.callId, token, status: "ended" });
        } catch {
          /* noop */
        }
        cleanup();
      } else {
        activate();
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
    // CANCELLATION AVAILABILITY: busy no longer blocks the end button. The
    // accept path can hold busy for many seconds (primeMedia + the media
    // connect); the red button must still work at every instant of that
    // window -- a call is cancellable before it starts, exactly like an
    // active one. A second tap while already ending is dropped here.
    if (endingRef.current) return;
    const s = sessionRef.current;
    if (!s || !token) return;
    busyRef.current = true;
    endingRef.current = true;
    setBusy(true);
    try {
      stopRing();
      void closeCallNotification(s.callId);
      leaveRef.current = { callId: s.callId, wanted: "declined" };
      // DISPOSE FIRST: the red button ends THIS device's participation the
      // instant it is pressed — ring, room, captured mic/camera/screen all
      // die now, not after a (possibly hung or offline) server round-trip.
      // The leaveRef retry loop guarantees the server row still converges.
      cleanup();
      try {
        await endCallMut({ callId: s.callId, token, status: "declined" });
      } catch {
        /* leaveRef retries when connectivity returns */
      }
    } finally {
      endingRef.current = false;
      busyRef.current = false;
      setBusy(false);
    }
  }, [cleanup, endCallMut, stopRing, token]);

  const hangup = useCallback(async () => {
    // CANCELLATION AVAILABILITY: busy no longer blocks the end button. The
    // accept path can hold busy for many seconds (primeMedia + the media
    // connect); the red button must still work at every instant of that
    // window -- a call is cancellable before it starts, exactly like an
    // active one. A second tap while already ending is dropped here.
    if (endingRef.current) return;
    const s = sessionRef.current;
    if (!s || !token) return;
    busyRef.current = true;
    endingRef.current = true;
    setBusy(true);
    try {
      stopRing();
      void closeCallNotification(s.callId);
      const wasActive = s.phase === "active";
      leaveRef.current = { callId: s.callId, wanted: wasActive ? "ended" : "declined" };
      // DISPOSE FIRST: the red button ends THIS device's participation the
      // instant it is pressed — ring, room, captured mic/camera/screen all
      // die now, not after a (possibly hung or offline) server round-trip.
      // The leaveRef retry loop guarantees the server row still converges.
      cleanup();
      try {
        await endCallMut({ callId: s.callId, token, status: wasActive ? "ended" : "declined" });
      } catch {
        /* leaveRef retries when connectivity returns */
      }
    } finally {
      endingRef.current = false;
      busyRef.current = false;
      setBusy(false);
    }
  }, [cleanup, endCallMut, stopRing, token]);

  // ---- Controls (routed through LiveKit) ----
  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    // Serialize taps and bound the toggle: an unbounded setMicrophoneEnabled
    // can hang on some Androids and silently desync intent/track/UI.
    if (!room || micBusyRef.current) return;
    const next = !micOn;
    micBusyRef.current = true;
    try {
      try {
        await withTimeout(room.localParticipant.setMicrophoneEnabled(next), 10_000, "mic_toggle_timeout");
        micIntentRef.current = next;
        setMicOn(next);
      } catch {
        setMicError("تغییر وضعیت میکروفون ممکن نشد؛ دوباره تلاش کن");
      }
    } finally {
      micBusyRef.current = false;
    }
  }, [micOn]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room || tierBusyRef.current) return;
    const next = !camOn;
    setCamError(null);
    if (!next) {
      // Soft-mute (keeps the camera warm for an instant re-enable, same as
      // the mic toggle). Remote participants get TrackMuted and show the
      // camera-off state.
      camIntentRef.current = false;
      try {
        await withTimeout(
          room.localParticipant.setCameraEnabled(false),
          10_000,
          "cam_mute_timeout",
        );
        setCamOn(false);
      } catch {
        camIntentRef.current = true;
        setCamError("خاموش کردن دوربین ممکن نشد؛ دوباره تلاش کن");
      }
      return;
    }
    camIntentRef.current = true;
    if (await captureCameraAt(desiredTier(), { enable: true })) {
      setCamOn(true);
    } else {
      camIntentRef.current = false;
      setCamError(camFailureMessage(mediaDeniedRef.current));
    }
  }, [camOn, captureCameraAt, desiredTier]);

  const switchCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room || tierBusyRef.current) return;
    // The camera must actually be live: flipping a muted/off camera has
    // nothing to restart (and iOS Safari refuses to open a camera without a
    // live capture to swap). The flip button is hidden while the camera is
    // off, so this only guards a tap racing the state update.
    if (!camIntentRef.current) return;
    const { Track } = livekit();
    const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
    const pubTrack = pub?.track;
    if (!pubTrack) return;
    // The live camera publication's track is a LocalVideoTrack. Restarting
    // it IN PLACE keeps the SAME publication — the remote side never
    // re-subscribes and the mic keeps flowing. LiveKit stops the old capture
    // first (required by Safari) and replaceTrack()s the sender, which is
    // also why the old hard unpublish/re-publish path glitched on Android.
    const camTrack = pubTrack as LocalVideoTrack;
    if (typeof camTrack.restartTrack !== "function") return;

    // Physical cameras with distinct ids (Android/desktop): cycle the list.
    let cams: MediaDeviceInfo[] = [];
    try {
      cams = (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === "videoinput" && d.deviceId)
        .filter((d, i, all) => all.findIndex((x) => x.deviceId === d.deviceId) === i);
    } catch {
      /* fall back to facingMode */
    }
    setCamCount(cams.length);
    const settings = pubTrack.mediaStreamTrack?.getSettings() ?? {};
    const curId = (settings.deviceId || lastCamIdRef.current) || "";
    const idx = cams.findIndex((d) => d.deviceId === curId);
    const nextId =
      cams.length >= 2 && idx >= 0 ? (cams[(idx + 1) % cams.length]?.deviceId ?? "") : "";

    // Safari (and browsers that only report one "camera") cannot switch by
    // device id — they honor facingMode. Toggle front <-> back from the
    // live track's own reported facing.
    const curFacing = facingOf(pubTrack.mediaStreamTrack) || "user";
    const wantFacing: "user" | "environment" =
      curFacing === "environment" ? "user" : "environment";
    // No distinct ids and not a phone-class device: nothing to flip to
    // (desktop single-webcam users never see the button).
    if (!nextId && !IS_PHONE && cams.length < 2) {
      setCamError("دوربین دومی پیدا نشد");
      return;
    }

    const plan = CAM_TIERS[captureTierRef.current] ?? CAM_TIERS[CAM_TIERS.length - 1];
    const base = { resolution: plan.resolution, frameRate: plan.frameRate };
    const previous = lastCamIdRef.current;
    const previousFacing = curFacing;
    const restart = (opts: { deviceId?: { exact: string }; facingMode?: "user" | "environment" }) =>
      withTimeout(camTrack.restartTrack({ ...base, ...opts }), 15_000, "cam_switch_timeout");

    tierBusyRef.current = true;
    setCamError(null);
    // Try in order: exact next device -> facing-mode toggle (covers iOS and
    // browsers whose ids do not actually switch) -> fresh full publish.
    // Stop at the first strategy that succeeds.
    const attempts: Array<() => Promise<unknown>> = [];
    if (nextId) attempts.push(() => restart({ deviceId: { exact: nextId } }));
    attempts.push(() => restart({ facingMode: wantFacing }));
    if (nextId && cams.length >= 2) {
      // Backstop: another distinct id (differs when curId pointed at the
      // last entry of the list).
      const alt = cams.find((d) => d.deviceId !== curId && d.deviceId !== nextId);
      if (alt) attempts.push(() => restart({ deviceId: { exact: alt.deviceId } }));
    }
    attempts.push(async () => {
      const ok = await captureCameraAt(captureTierRef.current, {
        enable: true,
        // This fallback runs while the switch already holds the busy lock;
        // force lets the fresh publish actually execute.
        force: true,
      });
      if (!ok) throw new Error("republish_failed");
    });

    let switched = false;
    for (const attempt of attempts) {
      try {
        await attempt();
        switched = true;
        break;
      } catch {
        /* try the next strategy */
      }
    }
    // Read the LIVE publication afterwards: in-place restarts keep the same
    // publication, but the fresh-publish fallback replaces it, so the stale
    // `pub` handle above would point at an ended track after a fallback.
    const nt =
      room.localParticipant.getTrackPublication(Track.Source.Camera)?.track?.mediaStreamTrack ??
      null;
    const realId = nt?.getSettings().deviceId ?? "";
    const newFacing = facingOf(nt);
    if (switched) {
      lastCamIdRef.current = realId || (nextId && !IS_PHONE ? nextId : "");
      setCamFacing(newFacing);
      setLocal(one(nt));
      setCamOn(true);
      // A "success" that landed back on the same physical camera (browser
      // kept its default; Safari duplicate-id cases) is reported honestly so
      // the user taps again instead of staring at no change.
      const changed =
        (nextId && realId !== "" && realId !== curId && realId !== previous) ||
        (!nextId && newFacing === wantFacing);
      if (!changed) setCamError("دوربین عوض نشد؛ دوباره امتحان کن");
    } else {
      lastCamIdRef.current = previous;
      setCamFacing(previousFacing);
      setCamError("تعویض دوربین ممکن نشد؛ دوباره تلاش کن");
    }
    tierBusyRef.current = false;
  }, [captureCameraAt]);

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
    const next = !sharingRef.current;
    // Some Android WebViews expose getDisplayMedia but never open a picker
    // (or the platform simply has no screen-capture API) — answer with a
    // clear message instead of a silent no-op.
    if (next && typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
      setShareError(
        IS_IOS
          ? "سافاری آیفون و آی‌پد اجازه نمی‌دهد وب‌سایت صفحهٔ گوشی را بفرستد؛ برای اشتراک صفحه از گوشی اندروید یا کامپیوتر استفاده کن."
          : IS_EMBEDDED
            ? "اشتراک صفحه در این نمای جاسازی‌شده قفل است؛ لینک اپ را مستقیم در مرورگر باز کن."
            : "اشتراک صفحه در این مرورگر پشتیبانی نمی‌شود؛ کروم یا فایرفاکس را امتحان کن.",
      );
      return;
    }
    if (next && IS_EMBEDDED) {
      setShareError("اشتراک صفحه در این نمای جاسازی‌شده قفل است؛ لینک اپ را مستقیم در مرورگر باز کن.");
      return;
    }
    shareBusyRef.current = true;
    try {
      setShareError(null);
      if (next) setShareStarting(true);
      try {
        const capture = () =>
          room.localParticipant.setScreenShareEnabled(
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
        // Bound the picker wait so the button always answers the user instead
        // of dying silently when the browser never shows/returns a picker.
        const pub = next ? await withTimeout(capture(), 20_000, "share_timeout") : await capture();
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
            msg === "share_timeout"
              ? IS_EMBEDDED
                ? "پنجرهٔ انتخاب صفحه باز نشد — این نمای جاسازی‌شده اجازهٔ اشتراک صفحه نمی‌دهد؛ اپ را مستقیم در مرورگر باز کن."
                : /Android/i.test(navigator.userAgent)
                  ? "در پنجرهٔ سیستم «شروع/ضبط» را بزن تا صفحه‌ات فرستاده شود."
                  : "انتخاب صفحه خیلی طول کشید؛ دوباره تلاش کن"
              : name === "NotAllowedError" || /permission|cancel/i.test(msg)
                ? IS_IOS
                  ? "سافاری آیفون اجازهٔ اشتراک صفحه نمی‌دهد؛ از اندروید یا کامپیوتر استفاده کن."
                  : /Android/i.test(navigator.userAgent)
                    ? "در پنجرهٔ سیستم «شروع/ضبط» را بزن تا اجازهٔ اشتراک داده شود."
                    : "برای اشتراک صفحه باید اجازه بدهی (گزینهٔ مورد نظر را انتخاب و تأیید کن)."
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
    camError,
    clearCamError,
    micError,
    clearMicError,
    canSwitchCamera: videoSessionActive && camOn && (camCount >= 2 || IS_PHONE),
    camFacing,
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
