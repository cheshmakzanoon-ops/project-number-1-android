import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Room, RoomEvent, Track } from "livekit-client";
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
  local: MediaStream | null;
  remote: MediaStream | null;
  screenLocal: MediaStream | null;
  screenRemote: MediaStream | null;
  error: string | null;
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

function one(media: MediaStreamTrack | null | undefined): MediaStream | null {
  return media ? new MediaStream([media]) : null;
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
  const [error, setError] = useState<string | null>(null);

  const roomRef = useRef<Room | null>(null);
  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const camTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const lastCamIdRef = useRef<string>("");
  const remoteAudioElsRef = useRef<Set<HTMLAudioElement>>(new Set());
  const localToggleRef = useRef(0);
  const disconnectingRef = useRef(false);
  const sawCallRef = useRef(false);
  const ringRef = useRef<AudioContext | null>(null);
  const ringTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const startCallMut = useMutation(api.calls.start);
  const endCallMut = useMutation(api.calls.end);
  const answerCallMut = useMutation(api.calls.answer);
  const getToken = useAction(api.livekit.getToken);

  /**
   * iOS/Safari only grant mic/camera if the request happens inside (or very
   * soon after) a user tap, before any slow network round-trips. We warm the
   * permission synchronously so the LiveKit connect that follows can't be
   * blocked, then release the tracks — LiveKit re-requests and reuses the grant.
   */
  const primeMedia = useCallback(async (kind: CallKind) => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: kind === "video",
      });
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

  const teardown = useCallback(() => {
    remoteAudioElsRef.current.forEach((el) => {
      el.pause();
      el.srcObject = null;
    });
    remoteAudioElsRef.current.clear();
    const room = roomRef.current;
    if (room) {
      disconnectingRef.current = true;
      try {
        room.disconnect();
      } catch {
        /* noop */
      }
      roomRef.current = null;
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
    setCamOn(false);
    setSharing(false);
    setRemoteMicOn(true);
    setRemoteCamOn(true);
  }, []);

  const stopRing = useCallback(() => {
    if (ringTimerRef.current != null) {
      window.clearInterval(ringTimerRef.current);
      ringTimerRef.current = null;
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

  const startRing = useCallback(() => {
    stopRing();
    try {
      const ctx = new AudioContext();
      ringRef.current = ctx;
      const gain = ctx.createGain();
      gain.gain.value = 0.15;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.connect(ctx.destination);
      osc.connect(gain);
      osc.start();
      ringTimerRef.current = window.setInterval(() => {
        gain.gain.value = gain.gain.value > 0.12 ? 0.05 : 0.18;
      }, 520);
    } catch {
      /* noop */
    }
  }, [stopRing]);

  useEffect(() => () => stopRing(), [stopRing]);

  // ---- Connect to a LiveKit room for a call ----
  const connectMedia = useCallback(
    async (callId: Id<"calls">, kind: CallKind): Promise<boolean> => {
      if (!token) return false;
      try {
        const { url, token: jwt } = await getToken({ token, callId });
        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
          publishDefaults: { videoCodec: "vp8" },
          videoCaptureDefaults: { resolution: { width: 1280, height: 720 }, frameRate: 30 },
          audioCaptureDefaults: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        roomRef.current = room;

        room.on(RoomEvent.LocalTrackPublished, (publication) => {
          if (publication.source === Track.Source.Camera) setLocal(one(publication.track?.mediaStreamTrack));
          else if (publication.source === Track.Source.ScreenShare) setScreenLocal(one(publication.track?.mediaStreamTrack));
        });
        room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
          if (publication.source === Track.Source.Camera) setLocal(null);
          else if (publication.source === Track.Source.ScreenShare) setScreenLocal(null);
        });
        room.on(RoomEvent.TrackSubscribed, (track, publication) => {
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
        const toggleGuard = () => Date.now() - localToggleRef.current < 500;
        room.on(RoomEvent.TrackMuted, (publication) => {
          if (toggleGuard()) return;
          if (publication.source === Track.Source.Camera) setRemoteCamOn(false);
          else if (publication.source === Track.Source.Microphone) setRemoteMicOn(false);
        });
        room.on(RoomEvent.TrackUnmuted, (publication) => {
          if (toggleGuard()) return;
          if (publication.source === Track.Source.Camera) setRemoteCamOn(true);
          else if (publication.source === Track.Source.Microphone) setRemoteMicOn(true);
        });
        room.on(RoomEvent.Disconnected, () => {
          roomRef.current = null;
          if (!disconnectingRef.current) cleanup();
          disconnectingRef.current = false;
        });

        await room.connect(url, jwt);
        localToggleRef.current = Date.now();
        await Promise.allSettled([
          kind === "video" ? room.localParticipant.setCameraEnabled(true) : Promise.resolve(),
          room.localParticipant.setMicrophoneEnabled(true),
        ]);
        localToggleRef.current = 0;
        setError(null);
        return true;
      } catch (e) {
        try {
          roomRef.current?.disconnect();
        } catch {
          /* noop */
        }
        roomRef.current = null;
        setError(e instanceof Error && e.message === "livekit_not_configured" ? "livekit_not_configured" : "call_failed");
        return false;
      }
    },
    [cleanup, getToken, rebuildRemote, speakerOn, token],
  );

  // ---- Reconcile call lifecycle from Convex ----
  // How long a ringing call is allowed to sit unanswered before it's treated
  // as missed, so a stale call never rings forever on the callee's phone or
  // hangs forever on the caller's screen.
  const RING_TTL = 45_000;
  const CALLER_RING_TTL = 60_000;

  useEffect(() => {
    if (!myCalls) return;
    if (!token) return; // myCalls is only defined when a token exists
    const cur = sessionRef.current;
    const curCall = cur?.callId;

    if (cur && curCall && !myCalls.some((c) => c.callId === curCall)) {
      if (sawCallRef.current) cleanup();
      return;
    }
    const call = myCalls[0];
    if (!call) {
      if (cur && sawCallRef.current) cleanup();
      return;
    }
    sawCallRef.current = true;

    const ringing = call.status === "ringing";
    const isIncomingForMe = !call.initiatedByMe;
    const myPhase = cur?.phase ?? "idle";

    // An unanswered incoming ring that has outlived its TTL: swallow it now.
    if (isIncomingForMe && ringing && myPhase !== "active" && Date.now() - call.startedAt > RING_TTL) {
      void endCallMut({ callId: call.callId, token, status: "missed" });
      cleanup();
      return;
    }

    // An outgoing call that rings too long and no one ever answers: hang up.
    if (!isIncomingForMe && ringing && cur?.phase === "outgoing" && Date.now() - call.startedAt > CALLER_RING_TTL) {
      void endCallMut({ callId: call.callId, token, status: "missed" });
      cleanup();
      return;
    }

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
      return;
    }
    if (!isIncomingForMe && call.status === "active" && cur?.phase === "outgoing") {
      stopRing();
      setSession({ ...cur, phase: "active" });
    }
  }, [myCalls, cleanup, startRing, stopRing, endCallMut, token]);

  const startCall = useCallback(
    async (
      conversationId: Id<"conversations">,
      otherId: Id<"users">,
      otherName: string,
      otherColor: string,
      kind: CallKind,
    ) => {
      if (!token) return;
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
      const ok = await connectMedia(callId, kind);
      if (!ok) {
        try {
          await endCallMut({ callId, token, status: "declined" });
        } catch {
          /* noop */
        }
        cleanup();
      }
    },
    [cleanup, connectMedia, endCallMut, primeMedia, startCallMut, token],
  );

  const accept = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !token) return;
    await primeMedia(s.kind);
    stopRing();
    try {
      await answerCallMut({ callId: s.callId, token });
    } catch {
      /* noop */
    }
    const ok = await connectMedia(s.callId, s.kind);
    if (ok) {
      setSession({ ...s, phase: "active" });
    } else {
      try {
        await endCallMut({ callId: s.callId, token, status: "ended" });
      } catch {
        /* noop */
      }
      cleanup();
    }
  }, [answerCallMut, cleanup, connectMedia, endCallMut, primeMedia, stopRing, token]);

  const decline = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !token) return;
    stopRing();
    try {
      await endCallMut({ callId: s.callId, token, status: "declined" });
    } catch {
      /* noop */
    }
    cleanup();
  }, [cleanup, endCallMut, stopRing, token]);

  const hangup = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || !token) return;
    stopRing();
    const wasActive = s.phase === "active";
    try {
      await endCallMut({ callId: s.callId, token, status: wasActive ? "ended" : "declined" });
    } catch {
      /* noop */
    }
    cleanup();
  }, [cleanup, endCallMut, stopRing, token]);

  // ---- Controls (routed through LiveKit) ----
  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !micOn;
    localToggleRef.current = Date.now();
    try {
      await room.localParticipant.setMicrophoneEnabled(next);
    } catch {
      /* noop */
    }
    setMicOn(next);
  }, [micOn]);

  const toggleCam = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !camOn;
    localToggleRef.current = Date.now();
    try {
      await room.localParticipant.setCameraEnabled(next);
    } catch {
      /* noop */
    }
    setCamOn(next);
  }, [camOn]);

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
    try {
      await room.localParticipant.setScreenShareEnabled(!sharing);
      setSharing(!sharing);
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
  };
}