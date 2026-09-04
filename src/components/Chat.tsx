import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { ArrowDown, ArrowRight, Check, Clock, Pencil, Phone, RefreshCw, Send, Trash2, Video } from "lucide-react";
import { Avatar } from "./Avatar";
import { clock, fa, formatDay } from "../lib/format";
import { loadDraft, loadOutbox, newClientMsgId, saveDraft, saveOutbox, type PendingMessage } from "../lib/outbox";
import type { ChatMessage } from "../lib/types";
import type { Id } from "../convex/_generated/dataModel";

const EMOJIS = ["❤️", "👍", "😂", "😮", "😢", "🙏"];

type MemberInfo = {
  userId: Id<"users">;
  displayName: string;
  themeColor: string;
};

export function Chat({
  token,
  meColor,
  meName,
  meId,
  conversationId,
  kind,
  name,
  color,
  onBack,
  onCallVideo,
  onCallAudio,
}: {
  token: string;
  meColor: string;
  meName: string;
  meId: Id<"users">;
  conversationId: Id<"conversations">;
  kind: "dm" | "group";
  name: string;
  color: string;
  onBack: () => void;
  onCallVideo: () => void;
  onCallAudio: () => void;
}) {
  const messages = useQuery(api.messages.list, token ? { conversationId, token } : "skip");
  // Conversation metadata (members) — used in groups to name who sent what
  // and who is typing. Reactive, so a freshly created group is fully known.
  const convInfo = useQuery(
    api.conversations.conversation,
    token ? { conversationId, token } : "skip",
  ) as unknown as
    | { kind?: "dm" | "group"; name?: string; members?: MemberInfo[]; canAccess?: boolean }
    | undefined;
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
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState(false);
  const sendErrTimerRef = useRef<number | null>(null);
  const [typingVisible, setTypingVisible] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const lastReadSentRef = useRef<number>(0);
  const typingLastSentRef = useRef(0);
  const typingStopRef = useRef<number | null>(null);

  const isGroup = kind === "group";
  const membersById = useMemo(() => {
    const map = new Map<string, MemberInfo>();
    for (const m of convInfo?.members ?? []) map.set(m.userId, m);
    // Always know myself even if the info query lags behind.
    map.set(meId, { userId: meId, displayName: meName, themeColor: meColor });
    return map;
  }, [convInfo, meColor, meId, meName]);

  const senderOf = useCallback(
    (senderId: Id<"users">): MemberInfo => {
      return (
        membersById.get(senderId) ?? {
          userId: senderId,
          displayName: senderId === meId ? meName : "…",
          themeColor: meColor,
        }
      );
    },
    [membersById, meColor, meId, meName],
  );

  const list = (messages ?? []) as ChatMessage[];
  // `typers` arrives as a fresh array whenever the backend re-runs the query
  // (each keystroke refresh), so this effect re-arms the 7s auto-clear while
  // the peer keeps typing and hides the label ~7s after they stop.
  useEffect(() => {
    if (!typers || typers.length === 0) {
      setTypingVisible(false);
      return;
    }
    setTypingVisible(true);
    const t = window.setTimeout(() => setTypingVisible(false), 7000);
    return () => window.clearTimeout(t);
  }, [typers]);

  const typingNames = useMemo(() => {
    if (!typers || typers.length === 0) return "";
    const who = typers.map((uid) => senderOf(uid as Id<"users">).displayName);
    if (who.length === 1) return who[0];
    return who.length === 2 ? `${who[0]} و ${who[1]}` : `${who[0]} و ${fa(who.length - 1)} نفر دیگر`;
  }, [typers, senderOf]);
  const someoneTyping = typingVisible && typingNames.length > 0;

  // True while the reader is at/near the newest message.
  const stickRef = useRef(true);
  const forceScrollRef = useRef(false);

  const scrollToBottom = () => {
    scrolledRef.current = true;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = fromBottom < 160;
    setShowJump(fromBottom > 480);
  };

  useEffect(() => {
    if (!messages) return;
    if (!scrolledRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
      scrolledRef.current = true;
      return;
    }
    if (forceScrollRef.current) {
      forceScrollRef.current = false;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (stickRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);

  useEffect(() => {
    return () => {
      if (typingStopRef.current) window.clearTimeout(typingStopRef.current);
      void stopTypingMut({ conversationId, token });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, token]);

  // ---- Flaky-connection outbox --------------------------------------------
  const outboxRef = useRef<Record<string, PendingMessage[]>>({});
  const [, setOutboxTick] = useState(0);
  const flushBusyRef = useRef(false);
  const outboxTimerRef = useRef<number | null>(null);
  const outboxDelayRef = useRef(2000);
  const convRef = useRef(conversationId);
  convRef.current = conversationId;

  const bumpOutbox = useCallback(() => setOutboxTick((t) => t + 1), []);
  const clearOutboxTimer = useCallback(() => {
    if (outboxTimerRef.current != null) {
      window.clearTimeout(outboxTimerRef.current);
      outboxTimerRef.current = null;
    }
  }, []);

  const scheduleRetry = useCallback(() => {
    if (outboxTimerRef.current != null) return;
    outboxTimerRef.current = window.setTimeout(() => {
      outboxTimerRef.current = null;
      void flushOutboxRef.current();
    }, outboxDelayRef.current);
    outboxDelayRef.current = Math.min(outboxDelayRef.current * 2, 30_000);
  }, []);

  const flushOutbox = useCallback(async () => {
    if (flushBusyRef.current) return;
    const cid = convRef.current;
    const queued = outboxRef.current[cid];
    if (!queued || queued.length === 0) return;
    flushBusyRef.current = true;
    try {
      let idx = 0;
      while (idx < queued.length) {
        const item = queued[idx];
        try {
          await send({
            conversationId: cid,
            body: item.body,
            token,
            clientMessageId: item.clientMsgId,
          });
        } catch {
          scheduleRetry();
          return;
        }
        idx += 1;
        bumpOutbox();
      }
    } finally {
      flushBusyRef.current = false;
    }
  }, [bumpOutbox, scheduleRetry, send, token]);
  const flushOutboxRef = useRef<() => void>(() => {});
  flushOutboxRef.current = () => {
    void flushOutbox();
  };

  useEffect(() => {
    const cid = convRef.current;
    const queued = outboxRef.current[cid];
    if (!queued || queued.length === 0) return;
    const ackedIds = new Set(
      ((messages ?? []) as ChatMessage[])
        .filter((m) => m.clientMessageId && !m.deletedAt)
        .map((m) => m.clientMessageId as string),
    );
    const rest = queued.filter((p) => !ackedIds.has(p.clientMsgId));
    if (rest.length === queued.length) return;
    outboxRef.current[cid] = rest;
    saveOutbox(cid, rest);
    bumpOutbox();
  }, [messages, bumpOutbox]);

  const queueMessage = useCallback(
    (cid: Id<"conversations">, body: string, clientMsgId: string) => {
      const list = [...(outboxRef.current[cid] ?? [])];
      list.push({ body, clientMsgId, queuedAt: Date.now() });
      outboxRef.current[cid] = list;
      saveOutbox(cid, list);
      bumpOutbox();
      outboxDelayRef.current = 2000;
      scheduleRetry();
    },
    [bumpOutbox, scheduleRetry],
  );

  const dropPending = useCallback(() => {
    outboxRef.current[conversationId] = [];
    saveOutbox(conversationId, []);
    clearOutboxTimer();
    bumpOutbox();
  }, [bumpOutbox, clearOutboxTimer, conversationId]);

  const curPending = outboxRef.current[conversationId] ?? [];

  const prevPendingLenRef = useRef(0);
  useEffect(() => {
    const prev = prevPendingLenRef.current;
    prevPendingLenRef.current = curPending.length;
    if (curPending.length > prev && stickRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [curPending.length]);

  // ---- Unfinished-draft persistence ----
  const draftConvRef = useRef<Id<"conversations"> | null>(null);
  useEffect(() => {
    if (editing) return;
    if (draftConvRef.current !== conversationId) return;
    saveDraft(conversationId, draft);
  }, [conversationId, draft, editing]);
  useEffect(() => {
    draftConvRef.current = conversationId;
    setDraft(loadDraft(conversationId));
  }, [conversationId]);

  useEffect(() => {
    clearOutboxTimer();
    if (!outboxRef.current[conversationId]) {
      outboxRef.current[conversationId] = loadOutbox(conversationId);
      bumpOutbox();
    }
    outboxDelayRef.current = 2000;
    if ((outboxRef.current[conversationId] ?? []).length > 0) {
      const t = window.setTimeout(() => {
        void flushOutboxRef.current();
      }, 900);
      return () => window.clearTimeout(t);
    }
  }, [bumpOutbox, clearOutboxTimer, conversationId]);

  useEffect(() => {
    const onOnline = () => {
      outboxDelayRef.current = 2000;
      void flushOutboxRef.current();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  const notifyTyping = () => {
    if (editing) return;
    const now = Date.now();
    if (now - typingLastSentRef.current > 1500) {
      typingLastSentRef.current = now;
      void startTypingMut({ conversationId, token });
    }
    if (typingStopRef.current) window.clearTimeout(typingStopRef.current);
    typingStopRef.current = window.setTimeout(() => {
      void stopTypingMut({ conversationId, token });
    }, 2000);
  };

  const onSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    if (typingStopRef.current) window.clearTimeout(typingStopRef.current);
    void stopTypingMut({ conversationId, token });
    setSending(true);
    setSendErr(false);
    try {
      if (editing) {
        try {
          await editMut({ messageId: editing, body: text, token });
        } catch {
          setSendErr(true);
          if (sendErrTimerRef.current) window.clearTimeout(sendErrTimerRef.current);
          sendErrTimerRef.current = window.setTimeout(() => setSendErr(false), 5000);
          return;
        }
        setEditing(null);
      } else {
        const clientMsgId = newClientMsgId();
        try {
          await send({ conversationId, body: text, token, clientMessageId: clientMsgId });
        } catch {
          queueMessage(conversationId, text, clientMsgId);
          saveDraft(conversationId, "");
          return;
        }
      }
      setDraft("");
      saveDraft(conversationId, "");
      forceScrollRef.current = true;
      scrolledRef.current = true;
    } finally {
      setSending(false);
    }
  };

  useEffect(() => () => {
    if (sendErrTimerRef.current) window.clearTimeout(sendErrTimerRef.current);
    if (outboxTimerRef.current) window.clearTimeout(outboxTimerRef.current);
  }, []);

  const title = name || (isGroup ? "گروه" : "گفتگو");
  const memberCount = isGroup ? (convInfo?.members?.length ?? 0) : 0;

  return (
    <div className="flex h-full flex-col bg-dusk-50">
      {/* header */}
      <div className="safe-area flex items-center gap-2 border-b border-dusk-300/40 bg-dusk-50/95 px-3 py-2 backdrop-blur">
        <button
          onClick={onBack}
          className="grid h-10 w-10 place-items-center rounded-full text-dusk-700 transition hover:bg-dusk-200/70"
          aria-label="بازگشت"
        >
          <ArrowRight size={20} /> {/* RTL: back arrow points right */}
        </button>
        <Avatar name={title} color={color} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-extrabold text-dusk-900">{title}</p>
          <p className={`truncate text-xs ${someoneTyping ? "text-ember-400" : "text-dusk-600"}`}>
            {someoneTyping
              ? `${typingNames} در حال نوشتن…`
              : isGroup
                ? memberCount > 0
                  ? `گروه ${fa(memberCount)} نفره`
                  : "گروه"
                : "گفتگوی خصوصی"}
          </p>
        </div>
        {isGroup ? (
          <>
            <button
              onClick={onCallAudio}
              className="grid h-11 w-11 place-items-center rounded-full bg-sage-600 text-white shadow-md shadow-black/30 transition hover:bg-sage-500 active:scale-95"
              aria-label="تماس صوتی گروهی"
              title="تماس صوتی گروهی"
            >
              <Phone size={19} />
            </button>
            <button
              onClick={onCallVideo}
              className="grid h-11 w-11 place-items-center rounded-full bg-ember-400 text-cocoa shadow-md shadow-black/30 ring-1 ring-ember-300/40 transition hover:bg-ember-300 active:scale-95"
              aria-label="تماس تصویری گروهی"
              title="تماس تصویری گروهی"
            >
              <Video size={19} />
            </button>
          </>
        ) : (
          <button
            onClick={onCallVideo}
            className="grid h-11 w-11 place-items-center rounded-full bg-ember-400 text-cocoa shadow-md shadow-black/30 ring-1 ring-ember-300/40 transition hover:bg-ember-300 active:scale-95"
            aria-label="تماس تصویری"
            title="تماس تصویری"
          >
            <Video size={19} />
          </button>
        )}
      </div>

      {/* messages */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="scrollbar-thin h-full space-y-2 overflow-y-auto px-3 py-4">
          <div className="space-y-1">
            {list.length === 0 && curPending.length === 0 && (
              <div className="py-14 text-center">
                <div
                  className="mx-auto grid h-20 w-20 place-items-center rounded-[32px]"
                  style={{ backgroundColor: color + "22", color }}
                >
                  <Pencil size={30} />
                </div>
                <p className="mt-4 font-extrabold text-dusk-950">سلام!</p>
                <p className="mt-1 text-sm text-dusk-600">
                  {isGroup ? (
                    <>
                      همهٔ اعضای گروه اینجا با هم گفتگو می‌کنند؛ تماس گروهی صوتی و تصویری هم دارد.
                    </>
                  ) : (
                    <>
                      از {name} با <Phone size={12} className="inline" style={{ marginBottom: -2 }} /> تماس بگیر یا پیام بده.
                    </>
                  )}
                </p>
              </div>
            )}
            {list.map((m, idx) => {
              const prev = idx > 0 ? list[idx - 1] : null;
              const showDay = !prev || dayKey(m.createdAt) !== dayKey(prev.createdAt);
              const showSender =
                isGroup && !m.isMine && (!prev || prev.senderId !== m.senderId || dayKey(prev.createdAt) !== dayKey(m.createdAt));
              const sender = senderOf(m.senderId);
              return (
                <Fragment key={m._id}>
                  {showDay && (
                    <div className="flex justify-center py-2">
                      <span className="rounded-full bg-dusk-200/80 px-3 py-1 text-[11px] font-semibold text-dusk-700 ring-1 ring-ember-300/15">
                        {dayLabel(m.createdAt)}
                      </span>
                    </div>
                  )}
                  {showSender && !m.deletedAt && (
                    <div className="mt-2 flex justify-start px-1">
                      <span className="text-[11px] font-bold" style={{ color: sender.themeColor }}>
                        {sender.displayName}
                      </span>
                    </div>
                  )}
                  <Bubble
                    msg={m}
                    meColor={meColor}
                    menu={menu}
                    setMenu={setMenu}
                    isGroup={isGroup}
                    onReact={(emoji) => {
                      setMenu(null);
                      void react({ messageId: m._id, emoji, token }).catch(() => {});
                    }}
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
            {curPending.map((p) => (
              <PendingBubble key={p.clientMsgId} body={p.body} />
            ))}
          </div>
          <div ref={bottomRef} className="h-px" />
        </div>
        {showJump && (
          <button
            onClick={scrollToBottom}
            aria-label="رفتن به آخرین پیام"
            className="absolute bottom-5 left-4 z-10 grid h-11 w-11 place-items-center rounded-full border border-ember-300/30 bg-dusk-100/95 text-ember-300 shadow-xl shadow-black/50 backdrop-blur transition hover:bg-dusk-200 active:scale-90"
          >
            <ArrowDown size={18} />
          </button>
        )}
      </div>

      {/* composer */}
      <div className="safe-area flex flex-col gap-1.5 border-t border-dusk-300/50 bg-dusk-100/90 px-3 pt-2.5 pb-3 backdrop-blur">
        {sendErr && (
          <div className="animate-rise flex items-center gap-2 rounded-xl bg-rose-500/15 px-3 py-2 text-xs font-bold text-rose-300 ring-1 ring-rose-400/25">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose-500 text-[10px] font-black text-white">
              !
            </span>
            ویرایش ذخیره نشد — دوباره تلاش کن
            <button
              onClick={() => setSendErr(false)}
              className="mr-auto font-black text-rose-400/80 transition hover:text-rose-300"
              aria-label="بستن"
            >
              ✕
            </button>
          </div>
        )}
        {editing && (
          <div className="mb-0.5 flex items-center gap-2 rounded-xl bg-ember-400/12 px-3 py-2 text-sm text-ember-200 ring-1 ring-ember-400/25">
            <Pencil size={15} /> ویرایش پیام
            <button onClick={() => { setEditing(null); setDraft(""); }} className="font-bold">✕</button>
            <span className="ml-auto truncate text-xs text-ember-300/80">{draft || "…"}</span>
          </div>
        )}
        {curPending.length > 0 && (
          <div className="animate-rise flex items-center gap-2 rounded-xl bg-ember-400/12 px-3 py-2 text-xs font-bold text-ember-200 ring-1 ring-ember-400/25">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ember-400 text-[10px] font-black text-cocoa">
              {fa(curPending.length)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {curPending.length === 1
                ? "پیام در حال ارسال است — خودکار دوباره تلاش میشود"
                : "پیامها در حال ارسالاند — خودکار دوباره تلاش میشود"}
            </span>
            <button
              type="button"
              onClick={() => {
                outboxDelayRef.current = 2000;
                void flushOutbox();
              }}
              className="flex shrink-0 items-center gap-1 rounded-full bg-ember-400 px-3 py-1.5 text-cocoa transition hover:bg-ember-300 active:scale-95"
            >
              <RefreshCw size={12} /> ارسال
            </button>
            <button
              type="button"
              onClick={dropPending}
              aria-label="حذف از صف ارسال"
              title="حذف از صف"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ember-300/70 transition hover:bg-ember-400/15 active:scale-90"
            >
              ✕
            </button>
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
            className="min-h-[48px] max-h-32 flex-1 resize-none rounded-2xl border border-dusk-300/60 bg-dusk-50/80 px-4 py-3 text-[15px] text-dusk-950 caret-ember-300 shadow-sm outline-none placeholder:text-dusk-600 focus:border-ember-400/70 focus:ring-2 focus:ring-ember-400/30"
          />
          <button
            onClick={onSend}
            disabled={sending}
            className={`grid h-12 w-12 shrink-0 place-items-center rounded-full bg-gradient-to-br from-ember-300 to-ember-500 text-cocoa shadow-lg shadow-black/40 transition hover:from-ember-400 hover:to-ember-600 active:scale-90 ${
              sending ? "cursor-wait opacity-70" : ""
            }`}
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

function PendingBubble({ body }: { body: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%]">
        <div className="rounded-[20px] rounded-br-md border border-dashed border-ember-400/60 px-4 py-2.5 text-[15px] leading-7 text-dusk-900 shadow-sm" style={{ background: "linear-gradient(135deg, #3a250f, #1d1208)" }}>
          <p className="whitespace-pre-wrap break-words">{body}</p>
          <div className="mt-0.5 flex items-center gap-1 text-[10px] font-bold text-ember-300">
            <Clock size={11} />
            <span>در حال ارسال…</span>
          </div>
        </div>
      </div>
    </div>
  );
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
  isGroup,
  onReact,
  onEdit,
  onDelete,
}: {
  msg: ChatMessage;
  meColor: string;
  menu: Id<"messages"> | null;
  setMenu: (id: Id<"messages"> | null) => void;
  isGroup: boolean;
  onReact: (emoji: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const mine = msg.isMine;
  const isMenu = menu === msg._id;
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      {isMenu && (
        <div
          className="fixed inset-0 z-10"
          onClick={(e) => {
            e.stopPropagation();
            setMenu(null);
          }}
          aria-hidden="true"
        />
      )}
      <div className={`max-w-[82%] ${mine ? "items-end" : "items-start"}`}>
        <div
          onClick={(e) => {
            e.stopPropagation();
            setMenu(isMenu ? null : msg._id);
          }}
          className={`relative select-none rounded-[20px] px-4 py-2.5 text-[15px] leading-7 transition active:scale-[0.99] ${
            mine
              ? "rounded-br-md text-white shadow-md shadow-dusk-900/15"
              : "rounded-bl-md bg-dusk-100 text-dusk-950 shadow-[0_1px_3px_rgba(0,0,0,0.35)] ring-1 ring-dusk-300/50"
          } ${msg.deletedAt ? "opacity-70" : ""}`}
          style={mine ? { background: `linear-gradient(135deg, ${meColor}, ${darken(meColor)})` } : undefined}
        >
          {msg.deletedAt ? (
            <span className="italic opacity-80">این پیام حذف شد ←</span>
          ) : (
            <p className="whitespace-pre-wrap break-words">{msg.body}</p>
          )}
          <div className={`mt-0.5 flex items-center gap-1 text-[10px] ${mine ? "text-white/75" : "text-dusk-600"}`}>
            {msg.editedAt && <span>ویرایش شد</span>}
            <span>{clock(msg.createdAt)}</span>
            {mine && !isGroup && (
              <span className="flex items-center text-ember-300" title={msg.read ? "خوانده شد" : "ارسال شد"}>
                {msg.read && <Check size={11} strokeWidth={3} />}
                <Check size={11} strokeWidth={3} className={msg.read ? "-ml-[6px]" : ""} />
              </span>
            )}
          </div>

          {!msg.deletedAt && Object.keys(msg.reactions).length > 0 && (
            <div
              className={`absolute -bottom-3 flex gap-0.5 rounded-full border border-dusk-300/60 bg-dusk-100/95 px-1.5 py-0.5 text-sm shadow-md shadow-black/40 ${
                mine ? "right-2" : "left-2"
              }`}
            >
              {Object.entries(msg.reactions).map(([emoji, count]) => (
                <span key={emoji} title={`${fa(count)}`}>
                  {emoji}
                  {count > 1 && <span className="text-[10px] text-dusk-600">{fa(count)}</span>}
                </span>
              ))}
            </div>
          )}

          {isMenu && !msg.deletedAt && (
            <div
              onClick={(e) => e.stopPropagation()}
              className={`animate-rise absolute bottom-full z-20 mb-2 flex items-center gap-1 rounded-2xl border border-ember-300/25 bg-dusk-100 p-1.5 shadow-xl shadow-black/60 ${
                mine ? "right-0" : "left-0"
              }`}
            >
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => onReact(e)}
                  className="grid h-9 w-9 place-items-center rounded-xl text-lg transition hover:bg-dusk-200/80 active:scale-90"
                >
                  {e}
                </button>
              ))}
              {mine && (
                <button
                  onClick={onEdit}
                  className="grid h-9 w-9 place-items-center rounded-xl text-dusk-600 transition hover:bg-dusk-200/80"
                  aria-label="ویرایش"
                >
                  <Pencil size={16} />
                </button>
              )}
              {mine && (
                <button
                  onClick={onDelete}
                  className="grid h-9 w-9 place-items-center rounded-xl text-ember-300 transition hover:bg-ember-400/15"
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
