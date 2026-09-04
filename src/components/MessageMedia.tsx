import { useCallback, useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Mic, Pause, Play } from "lucide-react";
import type { ChatMessage, MessageKind, ReplyQuote } from "../lib/types";
import { formatDurationMs } from "../lib/media";

/* ------------------------------------------------------------------ */
/* Voice note: play/pause + progress bar + live equalizer.             */
/* ------------------------------------------------------------------ */

export function VoiceNoteBubble({
  url,
  durationMs,
  mine,
  className = "",
}: {
  url: string;
  durationMs?: number;
  mine: boolean;
  className?: string;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [ready, setReady] = useState(durationMs != null && durationMs > 0);
  // Restart from zero when the URL swaps (new message rendered).
  useEffect(() => {
    setPlaying(false);
    setElapsed(0);
  }, [url]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setElapsed(a.currentTime * 1000);
    const onEnd = () => {
      setPlaying(false);
      setElapsed(0);
    };
    const onMeta = () => {
      if (isFinite(a.duration) && a.duration > 0) setReady(true);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("ended", onEnd);
    a.addEventListener("loadedmetadata", onMeta);
    return () => {
      a.pause();
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("loadedmetadata", onMeta);
    };
  }, [url]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      void a.play().catch(() => {});
      setPlaying(true);
    }
  }, [playing]);

  const totalMs = ready ? (audioRef.current?.duration ?? 0) * 1000 : durationMs ?? 0;
  const progress = totalMs > 0 ? Math.min(1, elapsed / totalMs) : 0;

  const seek = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const a = audioRef.current;
      if (!a || !ready) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      a.currentTime = ratio * a.duration;
    },
    [ready],
  );

  return (
    <div className={`flex min-w-[190px] max-w-full items-center gap-2.5 ${className}`} dir="ltr">
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        className="hidden"
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "توقف" : "پخش"}
        title={playing ? "توقف" : "پخش"}
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-white shadow-md transition active:scale-90 ${
          playing ? "bg-sage-500/90" : "bg-white/25 hover:bg-white/35"
        }`}
      >
        {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" className="ml-0.5" />}
      </button>

      <div className="min-w-0 flex-1">
        {/* equalizer: animated while playing, frozen at a low hum when paused */}
        <div className="flex h-6 items-center gap-[3px]" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => (
            <span
              key={i}
              className={`eq-bar w-[3px] rounded-full ${playing ? "" : "eq-idle"}`}
              style={{
                height: "45%",
                animationDelay: `${(i * 137) % 400}ms`,
                backgroundColor: mine ? "rgba(255,255,255,0.85)" : "var(--color-sage-400)",
              }}
            />
          ))}
        </div>
        {/* scrubber */}
        <div
          role="slider"
          aria-label="پیشروی"
          aria-valuemin={0}
          aria-valuemax={Math.round(totalMs)}
          aria-valuenow={Math.round(elapsed)}
          tabIndex={0}
          onClick={seek}
          onKeyDown={(e) => {
            const a = audioRef.current;
            if (!a || !ready || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
            const delta = 3000 * (e.key === "ArrowLeft" ? -1 : 1);
            a.currentTime = Math.min(Math.max(0, a.currentTime + delta / 1000), a.duration);
          }}
          className={`mt-0.5 h-1.5 w-full cursor-pointer overflow-hidden rounded-full ${
            mine ? "bg-white/25" : "bg-dusk-300/70"
          }`}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-200 ${mine ? "bg-white/80" : "bg-sage-400"}`}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      <span className={`shrink-0 text-[11px] font-bold tabular-nums ${mine ? "text-white/80" : "text-dusk-700"}`}>
        {formatDurationMs(totalMs > 0 ? totalMs - elapsed : elapsed)}
      </span>
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
