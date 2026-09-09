import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  CameraOff,
  Camera,
  ExternalLink,
  FlipHorizontal,
  Maximize,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  Phone,
  PhoneOff,
  Users,
  Volume2,
  X,
} from "lucide-react";
import { Avatar } from "./Avatar";
import { RemoteVideoFeed } from "./RemoteVideoFeed";
import { fa } from "../lib/format";
import { IS_EMBEDDED, openAppTopLevel } from "../lib/browser";
import type { CallSession, GarmaCallkit, RemotePeer } from "../lib/useCallkit";

function useElapsed(phase: CallSession["phase"]) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (phase === "outgoing" || phase === "active") {
      const start = Date.now();
      const id = window.setInterval(() => setT(Math.floor((Date.now() - start) / 1000)), 1000);
      return () => window.clearInterval(id);
    }
    setT(0);
  }, [phase]);
  return t;
}

const FORMAT_TIME = (s: number) => {
  const mm = Math.floor(s / 60)
    .toString()
    .padStart(2, "0");
  const ss = (s % 60).toString().padStart(2, "0");
  return fa(`${mm}:${ss}`);
};

export function CallOverlay({
  kit,
  onMinimize,
  hidden = false,
}: {
  kit: GarmaCallkit;
  onMinimize: () => void;
  /** Keep the component mounted (timer keeps ticking, media keeps flowing)
   * but visually hide it — used for the minimized in-call pill. */
  hidden?: boolean;
}) {
  const session = kit.session!;
  const { phase, kind } = session;
  const elapsed = useElapsed(phase);
  const active = phase === "active";
  const incoming = phase === "incoming";
  const showVideo = kind === "video";
  const containerRef = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);
  const busy = kit.busy;

  // Inside an embedded frame (the dev preview pane) browsers withhold
  // camera/mic/screen capture, so those controls fail however often they are
  // tapped. Explain once and offer to open the app in a real top-level tab.
  const [hintDismissed, setHintDismissed] = useState(false);
  const [hintNote, setHintNote] = useState(false);
  const needsMediaHint = showVideo || !!kit.camError || !!kit.micError || !!kit.shareError;

  useEffect(() => {
    const onFullscreen = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  // Defensive: a session built from a row is always normalized to have a
  // peers array, but a crash here unmounts the app to a black screen — so
  // never trust it blindly.
  const sessionPeers = session.peers ?? [];
  const joinedPeers = sessionPeers.filter((p) => p.joined);
  const firstPeer = sessionPeers[0];
  // Who this screen is "about": the caller for an incoming ring, the person
  // being called for an outgoing one, and the single other person (or a
  // generic label) mid-call.
  const titleName = incoming
    ? session.callerName
    : joinedPeers.length === 1
      ? joinedPeers[0].displayName
      : firstPeer?.displayName ?? "…";
  const titleColor = incoming
    ? session.callerColor
    : joinedPeers.length === 1
      ? joinedPeers[0].themeColor
      : firstPeer?.themeColor ?? "#8a6340";
  const isGroup = sessionPeers.length > 1;
  const groupCount = sessionPeers.length + 1; // includes me

  // Keep the screen awake during a call (Zoom-style "always on") where the
  // browser supports the Screen Wake Lock API. No-op on iOS Safari.
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } };
    if (!nav.wakeLock) return;
    let sentinel: { release: () => Promise<void> } | null = null;
    const request = () => {
      if (sentinel) return;
      nav.wakeLock!.request("screen")
        .then((s) => {
          sentinel = s;
        })
        .catch(() => {});
    };
    request();
    const onVis = () => {
      if (document.visibilityState === "visible") request();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (sentinel) sentinel.release().catch(() => {});
      sentinel = null;
    };
  }, []);

  // Auto-dismiss the screen-share error toast after a few seconds.
  const [showShareErr, setShowShareErr] = useState(false);
  useEffect(() => {
    if (!kit.shareError) {
      setShowShareErr(false);
      return;
    }
    setShowShareErr(true);
    const t = window.setTimeout(() => {
      setShowShareErr(false);
      kit.clearShareError();
    }, 5000);
    return () => window.clearTimeout(t);
  }, [kit.shareError, kit]);

  // Auto-dismiss the camera error toast after a few seconds.
  const [showCamErr, setShowCamErr] = useState(false);
  useEffect(() => {
    if (!kit.camError) {
      setShowCamErr(false);
      return;
    }
    setShowCamErr(true);
    const t = window.setTimeout(() => {
      setShowCamErr(false);
      kit.clearCamError();
    }, 5000);
    return () => window.clearTimeout(t);
  }, [kit.camError, kit]);

  // Auto-dismiss the mic failure toast after a few seconds.
  const [showMicErr, setShowMicErr] = useState(false);
  useEffect(() => {
    if (!kit.micError) {
      setShowMicErr(false);
      return;
    }
    setShowMicErr(true);
    const t = window.setTimeout(() => {
      setShowMicErr(false);
      kit.clearMicError();
    }, 6000);
    return () => window.clearTimeout(t);
  }, [kit.micError, kit]);

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      setFs(false);
    } else {
      el.requestFullscreen?.().catch(() => {});
    }
  };

  return (
    <div
      ref={containerRef}
      className={`safe-area fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#120a05] text-white ${
        hidden ? "invisible pointer-events-none" : ""
      }`}
    >
      {/* ambient warm glow for audio/incoming */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(620px 440px at 50% 16%, rgba(234,138,62,0.25), transparent 60%), radial-gradient(500px 400px at 100% 110%, rgba(93,156,115,0.12), transparent 55%)",
        }}
      />

      {/* Embedded-preview lock explanation with an "open directly" escape.
          Only ever shown when the app is inside an iframe (dev preview); a
          normal top-level tab or installed app never sees it. */}
      {IS_EMBEDDED && !hintDismissed && needsMediaHint && (
        <div className="animate-rise absolute inset-x-3 top-16 z-40 flex justify-center">
          <div className="flex w-full max-w-sm flex-col gap-2 rounded-2xl border border-amber-300/30 bg-[#241206]/95 px-3.5 py-2.5 shadow-2xl shadow-black/50 backdrop-blur-xl">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-400/20 text-amber-200">
                <ExternalLink size={15} />
              </span>
              <p className="min-w-0 flex-1 pt-1 text-[12px] font-extrabold leading-5 text-amber-50">
                دوربین و اشتراک صفحه در پیش‌نمایش قفل‌اند
              </p>
              <button
                onClick={() => setHintDismissed(true)}
                aria-label="بستن"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white"
              >
                <X size={14} />
              </button>
            </div>
            <p className="pr-[42px] text-[11px] leading-5 text-white/70">
              مرورگر داخل کادر پیش‌نمایش اجازهٔ دوربین، میکروفون و صفحه را نمی‌دهد؛ اپ را در تب جدید
              باز کن تا اجازه‌ها درخواست شود.
            </p>
            <div className="mr-auto flex items-center gap-2">
              <button
                onClick={() => {
                  if (!openAppTopLevel()) setHintNote(true);
                }}
                className="flex items-center gap-1.5 rounded-full bg-amber-400 px-3.5 py-1.5 text-[12px] font-extrabold text-cocoa shadow-md shadow-black/30 transition hover:bg-amber-300 active:scale-95"
              >
                <ExternalLink size={13} />
                باز کردن اپ در تب جدید
              </button>
              {hintNote && (
                <span className="text-[10px] font-semibold leading-4 text-amber-200/85">
                  اگر تب باز نشد، دکمهٔ «باز کردن در تب جدید» را بالای پیش‌نمایش بزن.
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* NOTE: remote audio plays through exactly ONE element per person (the
          audio elements useCallkit attaches on TrackSubscribed). The video
          tiles below are muted on purpose — playing the mic track through
          them too caused doubled, phasey audio on every call. */}
      {kit.reconnecting && active && (
        <div className="absolute inset-x-0 top-14 z-30 flex justify-center">
          <span className="animate-pulse rounded-full border border-amber-300/30 bg-amber-500/20 px-4 py-1.5 text-xs font-bold text-amber-200 backdrop-blur">
            اتصال ضعیف است — در حال بازیابی…
          </span>
        </div>
      )}

      {/* share failure toast */}
      {showShareErr && kit.shareError && (
        <div className="absolute inset-x-0 top-20 z-40 flex justify-center px-4">
          <span className="animate-rise flex items-center gap-2 rounded-full border border-rose-400/30 bg-rose-500/25 px-4 py-2 text-xs font-bold text-rose-100 backdrop-blur">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose-500 text-[10px] font-black text-white">
              !
            </span>
            {kit.shareError}
          </span>
        </div>
      )}

      {/* camera failure toast */}
      {showCamErr && kit.camError && (
        <div className="absolute inset-x-0 top-40 z-40 flex justify-center px-4">
          <span className="animate-rise flex items-center gap-2 rounded-full border border-rose-400/30 bg-rose-500/25 px-4 py-2 text-xs font-bold text-rose-100 backdrop-blur">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose-500 text-[10px] font-black text-white">
              !
            </span>
            {kit.camError}
          </span>
        </div>
      )}

      {/* mic failure toast */}
      {showMicErr && kit.micError && (
        <div className="absolute inset-x-0 top-60 z-40 flex justify-center px-4">
          <span className="animate-rise flex items-center gap-2 rounded-full border border-rose-400/30 bg-rose-500/25 px-4 py-2 text-xs font-bold text-rose-100 backdrop-blur">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose-500 text-[10px] font-black text-white">
              !
            </span>
            {kit.micError}
          </span>
        </div>
      )}

      {/* -------- INCOMING / OUTGOING / JOIN OFFER (pre-connect) -------- */}
      {!active && (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6">
          <p className="mb-6 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold tracking-wide text-white/70 backdrop-blur">
            {incoming && session.joinOffer
              ? "در جریان است"
              : incoming
                ? kind === "video"
                  ? "تماس تصویری ورودی"
                  : "تماس صوتی ورودی"
                : isGroup
                  ? kind === "video"
                    ? "تماس گروهی تصویری"
                    : "تماس گروهی صوتی"
                  : "تماس با گرما"}
          </p>
          <div className={incoming ? "animate-ring rounded-[48px]" : ""}>
            <div className="rounded-[48px] bg-gradient-to-br from-ember-400/30 to-sage-400/20 p-2">
              {isGroup && !incoming ? (
                <div className="grid h-[136px] w-[136px] place-items-center rounded-[48px] bg-gradient-to-br from-[#3a250f] to-[#241408] ring-1 ring-ember-300/25">
                  <Users size={56} className="text-ember-300" />
                </div>
              ) : (
                <Avatar name={titleName} color={titleColor} size={136} />
              )}
            </div>
          </div>
          <h2 className="mt-7 text-center text-3xl font-black drop-shadow-sm">
            {incoming || !isGroup ? titleName : `${groupCount} نفر`}
          </h2>
          {isGroup && !incoming && (
            <p className="mt-1 max-w-[19rem] truncate text-sm text-white/55">
              {sessionPeers.map((p) => p.displayName).join("، ")}
            </p>
          )}
          <p className="mt-3 text-center text-lg text-white/70">
            {incoming ? (
              session.joinOffer ? (
                joinedPeers.length > 0 ? (
                  <>
                    <span className="font-bold text-sage-300">{joinedPeers.map((p) => p.displayName).join(" و ")}</span>{" "}
                    در تماس‌اند — تو هم بپیوند
                  </>
                ) : (
                  "به این تماس بپیوند"
                )
              ) : isGroup ? (
                <>
                  <span className="font-bold text-sage-300">{session.callerName}</span> تماس {kind === "video" ? "گروهی تصویری" : "گروهی صوتی"} گرفته
                </>
              ) : kind === "video" ? (
                <>می‌خواهد با تو گفتگو کند</>
              ) : (
                <>می‌خواهد با تو حرف بزند</>
              )
            ) : (
              "در حال زنگ زدن…"
            )}
          </p>
          <p className="mt-1 text-sm tabular-nums text-white/40">{FORMAT_TIME(elapsed)}</p>

          <div className="mt-14 flex items-center gap-10">
            {incoming ? (
              <>
                <ColAction
                  label="رد کردن"
                  tone="rose"
                  onClick={kit.decline}
                  // CANCELLATION AVAILABILITY: decline stays tappable while
                  // accept is connecting; the hook drops duplicate taps.
                >
                  <PhoneOff size={26} style={{ transform: "scaleX(-1)" }} />
                </ColAction>
                <ColAction
                  label={busy ? "در حال اتصال…" : session.joinOffer ? "پیوستن" : "پاسخ"}
                  tone="sage"
                  onClick={kit.accept}
                  disabled={busy}
                >
                  <Phone size={28} style={{ transform: "scaleX(-1)" }} />
                </ColAction>
              </>
            ) : (
              <ColAction
                label={busy ? "در حال قطع…" : "قطع کردن"}
                tone="rose"
                onClick={kit.hangup}
                // CANCELLATION AVAILABILITY: hangup stays tappable while the
                // outgoing call is connecting; the hook drops duplicate taps.
              >
                <PhoneOff size={26} style={{ transform: "scaleX(-1)" }} />
              </ColAction>
            )}
          </div>
        </div>
      )}

      {/* -------- ACTIVE VIDEO -------- */}
      {active && showVideo && (
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">            {/* main region */}
            <div className="relative flex-1 overflow-hidden bg-[#120a05]">
              <VideoStage kit={kit} session={session} elapsed={elapsed} visible={!hidden} />
            </div>

          {/* control center */}
          <div className="relative z-20 px-4 pb-6 pt-2">
            <div className="mx-auto flex w-fit max-w-full items-center gap-1.5 overflow-x-auto rounded-[2.2rem] border border-white/10 bg-[#140b05]/60 px-3 py-2.5 shadow-2xl backdrop-blur-xl">
              <CtrlBtn on={kit.micOn} onClick={kit.toggleMic} label={kit.micOn ? "سکوت" : "صدا"}>
                {kit.micOn ? <Mic size={22} /> : <MicOff size={22} />}
              </CtrlBtn>
              <CtrlBtn on={kit.camOn} onClick={kit.toggleCam} label={kit.camOn ? "خاموش" : "دوربین"}>
                {kit.camOn ? <Camera size={22} /> : <CameraOff size={22} />}
              </CtrlBtn>
              {kit.canSwitchCamera && (
                <CtrlBtn label="تعویض دوربین" onClick={kit.switchCamera}>
                  <FlipHorizontal size={22} />
                </CtrlBtn>
              )}
              <CtrlBtn
                on={kit.sharing}
                spin={kit.shareStarting}
                label={kit.sharing ? "پایان اشتراک" : "اشتراک صفحه"}
                onClick={kit.toggleShare}
              >
                <MonitorUp size={22} />
              </CtrlBtn>
              <CtrlBtn label="تمام‌صفحه" onClick={toggleFullscreen}>
                {fs ? <Minimize2 size={22} /> : <Maximize size={22} />}
              </CtrlBtn>
              <CtrlBtn label="صفحه اصلی" onClick={onMinimize}>
                <Minimize2 size={22} />
              </CtrlBtn>
              <button
                onClick={kit.hangup}
                aria-label="پایان تماس"
                className="ml-2 grid h-14 w-14 shrink-0 place-items-center rounded-full bg-rose-500 text-white shadow-lg shadow-rose-500/40 transition hover:bg-rose-600 active:scale-90"
              >
                <PhoneOff size={25} style={{ transform: "scaleX(-1)" }} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* -------- ACTIVE AUDIO ONLY -------- */}
      {active && !showVideo && (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-between py-8">
          <div className="mt-6 flex flex-col items-center px-6">
            {joinedPeers.length <= 1 ? (
              <>
                <div className="animate-ring rounded-[48px]">
                  <div className="rounded-[48px] bg-gradient-to-br from-ember-400/30 to-sage-400/20 p-2">
                    <Avatar
                      name={joinedPeers[0]?.displayName ?? firstPeer?.displayName ?? session.callerName}
                      color={joinedPeers[0]?.themeColor ?? firstPeer?.themeColor ?? session.callerColor}
                      size={132}
                    />
                  </div>
                </div>
                <h2 className="mt-6 text-3xl font-black drop-shadow-sm">
                  {joinedPeers[0]?.displayName ?? session.callerName}
                </h2>
              </>
            ) : (
              <>
                <div className="rounded-[32px] bg-gradient-to-br from-ember-400/25 to-sage-400/15 p-2 ring-1 ring-ember-300/20">
                  <Users size={44} className="text-ember-300" />
                </div>
                <h2 className="mt-5 text-3xl font-black drop-shadow-sm">{fa(groupCount)} نفر در تماس گروهی</h2>
              </>
            )}
            <div className="mt-3 flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-white/70 backdrop-blur">
              <span className="h-2 w-2 animate-pulse rounded-full bg-sage-400" />
              {FORMAT_TIME(elapsed)}
            </div>

            {/* participant list */}
            <div className="mt-6 flex w-full max-w-sm flex-col items-center gap-2">
              {sessionPeers
                .filter((p) => p.joined)
                .map((peer) => {
                  const live = kit.remotes.find((r) => r.userId === peer.userId);
                  const muted = live ? !live.micOn : false;
                  return (
                    <div
                      key={peer.userId}
                      className="flex w-full max-w-xs items-center gap-3 rounded-2xl border border-white/8 bg-white/5 px-3 py-2 backdrop-blur"
                    >
                      <Avatar name={peer.displayName} color={peer.themeColor} size={38} />
                      <span className="min-w-0 flex-1 truncate text-sm font-bold">{peer.displayName}</span>
                      <span className="flex items-center gap-1 text-[11px] text-white/55">
                        {!live ? (
                          // Joined on the server but no media part yet (still
                          // connecting, or just left): never paint a green
                          // "در تماس" for someone whose stream is not live.
                          <>
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/40" /> در حال اتصال…
                          </>
                        ) : muted ? (
                          <>
                            <MicOff size={13} className="text-rose-300" /> بی‌صدا
                          </>
                        ) : (
                          <>
                            <span className="h-1.5 w-1.5 rounded-full bg-sage-400" /> در تماس
                          </>
                        )}
                      </span>
                    </div>
                  );
                })}
            </div>
          </div>

          <div className="flex items-end gap-4 px-4">
            <div className="flex items-center gap-2 rounded-[2rem] border border-white/10 bg-[#140b05]/60 px-4 py-3 shadow-2xl backdrop-blur-xl">
              <CtrlBtn on={kit.micOn} onClick={kit.toggleMic} label={kit.micOn ? "سکوت" : "صدا"}>
                {kit.micOn ? <Mic size={22} /> : <MicOff size={22} />}
              </CtrlBtn>
              <CtrlBtn on={kit.speakerOn} label={kit.speakerOn ? "بلندگو" : "بی‌صدا"} onClick={kit.toggleSpeaker}>
                <Volume2 size={22} />
              </CtrlBtn>
              <CtrlBtn label="صفحه اصلی" onClick={onMinimize}>
                <Minimize2 size={22} />
              </CtrlBtn>
            </div>
            <button
              onClick={kit.hangup}
              // CANCELLATION AVAILABILITY: the red button never locks out —
              // ending a call must always be possible (hook drops dupes).
              aria-label="پایان تماس"
              className={`grid shrink-0 place-items-center rounded-full text-white shadow-lg shadow-rose-500/40 transition ${
                busy ? "cursor-wait opacity-60" : "bg-rose-500 hover:bg-rose-600 active:scale-90"
              }`}
              style={{ width: 68, height: 68 }}
            >
              <PhoneOff size={27} style={{ transform: "scaleX(-1)" }} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The central video area: spotlight for one stream, a grid for many. */
function VideoStage({
  kit,
  session,
  elapsed,
  visible,
}: {
  kit: GarmaCallkit;
  session: CallSession;
  elapsed: number;
  /** Remote video elements attach only while the overlay is not minimized. */
  visible: boolean;
}) {
  const joinedPeers = (session.peers ?? []).filter((p) => p.joined);
  const videoSources = joinedPeers.filter((peer) => {
    const live = kit.remotes.find((r) => r.userId === peer.userId);
    return Boolean(live && (live.cam || live.screen));
  });
  // Grid whenever more than one OTHER person is on the call. The old
  // video-count-only rule let a 3-way call where one remote has their camera
  // off drop that participant off the screen entirely (spotlight showed only
  // the one live video, and the audio-only family member vanished). In a
  // grid everyone gets a tile — live video or a name tile — and my own
  // preview/screen joins it.
  const gridMode = joinedPeers.length > 1;

  if (!gridMode && videoSources.length === 1 && joinedPeers.length <= 2) {
    // Spotlight: one remote person, camera or screen share fills the screen.
    const target = videoSources[0];
    const live = kit.remotes.find((r) => r.userId === target.userId);
    return (
      <SpotlightFeed
        kit={kit}
        live={live}
        name={target.displayName}
        color={target.themeColor}
        localPreview={!kit.sharing}
        visible={visible}
      />
    );
  }

  if (joinedPeers.length === 0) {
    // Everyone left / waiting for the first person to come online.
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-[radial-gradient(circle_at_50%_30%,#2e2118,#0f0a06)]">
        <Avatar
          name={session.peers?.[0]?.displayName ?? session.callerName}
          color={session.peers?.[0]?.themeColor ?? session.callerColor}
          size={116}
        />
        <p className="mt-4 text-sm text-white/55">در انتظار پیوستن بقیه…</p>
      </div>
    );
  }

  // Grid: a tile per joined participant (video-less peers get an avatar tile).
  const tiles = joinedPeers.map((peer) => {
    const live = kit.remotes.find((r) => r.userId === peer.userId);
    return (
      <GridTile
        key={peer.userId}
        peer={live}
        name={peer.displayName}
        color={peer.themeColor}
        visible={visible}
      />
    );
  });

  return (
    <div className="flex h-full flex-col">
      {/* top info chips */}
      <div className="absolute inset-x-4 top-4 z-10 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#140b05]/60 px-3 py-1.5 text-xs backdrop-blur">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sage-400" />
          </span>
          <span className="font-bold">{fa(joinedPeers.length + 1)} نفر</span>
          <span className="tabular-nums opacity-70">{FORMAT_TIME(elapsed)}</span>
        </div>
        {kit.sharing && (
          <span className="flex items-center gap-1.5 rounded-full border border-sage-400/30 bg-sage-600/80 px-3 py-1.5 text-xs font-bold">
            <MonitorUp size={13} /> در حال اشتراک…
          </span>
        )}
      </div>

      <div className="grid h-full min-h-0 grid-cols-2 gap-1.5 p-1.5">
        {tiles}
        {/* my own tile in the grid: the shared screen while sharing (with an
            inline stop control — the sharer must see + be able to end what
            everyone else is watching), otherwise my camera preview */}
        {kit.sharing && kit.screenLocal ? (
          <div className="relative min-h-0 overflow-hidden rounded-xl border border-sage-400/40 bg-[#170e06]">
            <LocalVideoFeed stream={kit.screenLocal} className="h-full w-full bg-black object-contain" />
            <span className="absolute right-1.5 top-1.5 rounded-full bg-sage-600/90 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur">
              من
            </span>
            <button
              onClick={kit.toggleShare}
              className="absolute inset-x-1.5 bottom-1.5 rounded-full bg-rose-500/95 py-1.5 text-[11px] font-bold text-white backdrop-blur transition hover:bg-rose-600 active:scale-95"
            >
              پایان اشتراک صفحه
            </button>
          </div>
        ) : kit.camOn && kit.local ? (
          <div className="relative min-h-0 overflow-hidden rounded-xl border border-white/10 bg-[#170e06]">
            <LocalVideoFeed
              stream={kit.local}
              className="h-full w-full object-cover"
              style={{ transform: kit.camFacing === "environment" ? "none" : "scaleX(-1)" }}
            />
            <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white/80 backdrop-blur">
              من
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Full-bleed single-remote layout (1:1 calls keep their familiar look). */
function SpotlightFeed({
  kit,
  live,
  name,
  color,
  localPreview,
  visible,
}: {
  kit: GarmaCallkit;
  live: RemotePeer | undefined;
  name: string;
  color: string;
  localPreview: boolean;
  visible: boolean;
}) {
  // Screen always outranks camera in the spotlight; the renderer picks the
  // actual SDK track that occupies the chosen source.
  const screenTrack = live?.screen && live.screenOn ? live.screen : null;
  const cameraTrack = live?.cam && live.camOn ? live.cam : null;
  return (
    <div className="relative h-full w-full">
      {screenTrack ? (
        <>
          <RemoteVideoFeed
            track={screenTrack}
            source="screen"
            visible={visible}
            className="absolute inset-0 h-full w-full bg-[#170e06] object-contain"
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
            <span className="flex items-center gap-2 rounded-full bg-black/55 px-4 py-2 text-sm backdrop-blur">
              <MonitorUp size={17} /> اشتراک صفحهٔ {name}
            </span>
          </div>
        </>
      ) : cameraTrack ? (
        <RemoteVideoFeed
          track={cameraTrack}
          source="camera"
          visible={visible}
          className="absolute inset-0 h-full w-full bg-[#170e06] object-cover"
        />
      ) : (
        // Absent track = connecting/unavailable picture; a retained camera
        // track plus its mute flag is the only proof of a real camera-off.
        <div className="flex h-full w-full flex-col items-center justify-center bg-[radial-gradient(circle_at_50%_30%,#2e2118,#0f0a06)]">
          <div className="rounded-[40px] bg-gradient-to-br from-ember-400/30 to-sage-400/15 p-2">
            {live && !live.camOn && live.cam ? (
              <div className="grid h-28 w-28 place-items-center rounded-[40px] bg-[#241408]/80">
                <CameraOff size={44} className="text-white/40" />
              </div>
            ) : (
              <Avatar name={name} color={color} size={116} />
            )}
          </div>
          <p className="mt-4 text-sm text-white/55">
            {live && !live.camOn && live.cam
              ? `دوربین ${name} خاموش است`
              : "در حال اتصال تصویر…"}
          </p>
        </div>
      )}

      {/* header chips */}
      <div className="absolute inset-x-4 top-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#140b05]/60 px-3 py-1.5 text-xs backdrop-blur">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sage-400" />
          </span>
          <span className="font-bold">{name}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {kit.camQuality && kit.camOn && (
            <button
              type="button"
              onClick={kit.cycleQuality}
              title="کیفیت تصویر دوربین تو — برای تغییر ضربه بزن"
              aria-label="تغییر کیفیت دوربین"
              className="flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-[#140b05]/70 px-2.5 py-1 text-[11px] font-bold tracking-wide text-sage-300 backdrop-blur transition hover:border-sage-400/40 hover:text-sage-200 active:scale-95"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-sage-400" />
              {fa(kit.camQuality)}
            </button>
          )}
          {live && !live.micOn && <Badge icon={<MicOff size={13} />} />}
          {live && !live.camOn && <Badge icon={<CameraOff size={13} />} />}
        </div>
      </div>

      {/* local preview / share preview corner (always a browser stream) */}
      {kit.sharing && kit.screenLocal ? (
        <div className="absolute bottom-5 left-4 z-10 w-44 overflow-hidden rounded-2xl border border-sage-400/40 bg-[#170e06] shadow-2xl">
          <LocalVideoFeed
            stream={kit.screenLocal}
            className="aspect-video w-full bg-black object-contain"
          />
          <button
            onClick={kit.toggleShare}
            className="absolute inset-x-1 bottom-1 rounded-full bg-rose-500/95 py-1.5 text-[11px] font-bold text-white backdrop-blur transition hover:bg-rose-600 active:scale-95"
          >
            پایان اشتراک صفحه
          </button>
        </div>
      ) : kit.camOn && kit.local && localPreview ? (
        <div className="absolute bottom-5 left-4 z-10 overflow-hidden rounded-2xl border border-white/15 bg-[#170e06] shadow-2xl">
          <LocalVideoFeed
            stream={kit.local}
            className="h-40 w-28 object-cover"
            style={{ transform: kit.camFacing === "environment" ? "none" : "scaleX(-1)" }}
          />
          <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-semibold text-white/80 backdrop-blur">
            من
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** One participant's tile in a group video call. */
function GridTile({
  peer,
  name,
  color,
  visible,
}: {
  peer: RemotePeer | undefined;
  name: string;
  color: string;
  visible: boolean;
}) {
  // Screen first, otherwise camera, otherwise an avatar tile. Never mirrors
  // remote video (only the local self-preview mirrors).
  const screenTrack = peer?.screen && peer.screenOn ? peer.screen : null;
  const cameraTrack = peer?.cam && peer.camOn ? peer.cam : null;
  const content = screenTrack
    ? { track: screenTrack, source: "screen" as const }
    : cameraTrack
      ? { track: cameraTrack, source: "camera" as const }
      : null;
  return (
    <div className="relative min-h-0 overflow-hidden rounded-xl border border-white/10 bg-[#170e06]">
      {content ? (
        <RemoteVideoFeed
          track={content.track}
          source={content.source}
          visible={visible}
          className="h-full w-full bg-[#170e06] object-contain"
        />
      ) : (
        <div className="grid h-full w-full place-items-center bg-[radial-gradient(circle_at_50%_35%,#2b1c10,#120a05)]">
          <div className="flex flex-col items-center gap-2 px-2">
            <Avatar name={name} color={color} size={64} />
          </div>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-4">
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-bold">
          {peer?.screen && peer.screenOn && <MonitorUp size={12} className="shrink-0 text-sage-300" />}
          <span className="truncate">{name}</span>
        </span>
        {peer && !peer.micOn && <MicOff size={12} className="ml-auto shrink-0 text-rose-300" />}
        {peer && !peer.camOn && peer.cam && <CameraOff size={12} className="shrink-0 text-rose-300" />}
      </div>
    </div>
  );
}

/** LOCAL media only: assigns an owned browser stream to the element's
 *  srcObject. Remote video never goes through here — it uses
 *  RemoteVideoFeed (SDK attach). Audio uses useCallkit's own element. */
function LocalVideoFeed({
  stream,
  className,
  style,
}: {
  stream: MediaStream;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      el.srcObject = stream;
    } catch {
      /* noop */
    }
    return () => {
      // Element-only cleanup: pause and clear only when the element still
      // references THIS stream. Never stops the local capture tracks.
      try {
        if (el.srcObject === stream) {
          el.pause();
          el.srcObject = null;
        }
      } catch {
        /* noop */
      }
    };
  }, [stream]);
  return <video ref={ref} autoPlay playsInline muted className={className} style={style} />;
}

function Badge({ icon }: { icon: ReactNode }) {
  return (
    <span className="grid h-7 w-7 place-items-center rounded-full border border-white/10 bg-[#140b05]/70 text-white/80 backdrop-blur">
      {icon}
    </span>
  );
}

/** A single, clearly visible in-call control button. */
function CtrlBtn({
  children,
  onClick,
  label,
  on = true,
  spin = false,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  on?: boolean;
  spin?: boolean;
}) {
  return (
    <div className="flex w-14 shrink-0 flex-col items-center gap-1">
      <button
        onClick={onClick}
        aria-label={label}
        title={label}
        className={[
          "grid h-14 w-14 place-items-center rounded-full border text-white transition duration-150 active:scale-90",
          on
            ? "border-white/15 bg-white/20 shadow-lg shadow-black/40 hover:bg-white/30"
            : "border-rose-400/40 bg-rose-500/25 hover:bg-rose-500/40",
          spin ? "animate-pulse" : "",
        ].join(" ")}
      >
        {children}
      </button>
      <span className="text-[11px] font-semibold text-white/75">{label}</span>
    </div>
  );
}

function ColAction({
  label,
  tone,
  onClick,
  children,
  disabled = false,
}: {
  label: string;
  tone: "rose" | "sage";
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  const bg = tone === "rose" ? "bg-rose-500 shadow-rose-500/40 hover:bg-rose-600" : "bg-sage-600 shadow-black/40 hover:bg-sage-500";
  return (
    <div className="flex flex-col items-center gap-2.5">
      <button
        onClick={onClick}
        disabled={disabled}
        className={`grid h-20 w-20 place-items-center rounded-full text-white shadow-lg transition ${
          disabled
            ? "cursor-wait opacity-60"
            : `hover:scale-105 active:scale-95 ${bg}`
        }`}
        aria-label={label}
      >
        {children}
      </button>
      <span className="text-xs font-semibold text-white/70">{label}</span>
    </div>
  );
}
