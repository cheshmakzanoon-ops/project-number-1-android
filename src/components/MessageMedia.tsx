import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Mic, Pause, Play } from "lucide-react";
import type { ChatMessage, MessageKind, ReplyQuote } from "../lib/types";
import { formatDurationMs } from "../lib/media";

/** Browser-recorded WebM may report NaN/Infinity rather than a seekable duration. */
function finiteDuration(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function VoiceNoteBubble({ url, durationMs, mine, className = "", disabled = false }: {
  url: string;
  durationMs?: number;
  mine: boolean;
  className?: string;
  disabled?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const request = useRef(0);
  const loading = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [nativeDuration, setNativeDuration] = useState(0);
  const [error, setError] = useState(false);
  const totalMs = nativeDuration || finiteDuration(durationMs);
  const position = totalMs ? Math.min(totalMs, elapsed) : elapsed;
  const progress = totalMs ? position / totalMs : 0;

  const paused = useCallback(() => {
    request.current++;
    clearTimeout(timer.current);
    loading.current = false;
    setPending(false);
    setPlaying(false);
  }, []);
  useEffect(() => {
    const audio = audioRef.current;
    request.current++;
    loading.current = false;
    clearTimeout(timer.current);
    setPending(false); setPlaying(false); setElapsed(0); setNativeDuration(0); setError(false);
    return () => {
      request.current++;
      loading.current = false;
      clearTimeout(timer.current);
      audio?.pause();
    };
  }, [url]);
  useEffect(() => {
    if (disabled) { paused(); audioRef.current?.pause(); }
  }, [disabled, paused]);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio || disabled) return;
    if (playing || loading.current) { paused(); audio.pause(); return; }
    setError(false);
    if (audio.error) audio.load(); // A failed download can be retried after reconnect.
    const operation = ++request.current;
    loading.current = true; setPending(true);
    const failed = () => {
      if (operation !== request.current) return;
      paused(); audio.pause(); setError(true);
    };
    timer.current = setTimeout(failed, 15_000);
    void (async () => {
      try {
        await audio.play();
        if (operation !== request.current) return;
        clearTimeout(timer.current);
        loading.current = false; setPending(false); setPlaying(!audio.paused);
      } catch { failed(); }
    })();
  };
  const seekTo = (milliseconds: number) => {
    const audio = audioRef.current;
    if (!audio || disabled || !totalMs || !Number.isFinite(milliseconds)) return;
    try {
      audio.currentTime = Math.min(totalMs, Math.max(0, milliseconds)) / 1000;
      setElapsed(audio.currentTime * 1000);
    } catch { /* Metadata/seek ranges are not available yet; do not crash the chat. */ }
  };

  return (
    <div className={`min-w-[190px] max-w-full ${className}`} dir="ltr" onClick={event => event.stopPropagation()}>
      <div className="flex items-center gap-2.5">
        <audio ref={audioRef} src={url} preload="metadata" className="hidden" playsInline data-voice-note="true"
          onPlay={() => {
            // Only one voice message speaks at once. Never touch LiveKit call audio.
            for (const other of document.querySelectorAll<HTMLAudioElement>("audio[data-voice-note]")) {
              if (other !== audioRef.current && !other.paused) other.pause();
            }
            setPlaying(true);
          }}
          onPause={paused}
          onEnded={() => { paused(); setElapsed(0); }}
          onTimeUpdate={event => setElapsed(finiteDuration(event.currentTarget.currentTime * 1000))}
          onLoadedMetadata={event => setNativeDuration(finiteDuration(event.currentTarget.duration * 1000))}
          onDurationChange={event => setNativeDuration(finiteDuration(event.currentTarget.duration * 1000))}
          onError={() => { paused(); setError(true); }}
        />
        <button type="button" onClick={toggle} disabled={disabled} aria-busy={pending}
          aria-label={playing || pending ? "توقف" : "پخش"} title={disabled ? "در حال تماس" : playing || pending ? "توقف" : "پخش"}
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-white shadow-md transition active:scale-90 disabled:opacity-40 ${playing ? "bg-sage-500/90" : "bg-white/25 hover:bg-white/35"}`}>
          {playing || pending ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" className="ml-0.5" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex h-6 items-center gap-[3px]" aria-hidden="true">
            {Array.from({ length: 13 }, (_, i) => <span key={i}
              className={`eq-bar w-[3px] rounded-full ${playing ? "" : "eq-idle"}`}
              style={{ height: "45%", animationDelay: `${(i * 137) % 400}ms`, backgroundColor: mine ? "rgba(255,255,255,0.85)" : "var(--color-sage-400)" }} />)}
          </div>
          <div role="slider" aria-label="پیشروی" aria-valuemin={0} aria-valuemax={Math.round(totalMs || position)}
            aria-valuenow={Math.round(position)} aria-disabled={disabled || !totalMs} tabIndex={disabled ? -1 : 0}
            onClick={event => {
              const box = event.currentTarget.getBoundingClientRect();
              if (box.width > 0) seekTo(((event.clientX - box.left) / box.width) * totalMs);
            }}
            onKeyDown={event => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              seekTo(event.key === "Home" ? 0 : event.key === "End" ? totalMs : position + (event.key === "ArrowLeft" ? -3000 : 3000));
            }}
            className={`mt-0.5 h-1.5 w-full cursor-pointer overflow-hidden rounded-full ${mine ? "bg-white/25" : "bg-dusk-300/70"}`}>
            <div className={`h-full rounded-full transition-[width] duration-200 ${mine ? "bg-white/80" : "bg-sage-400"}`} style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
        <span className={`shrink-0 text-[11px] font-bold tabular-nums ${mine ? "text-white/80" : "text-dusk-700"}`}>
          {formatDurationMs(totalMs ? totalMs - position : position)}
        </span>
      </div>
      {error && <p role="alert" dir="rtl" className="mt-1 text-xs">پخش صدا ممکن نشد؛ اتصال را بررسی کن و دوباره تلاش کن.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Image message: clickable thumbnail (opens the Lightbox).            */
/* ------------------------------------------------------------------ */

export function ImageBubble({
  msg,
  onOpen,
}: {
  msg: ChatMessage;
  onOpen: (m: ChatMessage) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(msg);
      }}
      className="group relative block w-[230px] max-w-full cursor-pointer overflow-hidden rounded-2xl focus:outline-none"
      aria-label="باز کردن تصویر"
    >
      <img
        src={msg.url ?? ""}
        alt={msg.body || "عکس"}
        loading="lazy"
        className="max-h-80 w-full bg-dusk-200 object-cover transition duration-200 group-hover:opacity-95 group-active:scale-[1.01]"
        style={{ aspectRatio: "auto" }}
      />
      <span className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/10" />
      <span className="pointer-events-none absolute bottom-1.5 right-1.5 grid h-7 w-7 place-items-center rounded-full bg-black/45 text-white/90 opacity-0 backdrop-blur transition group-hover:opacity-100">
        <ImageIcon size={14} />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* The WhatsApp/Telegram-style quote chip above a message.             */
/* ------------------------------------------------------------------ */

const KIND_LABEL: Record<MessageKind, string> = {
  text: "",
  image: "📷 عکس",
  voice: "🎤 پیام صوتی",
};

export function ReplyChip({
  reply,
  mine,
  onClick,
}: {
  reply: ReplyQuote;
  mine: boolean;
  onClick: () => void;
}) {
  const label = reply.kind !== "text" ? KIND_LABEL[reply.kind] : reply.body;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`mb-1.5 block w-full cursor-pointer overflow-hidden rounded-xl text-start transition active:opacity-80 ${
        mine ? "bg-black/25" : "bg-dusk-300/30 hover:bg-dusk-300/45"
      }`}
      aria-label="رفتن به پیام اصلی"
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span
          className="w-1 shrink-0 self-stretch rounded-full"
          style={{ backgroundColor: reply.deleted ? undefined : reply.senderColor }}
        />
        <div className="min-w-0 flex-1">
          <p
            className={`truncate text-[11px] font-black ${
              reply.deleted ? (mine ? "text-white/60" : "text-dusk-600") : ""
            }`}
            style={reply.deleted ? undefined : { color: mine ? "#fff" : reply.senderColor }}
          >
            {reply.senderName}
          </p>
          <p
            className={`flex min-w-0 items-center gap-1 truncate text-xs leading-5 ${
              mine ? "text-white/85" : "text-dusk-800"
            }`}
          >
            {reply.kind !== "text" && (
              <Mic size={12} className="shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">{reply.deleted ? "پیام حذف شد" : label}</span>
          </p>
        </div>
      </div>
    </button>
  );
}
