import { useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Check,
  Link,
  MessageCircle,
  Phone,
  Users,
  Video,
  X,
} from "lucide-react";
import { Avatar } from "./Avatar";
import { fa } from "../lib/format";
import type { DirectoryEntry } from "../lib/types";

export function ContactSheet({
  open,
  onClose,
  contacts,
  canMakeGroup,
  onMessage,
  onVideo,
  onAudio,
  onGroupCreate,
}: {
  open: boolean;
  onClose: () => void;
  contacts: DirectoryEntry[];
  canMakeGroup: boolean;
  onMessage: (c: DirectoryEntry) => void;
  onVideo: (c: DirectoryEntry) => void;
  onAudio: (c: DirectoryEntry) => void;
  onGroupCreate: (selected: DirectoryEntry[]) => void;
}) {
  const [mode, setMode] = useState<"dm" | "group">("dm");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const togglePick = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickContact = (id: string) => {
    if (mode === "group") {
      togglePick(id);
      return;
    }
    const c = contacts.find((x) => x._id === id);
    if (c) {
      onClose();
      onMessage(c);
    }
  };

  const close = () => {
    setSelected(new Set());
    onClose();
  };

  const createGroup = () => {
    const picked = contacts.filter((c) => selected.has(c._id));
    if (picked.length < 2) return;
    setSelected(new Set());
    onClose();
    onGroupCreate(picked);
  };

  const copyInvite = () => {
    const url = window.location.origin;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    };
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        done();
      } catch {
        /* clipboard unavailable */
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, fallback);
    } else {
      fallback();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={close}
          />
          <motion.div
            className="safe-area absolute inset-x-0 bottom-0 mx-auto max-w-md rounded-t-[2rem] border-x border-t border-ember-300/20 bg-dusk-100 shadow-2xl shadow-black/60"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 340 }}
          >
            <div className="flex items-center justify-between px-6 pt-4 pb-1">
              <h2 className="text-lg font-extrabold text-dusk-900">خانواده</h2>
              <button
                onClick={close}
                className="grid h-9 w-9 place-items-center rounded-full bg-dusk-200 text-dusk-600 transition hover:bg-dusk-300/80"
                aria-label="بستن"
              >
                <X size={18} />
              </button>
            </div>

            {/* DM / group toggle */}
            <div className="mx-6 mb-2 mt-1 flex items-center gap-1 rounded-full bg-dusk-200/80 p-1">
              <ModePill
                active={mode === "dm"}
                onClick={() => {
                  setMode("dm");
                  setSelected(new Set());
                }}
              >
                <MessageCircle size={14} /> تکی
              </ModePill>
              <ModePill
                active={mode === "group"}
                onClick={() => {
                  setMode("group");
                  setSelected(new Set());
                }}
                disabled={!canMakeGroup}
                title={canMakeGroup ? undefined : "برای گروه، اول بقیهٔ خانواده باید عضو شوند"}
              >
                <Users size={14} /> گروه
              </ModePill>
            </div>

            <p className="px-6 pb-2 text-sm text-dusk-600">
              {mode === "group"
                ? contacts.length === 0
                  ? "هنوز کسی ثبت نام نکرده. پیوند را پخش کن تا بقیهٔ خانواده بیایند."
                  : "حداقل دو نفر را انتخاب کن تا گفتگو و تماس گروهی ساخته شود."
                : contacts.length === 0
                  ? "هنوز کسی ثبت نام نکرده. پیوند را پخش کن تا بقیهٔ خانواده بیایند."
                  : "با یک نفر تماس بگیر یا پیام بده."}
            </p>

            <button
              type="button"
              onClick={copyInvite}
              className={`mx-6 mb-3 flex items-center justify-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-bold transition active:scale-[0.98] ${
                copied
                  ? "border border-sage-300 bg-sage-50 text-sage-700"
                  : "border border-ember-200 bg-ember-50 text-ember-700 hover:bg-ember-100"
              }`}
              aria-live="polite"
            >
              {copied ? (
                <>
                  <Check size={16} /> پیوند کپی شد — برای مامان و بابا بفرست
                </>
              ) : (
                <>
                  <Link size={16} /> کپی پیوند دعوت خانواده
                </>
              )}
            </button>

            <div className="mb-2 max-h-[46vh] overflow-y-auto px-3 pb-4">
              {contacts.map((c) => {
                const isPicked = selected.has(c._id);
                return (
                  <div
                    key={c._id}
                    onClick={() => pickContact(c._id)}
                    className={`flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-dusk-200/60 ${
                      mode === "group" && isPicked ? "bg-dusk-200/70 ring-1 ring-ember-300/40" : ""
                    }`}
                  >
                    <Avatar
                      name={c.displayName}
                      color={c.themeColor}
                      size={46}
                      online={c.online}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold text-dusk-950">{c.displayName}</p>
                      <p className="text-xs text-sage-400">{c.online ? "آنلاین" : "برخط نیست"}</p>
                    </div>
                    {mode === "group" ? (
                      <span
                        className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border transition ${
                          isPicked
                            ? "border-ember-400 bg-ember-400 text-cocoa"
                            : "border-dusk-400/60 text-transparent"
                        }`}
                        aria-label={isPicked ? "انتخاب شد" : "انتخاب"}
                      >
                        <Check size={15} strokeWidth={3} />
                      </span>
                    ) : (
                      <>
                        <IcoBtn onClick={() => onMessage(c)} label="پیام">
                          <MessageCircle size={19} />
                        </IcoBtn>
                        <IcoBtn onClick={() => onVideo(c)} label="تماس تصویری" tone="ember">
                          <Video size={19} />
                        </IcoBtn>
                        <IcoBtn onClick={() => onAudio(c)} label="تماس صوتی" tone="sage">
                          <Phone size={18} />
                        </IcoBtn>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {mode === "group" && (
              <div className="border-t border-dusk-300/40 px-5 pb-5 pt-3">
                <button
                  type="button"
                  onClick={createGroup}
                  disabled={selected.size < 2}
                  className={`flex w-full items-center justify-center gap-2 rounded-full px-6 py-3.5 font-extrabold transition active:scale-[0.98] ${
                    selected.size >= 2
                      ? "bg-ember-400 text-cocoa shadow-lg shadow-black/40 hover:bg-ember-300"
                      : "cursor-not-allowed bg-dusk-300/60 text-dusk-500"
                  }`}
                >
                  <Users size={18} />
                  {selected.size === 0
                    ? "دو نفر را انتخاب کن"
                    : `ساخت گروه با ${fa(selected.size)} نفر`}
                </button>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ModePill({
  children,
  active,
  onClick,
  disabled = false,
  title,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-4 py-2 text-sm font-bold transition ${
        active
          ? "bg-ember-400 text-cocoa shadow-md shadow-black/30"
          : disabled
            ? "cursor-not-allowed text-dusk-500"
            : "text-dusk-600 hover:text-dusk-800"
      }`}
    >
      {children}
    </button>
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
      ? "bg-ember-400 text-cocoa"
      : tone === "sage"
        ? "bg-sage-600 text-white"
        : "bg-dusk-200 text-dusk-600";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`grid h-10 w-10 place-items-center rounded-full transition active:scale-95 ${cls}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
