import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import {
  CameraOff,
  Camera,
  FlipHorizontal,
  Maximize,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  Phone,
  PhoneOff,
  Volume2,
} from "lucide-react";
import { Avatar } from "./Avatar";
import { fa } from "../lib/format";
import type { CallSession, GarmaCallkit } from "../lib/useCallkit";

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
  const incoming = phase === "incoming";
  const active = phase === "active";
  const containerRef = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);
  const busy = kit.busy;

  useEffect(() => {
    const onFullscreen = () => setFs(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  const showVideo = kind === "video";

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
      className={`safe-area fixed inset-0 z-50 flex flex-col overflow-hidden bg-dusk-950 text-white ${
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

      {/* NOTE: remote mic audio plays through exactly ONE element (the audio
          element useCallkit attaches on TrackSubscribed). The video tiles
          below are muted on purpose — playing the mic track through them too
          caused doubled, phasey audio on every call. */}
      {kit.reconnecting && active && (
        <div className="absolute inset-x-0 top-14 z-30 flex justify-center">
          <span className="animate-pulse rounded-full border border-amber-300/30 bg-amber-500/20 px-4 py-1.5 text-xs font-bold text-amber-200 backdrop-blur">
            اتصال ضعیف است — در حال بازیابی…
          </span>
        </div>
      )}

      {/* LiveKit measured the OTHER side's link to us as poor — their picture
          will be blurry/low-fps. Name the cause instead of leaving the caller
          to blame their own phone. Only shown while their video is actually
          flowing (camera on / screen shared). */}
      {kit.remotePoor &&
        active &&
        showVideo &&
        !kit.reconnecting &&
        (kit.remoteCamOn || Boolean(kit.screenRemote)) && (
        <div className="absolute inset-x-0 top-24 z-30 flex justify-center px-4">
          <span className="rounded-full border border-amber-300/30 bg-amber-500/15 px-4 py-1.5 text-center text-xs font-bold text-amber-200/90 backdrop-blur">
            اینترنت {session.otherName} ضعیف است — تصویر او با کیفیت پایین می‌آید
          </span>
        </div>
      )}

      {/* -------- INCOMING / OUTGOING (pre-connect) -------- */}
      {!active && (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6">
          <p className="mb-6 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-semibold tracking-wide text-white/70 backdrop-blur">
            {incoming
              ? kind === "video"
                ? "تماس تصویری ورودی"
                : "تماس صوتی ورودی"
              : "تماس با گرما"}
          </p>
          <div className={incoming ? "animate-ring rounded-[48px]" : ""}>
            <div className="rounded-[48px] bg-gradient-to-br from-ember-400/30 to-sage-400/20 p-2">
              <Avatar name={session.otherName} color={session.otherColor} size={136} />
            </div>
          </div>
          <h2 className="mt-7 text-3xl font-black drop-shadow-sm">{session.otherName}</h2>
          <p className="mt-3 text-lg text-white/70">
            {incoming
              ? kind === "video"
                ? "می‌خواهد با تو گفتگو کند"
                : "می‌خواهد با تو حرف بزند"
              : "در حال زنگ زدن…"}
          </p>
          <p className="mt-1 text-sm tabular-nums text-white/40">{FORMAT_TIME(elapsed)}</p>

          <div className="mt-14 flex items-center gap-10">
            {incoming ? (
              <>
                <ColAction label="رد کردن" tone="rose" onClick={kit.decline} disabled={busy}>
                  <PhoneOff size={26} style={{ transform: "scaleX(-1)" }} />
                </ColAction>
                <ColAction label={busy ? "در حال اتصال…" : "پاسخ"} tone="sage" onClick={kit.accept} disabled={busy}>
                  <Phone size={28} style={{ transform: "scaleX(-1)" }} />
                </ColAction>
              </>
            ) : (
              <ColAction label={busy ? "در حال قطع…" : "قطع کردن"} tone="rose" onClick={kit.hangup} disabled={busy}>
                <PhoneOff size={26} style={{ transform: "scaleX(-1)" }} />
              </ColAction>
            )}
          </div>
        </div>
      )}

      {/* -------- ACTIVE VIDEO -------- */}
      {active && showVideo && (
        <div className="relative z-10 flex min-h-0 flex-1 flex-col">
          {/* main region */}
          <div className="relative flex-1 overflow-hidden bg-dusk-950">
            {kit.screenRemote ? (
              <>
                <MediaFeed
                  stream={kit.screenRemote}
                  kind="video"
                  muted
                  className="absolute inset-0 h-full w-full bg-dusk-900 object-contain"
                />
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm">
                  <span className="flex items-center gap-2 rounded-full bg-dusk-950/70 px-4 py-2 backdrop-blur">
                    <MonitorUp size={17} /> اشتراک صفحه
                  </span>
                </div>
              </>
            ) : kit.remote && kit.remoteCamOn ? (
              <MediaFeed
                stream={kit.remote}
                kind="video"
                muted
                className="absolute inset-0 h-full w-full bg-dusk-900 object-cover"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center bg-[radial-gradient(circle_at_50%_30%,#2e2118,#0f0a06)]">
                <div className="rounded-[40px] bg-gradient-to-br from-ember-400/30 to-sage-400/15 p-2">
                  {!kit.remoteCamOn ? (
                    <div className="grid h-28 w-28 place-items-center rounded-[40px] bg-dusk-800/70">
                      <CameraOff size={44} className="text-white/40" />
                    </div>
                  ) : (
                    <Avatar name={session.otherName} color={session.otherColor} size={116} />
                  )}
                </div>
                <p className="mt-4 text-sm text-white/55">
                  {!kit.remoteCamOn ? `دوربین ${session.otherName} خاموش است` : "در حال اتصال تصویر…"}
                </p>
              </div>
            )}

            {/* remote badges */}
            {active && (
              <div className="absolute inset-x-4 top-4 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 rounded-full border border-white/10 bg-dusk-950/55 px-3 py-1.5 text-xs backdrop-blur">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-sage-400" />
                  </span>
                  <span className="font-bold">{session.otherName}</span>
                  <span className="tabular-nums opacity-70">{FORMAT_TIME(elapsed)}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {kit.camQuality && kit.camOn && (
                    <button
                      type="button"
                      onClick={kit.cycleQuality}
                      title="کیفیت تصویر دوربین تو — برای تغییر ضربه بزن (خودکار، ۴۸۰، ۷۲۰، ۱۰۸۰)"
                      aria-label="تغییر کیفیت دوربین"
                      className="flex cursor-pointer items-center gap-1.5 rounded-full border border-white/10 bg-dusk-950/60 px-2.5 py-1 text-[11px] font-bold tracking-wide text-sage-300 backdrop-blur transition hover:border-sage-400/40 hover:text-sage-200 active:scale-95"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-sage-400" />
                      {fa(kit.camQuality)}
                    </button>
                  )}
                  {!kit.remoteMicOn && <Badge icon={<MicOff size={13} />} />}
                  {!kit.remoteCamOn && <Badge icon={<CameraOff size={13} />} />}
                </div>
              </div>
            )}

            {/* local preview corner */}
            {kit.camOn && kit.local && (
              <div className="absolute bottom-5 left-4 z-10 overflow-hidden rounded-2xl border border-white/15 bg-dusk-900 shadow-2xl">
                <MediaFeed
                  stream={kit.local}
                  kind="video"
                  muted
                  className="h-40 w-28 object-cover"
                  style={{ transform: "scaleX(-1)" }}
                />
                <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 rounded-full bg-dusk-950/70 px-2 py-0.5 text-[10px] font-semibold text-white/80 backdrop-blur">
                  من
                </span>
              </div>
            )}
          </div>

          {/* control center */}
          <div className="relative z-20 px-4 pb-6 pt-2">
            <div className="mx-auto flex w-fit max-w-full items-center gap-1.5 overflow-x-auto rounded-[2.2rem] border border-white/10 bg-dusk-950/55 px-3 py-2.5 shadow-2xl backdrop-blur-xl">
              <CtrlBtn on={kit.micOn} onClick={kit.toggleMic} label={kit.micOn ? "سکوت" : "صدا"}>
                {kit.micOn ? <Mic size={22} /> : <MicOff size={22} />}
              </CtrlBtn>
              <CtrlBtn on={kit.camOn} onClick={kit.toggleCam} label={kit.camOn ? "خاموش" : "دوربین"}>
                {kit.camOn ? <Camera size={22} /> : <CameraOff size={22} />}
              </CtrlBtn>
              <CtrlBtn label="تعویض دوربین" onClick={kit.switchCamera}>
                <FlipHorizontal size={22} />
              </CtrlBtn>
              <CtrlBtn on={kit.sharing} onClick={kit.toggleShare} label="اشتراک صفحه">
                <MonitorUp size={22} />
              </CtrlBtn>
              <CtrlBtn label="تمام‌صفحه" onClick={toggleFullscreen}>
                {fs ? <Minimize2 size={22} /> : <Maximize size={22} />}
              </CtrlBtn>
              <CtrlBtn label="صفحه اصلی" onClick={onMinimize}>
                <Minimize2 size={22} />
              </CtrlBtn>
              {kit.sharing && (
                <span className="absolute right-3 top-2 rounded-full bg-sage-500 px-3 py-1 text-xs font-bold">
                  در حال اشتراک…
                </span>
              )}
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
        <div className="relative z-10 flex flex-1 flex-col items-center justify-between py-10">
          <div className="mt-8 flex flex-col items-center">
            <div className="animate-ring rounded-[48px]">
              <div className="rounded-[48px] bg-gradient-to-br from-ember-400/30 to-sage-400/20 p-2">
                <Avatar name={session.otherName} color={session.otherColor} size={132} />
              </div>
            </div>
            <h2 className="mt-6 text-3xl font-black drop-shadow-sm">{session.otherName}</h2>
            <div className="mt-2 flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-semibold text-white/70 backdrop-blur">
              <span className="h-2 w-2 animate-pulse rounded-full bg-sage-400" />
              {FORMAT_TIME(elapsed)}
            </div>
            {!kit.remoteMicOn && (
              <p className="mt-1 text-sm text-white/45">میکروفن فرد مقابل قطع است</p>
            )}
          </div>

          <div className="flex items-end gap-4">
            <div className="flex items-center gap-2 rounded-[2rem] border border-white/10 bg-dusk-950/55 px-4 py-3 shadow-2xl backdrop-blur-xl">
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
              disabled={busy}
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

function MediaFeed({
  stream,
  kind,
  className,
  style,
  muted = true,
}: {
  stream: MediaStream;
  kind: "video" | "audio";
  className?: string;
  style?: CSSProperties;
  muted?: boolean;
}) {
  const ref = useRef<HTMLMediaElement>(null);
  useEffect(() => {
    try {
      if (ref.current) ref.current.srcObject = stream;
    } catch {
      /* noop */
    }
  }, [stream]);
  if (kind === "audio") {
    return <audio ref={ref as Ref<HTMLAudioElement>} autoPlay playsInline muted={muted} className={className} style={style} />;
  }
  return <video ref={ref as Ref<HTMLVideoElement>} autoPlay playsInline muted={muted} className={className} style={style} />;
}

function Badge({ icon }: { icon: ReactNode }) {
  return (
    <span className="grid h-7 w-7 place-items-center rounded-full border border-white/10 bg-dusk-950/60 text-white/80 backdrop-blur">
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
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  on?: boolean;
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
            ? "border-white/15 bg-white/20 shadow-lg shadow-dusk-950/30 hover:bg-white/30"
            : "border-rose-400/40 bg-rose-500/25 hover:bg-rose-500/40",
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
  const bg = tone === "rose" ? "bg-rose-500 shadow-rose-500/40 hover:bg-rose-600" : "bg-sage-500 shadow-sage-500/40 hover:bg-sage-600";
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