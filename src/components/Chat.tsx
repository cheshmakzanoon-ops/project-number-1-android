import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { ArrowDown, ArrowRight, Check, Pencil, Phone, Send, Trash2 } from "lucide-react";
import { Avatar } from "./Avatar";
import { clock, fa, formatDay } from "../lib/format";
import type { ChatMessage } from "../lib/types";
import type { Id } from "../convex/_generated/dataModel";

const EMOJIS = ["❤️", "👍", "😂", "😮", "😢", "🙏"];

export function Chat({
  token,
  meColor,
  conversationId,
  name,
  color,
  onBack,
  onCall,
}: {
  token: string;
  meColor: string;
  conversationId: Id<"conversations">;
  name: string;
  color: string;
  onBack: () => void;
  onCall: () => void;
}) {
  const messages = useQuery(api.messages.list, token ? { conversationId, token } : "skip");
  const send = useMutation(api.messages.send);
  const editMut = useMutation(api.messages.edit);
  const delMut = useMutation(api.messages.remove);
  const react = useMutation(api.messages.toggleReaction);
  const markRead = useMutation(api.conversations.markRead);
  // Typing indicator
  const startTypingMut = useMutation(api.typing.startTyping);
  const stopTypingMut = useMutation(api.typing.stopTyping);
  const typers = useQuery(
    api.typing.whoIsTyping,
    conversationId && token ? { conversationId, token } : "skip",
  ) as string[] | undefined;

  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<Id<"messages"> | null>(null);
  const [menu, setMenu] = useState<Id<"messages"> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const lastReadSentRef = useRef<number>(0);
  const typingLastSentRef = useRef(0);
  const typingStopRef = useRef<number | null>(null);

  const list = (messages ?? []) as ChatMessage[];
  const someoneTyping = (typers?.length ?? 0) > 0;

  const scrollToBottom = () => {
    scrolledRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 480);
  };

  useEffect(() => {
    if (messages && !scrolledRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
      scrolledRef.current = true;
    } else if (messages) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, list.length]);

  useEffect(() => {
    const unread = list.some((m) => !m.isMine && !m.deletedAt);
    if (unread && Date.now() - lastReadSentRef.current > 800) {
      lastReadSentRef.current = Date.now();
      markRead({ conversationId, token });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length, conversationId, token]);

  useEffect(() => setMenu(null), [conversationId]);

  useEffect(() => {
    // Tell the peer we're no longer typing when we leave the conversation.
    return () => {
      if (typingStopRef.current) window.clearTimeout(typingStopRef.current);
      void stopTypingMut({ conversationId, token });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, token]);

  const notifyTyping = () => {
    if (editing) return;
    const now = Date.now();
    // Don't spam the backend on every keystroke; refresh at most every 1.5s.
    if (now - typingLastSentRef.current > 1500) {
      typingLastSentRef.current = now;
      void startTypingMut({ conversationId, token });
    }
    // Auto-clear shortly after they stop, so "در حال نوشتن" never sticks.
    if (typingStopRef.current) window.clearTimeout(typingStopRef.current);
    typingStopRef.current = window.setTimeout(() => {
      void stopTypingMut({ conversationId, token });
    }, 2000);
  };

  const onSend = async () => {
    const text = draft.trim();
    if (!text) return;
    if (typingStopRef.current) window.clearTimeout(typingStopRef.current);
    void stopTypingMut({ conversationId, token });
    setDraft("");
    try {
      if (editing) {
        await editMut({ messageId: editing, body: text, token });
        setEditing(null);
      } else {
        await send({ conversationId, body: text, token });
      }
      scrolledRef.current = true;
    } catch {
      /* noop */
    }
  };

  return (
    <div className="flex h-full flex-col bg-dusk-50">
      {/* header */}
      <div className="safe-area flex items-center gap-2 border-b border-dusk-100/80 bg-dusk-50/90 px-3 py-2 backdrop-blur">
        <button
          onClick={onBack}
          className="grid h-10 w-10 place-items-center rounded-full text-dusk-600 transition hover:bg-dusk-100"
          aria-label="بازگشت"
        >
          <ArrowRight size={20} /> {/* RTL: back arrow points right */}
        </button>
        <Avatar name={name} color={color} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-extrabold text-dusk-900">{name}</p>
          <p className={`truncate text-xs ${someoneTyping ? "text-ember-600" : "text-dusk-400"}`}>
            {someoneTyping ? `${name} در حال نوشتن…` : "گفتگوی خصوصی"}
          </p>
        </div>
        <button
          onClick={onCall}
          className="grid h-11 w-11 place-items-center rounded-full bg-ember-500 text-white shadow-md shadow-ember-500/30 transition hover:bg-ember-600 active:scale-95"
          aria-label="تماس صوتی"
        >
          <Phone size={19} />
        </button>
      </div>

      {/* messages */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin h-full space-y-2 overflow-y-auto px-3 py-4">
        <div className="space-y-1">
          {list.length === 0 && (
            <div className="py-14 text-center">
              <div
                className="mx-auto grid h-20 w-20 place-items-center rounded-[32px]"
                style={{ backgroundColor: color + "22", color }}
              >
                <Pencil size={30} />
              </div>
              <p className="mt-4 font-extrabold text-dusk-800">سلام!</p>
              <p className="mt-1 text-sm text-dusk-500">
                از {name} با <Phone size={12} className="inline" style={{ marginBottom: -2 }} /> تماس بگیر یا پیام بده.
              </p>
            </div>
          )}
          {list.map((m, idx) => {
            const prev = idx > 0 ? list[idx - 1] : null;
            const showDay = !prev || dayKey(m.createdAt) !== dayKey(prev.createdAt);
            return (
              <Fragment key={m._id}>
                {showDay && (
                  <div className="flex justify-center py-2">
                    <span className="rounded-full bg-dusk-100/80 px-3 py-1 text-[11px] font-semibold text-dusk-500">
                      {dayLabel(m.createdAt)}
                    </span>
                  </div>
                )}
                <Bubble
                  msg={m}
                  meColor={meColor}
                  menu={menu}
                  setMenu={setMenu}
                  onReact={(emoji) => react({ messageId: m._id, emoji, token })}
                  onEdit={() => {
                    if (m.isMine && !m.deletedAt) {
                      setEditing(m._id);
                      setDraft(m.body);
                    }
                    setMenu(null);
                  }}
                  onDelete={() => {
                    if (m.isMine) delMut({ messageId: m._id, token });
                    setMenu(null);
                  }}
                />
              </Fragment>
            );
          })}
        </div>
        <div ref={bottomRef} className="h-px" />
        </div>
        {showJump && (
          <button
            onClick={scrollToBottom}
            aria-label="رفتن به آخرین پیام"
            className="absolute bottom-5 left-4 z-10 grid h-11 w-11 place-items-center rounded-full border border-dusk-100/80 bg-white/95 text-dusk-600 shadow-xl backdrop-blur transition hover:bg-white active:scale-90"
          >
            <ArrowDown size={18} />
          </button>
        )}
      </div>

      {/* composer */}
      <div className="safe-area flex flex-col gap-1.5 border-t border-dusk-100/70 bg-white/85 px-3 pt-2.5 pb-3 backdrop-blur">
        {editing && (
          <div className="mb-0.5 flex items-center gap-2 rounded-xl bg-ember-100 px-3 py-2 text-sm text-ember-700">
            <Pencil size={15} /> ویرایش پیام
            <button onClick={() => { setEditing(null); setDraft(""); }} className="font-bold">✕</button>
            <span className="ml-auto truncate text-xs text-ember-500">{draft || "…"}</span>
          </div>
        )}
        <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            notifyTyping();
          }}
          onFocus={notifyTyping}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
          placeholder={editing ? "ویرایش متن…" : "پیام خود را بنویسید…"}
          className="min-h-[48px] max-h-32 flex-1 resize-none rounded-2xl border border-dusk-100 bg-white px-4 py-3 text-[15px] text-dusk-900 shadow-sm outline-none placeholder:text-dusk-400 focus:border-ember-300 focus:ring-2 focus:ring-ember-400/50"
        />
        <button
          onClick={onSend}
          className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-gradient-to-br from-ember-400 to-ember-600 text-white shadow-lg shadow-ember-500/30 transition hover:from-ember-500 hover:to-ember-700 active:scale-90"
          aria-label="ارسال"
        >
          <Send size={19} style={{ transform: "scaleX(-1)" }} />
        </button>
        </div>
      </div>
    </div>
  );
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const s = new Date(today.getTime() - 86_400_000);
  if (d >= today) return "امروز";
  if (
    s.getFullYear() === d.getFullYear() &&
    s.getMonth() === d.getMonth() &&
    s.getDate() === d.getDate()
  ) {
    return "دیروز";
  }
  return formatDay(ts);
}

function darken(hex: string, amt = 0.22): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  const f = (v: number) => Math.max(0, Math.round(v * (1 - amt)));
  return `rgb(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

function Bubble({
  msg,
  meColor,
  menu,
  setMenu,
  onReact,
  onEdit,
  onDelete,
}: {
  msg: ChatMessage;
  meColor: string;
  menu: Id<"messages"> | null;
  setMenu: (id: Id<"messages"> | null) => void;
  onReact: (emoji: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const mine = msg.isMine;
  const isMenu = menu === msg._id;
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[82%] ${mine ? "items-end" : "items-start"}`}>
        <div
          onClick={(e) => {
            e.stopPropagation();
            setMenu(isMenu ? null : msg._id);
          }}
          className={`relative select-none rounded-[20px] px-4 py-2.5 text-[15px] leading-7 transition active:scale-[0.99] ${
            mine
              ? "rounded-br-md text-white shadow-md shadow-dusk-900/15"
              : "rounded-bl-md bg-white text-dusk-900 shadow-[0_1px_3px_rgba(44,33,24,0.08)] ring-1 ring-dusk-100/70"
          } ${msg.deletedAt ? "opacity-70" : ""}`}
          style={mine ? { background: `linear-gradient(135deg, ${meColor}, ${darken(meColor)})` } : undefined}
        >
          {msg.deletedAt ? (
            <span className="italic opacity-80">این پیام حذف شد ←</span>
          ) : (
            <p className="whitespace-pre-wrap break-words">{msg.body}</p>
          )}
          <div className={`mt-0.5 flex items-center gap-1 text-[10px] ${mine ? "text-white/75" : "text-dusk-400"}`}>
            {msg.editedAt && <span>ویرایش شد</span>}
            <span>{clock(msg.createdAt)}</span>
            {mine &&
              (msg.read ? (
                <span className="flex items-center text-ember-300" title="خوانده شد">
                  <Check size={11} strokeWidth={3} />
                  <Check size={11} strokeWidth={3} className="-ml-[6px]" />
                </span>
              ) : (
                <span className="flex items-center text-white/70" title="ارسال شد">
                  <Check size={11} strokeWidth={3} />
                </span>
              ))}
          </div>

          {/* reaction chips */}
          {Object.keys(msg.reactions).length > 0 && (
            <div
              className={`absolute -bottom-3 flex gap-0.5 rounded-full border border-dusk-100 bg-white px-1.5 py-0.5 text-sm shadow-sm ${
                mine ? "right-2" : "left-2"
              }`}
            >
              {Object.entries(msg.reactions).map(([emoji, count]) => (
                <span key={emoji} title={`${fa(count)}`}>
                  {emoji}
                  {count > 1 && <span className="text-[10px] text-dusk-500">{fa(count)}</span>}
                </span>
              ))}
            </div>
          )}

          {/* action menu */}
          {isMenu && !msg.deletedAt && (
            <div
              onClick={(e) => e.stopPropagation()}
              className={`animate-rise absolute bottom-full z-20 mb-2 flex items-center gap-1 rounded-2xl border border-dusk-100 bg-white p-1.5 shadow-lg ${
                mine ? "right-0" : "left-0"
              }`}
            >
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => onReact(e)}
                  className="grid h-9 w-9 place-items-center rounded-xl text-lg transition hover:bg-dusk-50 active:scale-90"
                >
                  {e}
                </button>
              ))}
              {mine && (
                <button
                  onClick={onEdit}
                  className="grid h-9 w-9 place-items-center rounded-xl text-dusk-500 transition hover:bg-dusk-50"
                  aria-label="ویرایش"
                >
                  <Pencil size={16} />
                </button>
              )}
              {mine && (
                <button
                  onClick={onDelete}
                  className="grid h-9 w-9 place-items-center rounded-xl text-ember-600 transition hover:bg-ember-50"
                  aria-label="حذف"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}