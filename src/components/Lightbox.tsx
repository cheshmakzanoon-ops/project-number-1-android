import { useEffect } from "react";
import { X } from "lucide-react";
import type { ChatMessage } from "../lib/types";
import { clock } from "../lib/format";

/** Full-screen image viewer (tap anywhere / ✕ to close). */
export function Lightbox({
  msg,
  senderName,
  onClose,
}: {
  msg: ChatMessage;
  senderName: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={msg.body || "عکس"}
      onClick={onClose}
      className="safe-area fixed inset-0 z-[90] flex flex-col bg-black/95 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between px-4 py-3">
        <p className="min-w-0 truncate text-sm font-bold text-white/90">
          {msg.isMine ? "شما" : senderName}
          <span className="mr-2 text-xs font-medium text-white/50 tabular-nums">{clock(msg.createdAt)}</span>
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="بستن"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20 active:scale-90"
        >
          <X size={20} />
        </button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-3 pb-4">
        <img
          src={msg.url ?? ""}
          alt={msg.body || "عکس"}
          onClick={(e) => e.stopPropagation()}
          className="animate-ink max-h-full max-w-full rounded-xl object-contain shadow-2xl"
        />
      </div>

      {msg.body && (
        <p
          onClick={onClose}
          className="mx-auto max-w-md px-8 pb-6 text-center text-sm leading-6 text-white/85"
        >
          {msg.body}
        </p>
      )}
    </div>
  );
}
