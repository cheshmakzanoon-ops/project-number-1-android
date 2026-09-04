import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { ArrowDown, ArrowRight, Check, Clock, Pencil, Phone, RefreshCw, Send, Trash2 } from "lucide-react";
import { Avatar } from "./Avatar";
import { clock, fa, formatDay } from "../lib/format";
import { loadDraft, loadOutbox, newClientMsgId, saveDraft, saveOutbox, type PendingMessage } from "../lib/outbox";
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
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState(false);
  const sendErrTimerRef = useRef<number | null>(null);
  // On a flaky link the peer's "typing" row can linger forever (their app was
  // killed mid-keystroke). Mirror the server signal through a short local
  // timer so the label always clears even if the row never gets removed.
  const [typingVisible, setTypingVisible] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const lastReadSentRef = useRef<number>(0);
  const typingLastSentRef = useRef(0);
  const typingStopRef = useRef<number | null>(null);

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
  const someoneTyping = typingVisible;

  // True while the reader is at/near the newest message; new messages only
  // auto-follow when this is set, so someone reading history is never yanked
  // down to the bottom mid-scroll.
  const stickRef = useRef(true);
  // Set when the user sends a message: their own send always scrolls into
  // view even if they were reading older messages.
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
      // First arrival in a freshly opened conversation: anchor at the newest.
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
      scrolledRef.current = true;
      return;
    }
    if (forceScrollRef.current) {
      forceScrollRef.current = false;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    // Follow new incoming messages only while already at the bottom.
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

  // Dismiss the message action menu with the Escape key (outside taps are
  // handled by an invisible backdrop rendered under the menu, so touch taps
  // on the menu's own buttons can never be swallowed by a dismiss listener).
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);

  useEffect(() => {
    // Tell the peer we're no longer typing when we leave the conversation.
    return () => {
      if (typingStopRef.current) window.clearTimeout(typingStopRef.current);
      void stopTypingMut({ conversationId, token });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, token]);

  // ---- Flaky-connection outbox --------------------------------------------
  // A message whose send failed is never dropped: it is parked in a persisted
  // per-conversation queue (with the SAME clientMessageId the failed attempt
  // used, so a retry can never duplicate it server-side) and retried
  // automatically with capped backoff, on every "online" event, and whenever
  // the conversation is reopened.
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
      // Walk the queue from the oldest item. Successfully sent items stay in
      // the queue until their real row shows up in the subscription (pruned
      // by the match effect below) — removing them here would make the
      // pending bubble vanish for a beat before the acked message appears on
      // slow links. Resending an already-landed item is harmless: the server
      // dedupes on clientMessageId.
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

  // Prune queued messages whose real row has arrived in the subscription (the
  // send landed but the query lagged behind the mutation ack). Keeping them
  // queued until then is what makes the pending bubble transition seamlessly
  // into the real message instead of flickering out and back in.
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

  // When a new message is parked in the queue (or a persisted queue is
  // restored on open), bring its pending bubble into view — an offline send
  // should be as visible as an online one.
  const prevPendingLenRef = useRef(0);
  useEffect(() => {
    const prev = prevPendingLenRef.current;
    prevPendingLenRef.current = curPending.length;
    if (curPending.length > prev && stickRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [curPending.length]);

  // ---- Unfinished-draft persistence ----
  // Restore whatever the user was typing when they last left this
  // conversation (or reloaded the page while a send was queued offline), and
  // keep it saved while they type. Skipped while editing an existing message.
  const draftConvRef = useRef<Id<"conversations"> | null>(null);
  useEffect(() => {
    if (editing) return;
    if (draftConvRef.current !== conversationId) return; // conv just switched
    saveDraft(conversationId, draft);
  }, [conversationId, draft, editing]);
  useEffect(() => {
    draftConvRef.current = conversationId;
    setDraft(loadDraft(conversationId));
  }, [conversationId]);

  // Load the queue for the open conversation and auto-flush shortly after
  // opening (covers messages parked earlier that never got retried).
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

  // The browser says we're back online: try the queue right away.
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
        // Every logical message gets a stable client id so an outbox retry can
        // never create a duplicate even if this first attempt actually landed.
        const clientMsgId = newClientMsgId();
        try {
          await send({ conversationId, body: text, token, clientMessageId: clientMsgId });
        } catch {
          // Never eat the user's message: park it in the persisted outbox and
          // auto-retry with backoff instead of losing the text.
          queueMessage(conversationId, text, clientMsgId);
          saveDraft(conversationId, "");
          return;
        }
      }
      setDraft("");
      saveDraft(conversationId, "");
      // Own sends scroll into view even when reading older history above.
      forceScrollRef.current = true;
      scrolledRef.current = true;
    } finally {
      setSending(false);
    }
  };

  // Clear the notices/timers when the screen unmounts so stale timers never
  // fire into a fresh conversation.
  useEffect(() => () => {
    if (sendErrTimerRef.current) window.clearTimeout(sendErrTimerRef.current);
    if (outboxTimerRef.current) window.clearTimeout(outboxTimerRef.current);
  }, []);

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
          aria-label="تماس تصویری"
          title="تماس تصویری"
        >
          <Phone size={19} />
        </button>
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
                  onReact={(emoji) => {
                    // Close the action menu immediately (the emoji picker is
                    // inside the document-level dismiss zone, so without this
                    // the menu stays open after every reaction).
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
            className="absolute bottom-5 left-4 z-10 grid h-11 w-11 place-items-center rounded-full border border-dusk-100/80 bg-white/95 text-dusk-600 shadow-xl backdrop-blur transition hover:bg-white active:scale-90"
          >
            <ArrowDown size={18} />
          </button>
        )}
      </div>

      {/* composer */}
      <div className="safe-area flex flex-col gap-1.5 border-t border-dusk-100/70 bg-white/85 px-3 pt-2.5 pb-3 backdrop-blur">
        {sendErr && (
          <div className="animate-rise flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs font-bold text-rose-600 ring-1 ring-rose-200">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose-500 text-[10px] font-black text-white">
              !
            </span>
            ویرایش ذخیره نشد — دوباره تلاش کن
            <button
              onClick={() => setSendErr(false)}
              className="mr-auto font-black text-rose-400 transition hover:text-rose-600"
              aria-label="بستن"
            >
              ✕
            </button>
          </div>
        )}
        {editing && (
          <div className="mb-0.5 flex items-center gap-2 rounded-xl bg-ember-100 px-3 py-2 text-sm text-ember-700">
            <Pencil size={15} /> ویرایش پیام
            <button onClick={() => { setEditing(null); setDraft(""); }} className="font-bold">✕</button>
            <span className="ml-auto truncate text-xs text-ember-500">{draft || "…"}</span>
          </div>
        )}
        {curPending.length > 0 && (
          <div className="animate-rise flex items-center gap-2 rounded-xl bg-ember-50 px-3 py-2 text-xs font-bold text-ember-800 ring-1 ring-ember-200">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ember-400 text-[10px] font-black text-white">
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
              className="flex shrink-0 items-center gap-1 rounded-full bg-ember-500 px-3 py-1.5 text-white transition hover:bg-ember-600 active:scale-95"
            >
              <RefreshCw size={12} /> ارسال
            </button>
            <button
              type="button"
              onClick={dropPending}
              aria-label="حذف از صف ارسال"
              title="حذف از صف"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ember-400 transition hover:bg-ember-100 active:scale-90"
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
          className="min-h-[48px] max-h-32 flex-1 resize-none rounded-2xl border border-dusk-100 bg-white px-4 py-3 text-[15px] text-dusk-900 shadow-sm outline-none placeholder:text-dusk-400 focus:border-ember-300 focus:ring-2 focus:ring-ember-400/50"
        />
        <button
          onClick={onSend}
          disabled={sending}
          className={`grid h-12 w-12 shrink-0 place-items-center rounded-full bg-gradient-to-br from-ember-400 to-ember-600 text-white shadow-lg shadow-ember-500/30 transition hover:from-ember-500 hover:to-ember-700 active:scale-90 ${
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

/**
 * A message whose send hasn't been confirmed yet (parked in the outbox while
 * the connection is flaky). Rendered as a distinctly "in flight" bubble that
 * turns into the real message automatically once the server row arrives — the
 * text is never lost and never duplicated.
 */
function PendingBubble({ body }: { body: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%]">
        <div className="rounded-[20px] rounded-br-md border border-dashed border-ember-400/70 px-4 py-2.5 text-[15px] leading-7 text-dusk-800 shadow-sm" style={{ background: "linear-gradient(135deg, #fdf1e3, #f9e0c4)" }}>
          <p className="whitespace-pre-wrap break-words">{body}</p>
          <div className="mt-0.5 flex items-center gap-1 text-[10px] font-bold text-ember-700">
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
      {/* Invisible backdrop: taps outside the open action menu close it.
          Rendered BELOW the menu (z-10 < z-20) but ABOVE everything else, so
          the menu's own buttons receive their taps untouched — a document-
          level touchstart/click dismiss used to swallow the very tap that
          should have triggered a reaction/edit/delete on touch devices. */}
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

          {/* reaction chips (hidden on deleted messages) */}
          {!msg.deletedAt && Object.keys(msg.reactions).length > 0 && (
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