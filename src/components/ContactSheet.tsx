import type { ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Camera, MessageCircle, Phone, X } from "lucide-react";
import { Avatar } from "./Avatar";
import type { DirectoryEntry } from "../lib/types";

export function ContactSheet({
  open,
  onClose,
  contacts,
  onMessage,
  onVideo,
  onAudio,
}: {
  open: boolean;
  onClose: () => void;
  contacts: DirectoryEntry[];
  onMessage: (c: DirectoryEntry) => void;
  onVideo: (c: DirectoryEntry) => void;
  onAudio: (c: DirectoryEntry) => void;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-dusk-950/40 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            className="safe-area absolute inset-x-0 bottom-0 mx-auto max-w-md rounded-t-[2rem] bg-white shadow-2xl"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 340 }}
          >
            <div className="flex items-center justify-between px-6 pt-4 pb-1">
              <h2 className="text-lg font-extrabold text-dusk-900">خانواده</h2>
              <button
                onClick={onClose}
                className="grid h-9 w-9 place-items-center rounded-full bg-dusk-100 text-dusk-600 transition hover:bg-dusk-200"
                aria-label="بستن"
              >
                <X size={18} />
              </button>
            </div>
            <p className="px-6 pb-2 text-sm text-dusk-500">
              {contacts.length === 0
                ? "هنوز کسی ثبت نام نکرده. پیوند را پخش کن تا بقیهٔ خانواده بیایند."
                : "با یک نفر تماس بگیر یا پیام بده."}
            </p>
            <div className="mb-2 max-h-[52vh] overflow-y-auto px-3 pb-4">
              {contacts.map((c) => (
                <div
                  key={c._id}
                  className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-dusk-50"
                >
                  <Avatar name={c.displayName} color={c.themeColor} size={46} online={c.online} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold text-dusk-900">{c.displayName}</p>
                    <p className="text-xs text-sage-600">{c.online ? "آنلاین" : "برخط نیست"}</p>
                  </div>
                  <IcoBtn onClick={() => onMessage(c)} label="پیام">
                    <MessageCircle size={19} />
                  </IcoBtn>
                  <IcoBtn onClick={() => onVideo(c)} label="تماس تصویری" tone="ember">
                    <Camera size={19} />
                  </IcoBtn>
                  <IcoBtn onClick={() => onAudio(c)} label="تماس صوتی" tone="sage">
                    <Phone size={18} />
                  </IcoBtn>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function IcoBtn({
  children,
  onClick,
  label,
  tone = "neutral",
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  tone?: "neutral" | "ember" | "sage";
}) {
  const cls =
    tone === "ember"
      ? "bg-ember-500 text-white"
      : tone === "sage"
        ? "bg-sage-500 text-white"
        : "bg-dusk-100 text-dusk-700";
  return (
    <button
      onClick={onClick}
      className={`grid h-10 w-10 place-items-center rounded-full transition active:scale-95 ${cls}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}