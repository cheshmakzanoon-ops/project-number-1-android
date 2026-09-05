import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { useSoftQuery } from "../lib/softQuery";
import {
  ArrowDown,
  ArrowRight,
  Bell,
  BellOff,
  Check,
  Clock,
  CornerUpLeft,
  ImagePlus,
  Mic,
  Pencil,
  Phone,
  RefreshCw,
  Search,
  Send,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { Avatar } from "./Avatar";
import { ImageBubble, ReplyChip, VoiceNoteBubble } from "./MessageMedia";
import { Lightbox } from "./Lightbox";
import { clock, fa, formatDay, relative } from "../lib/format";
import { loadDraft, loadOutbox, newClientMsgId, saveDraft, saveOutbox, type PendingMessage } from "../lib/outbox";
import {
  compressImage,
  formatDurationMs,
  objectUrlFor,
  putStorageFile,
  startRecording,
  type VoiceRecording,
} from "../lib/media";
import type { ChatMessage, MessageKind, ReplyQuote, SearchHit } from "../lib/types";
import type { Id } from "../convex/_generated/dataModel";

const EMOJIS = ["❤️", "👍", "😂", "😮", "😢", "🙏"];

type MemberInfo = {
  userId: Id<"users">;
  displayName: string;
  themeColor: string;
  online?: boolean;
  lastSeenAt?: number;
};

type ConvInfo = {
  kind?: "dm" | "group";
  name?: string;
  members?: MemberInfo[];
  canAccess?: boolean;
  muted?: boolean;
};

type PendingPhoto = { blob: Blob; url: string };

/** Recording needs both getUserMedia and MediaRecorder (no SSR concern here). */
const VOICE_SUPPORTED =
  typeof MediaRecorder !== "undefined" &&
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices !== "undefined" &&
  !!navigator.mediaDevices.getUserMedia;

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
  // ---- queries (soft: a backend that can't answer these must never throw
  // through useQuery and crash the chat onto the error panel — missing data
  // renders as the normal empty/loading state and fills in automatically).
  const { data: messages } = useSoftQuery(
    api.messages.list,
    token ? { conversationId, token } : "skip",
  ) as unknown as { data: ChatMessage[] | undefined; unavailable: boolean };
  const { data: convInfo } = useSoftQuery(
    api.conversations.conversation,
    token ? { conversationId, token } : "skip",
  ) as unknown as { data: ConvInfo | undefined; unavailable: boolean };
  const { data: typers } = useSoftQuery(
    api.typing.whoIsTyping,
    conversationId && token ? { conversationId, token } : "skip",
  ) as unknown as { data: string[] | undefined; unavailable: boolean };

  // ---- mutations ----
  const send = useMutation(api.messages.send);
  const editMut = useMutation(api.messages.edit);
  const delMut = useMutation(api.messages.remove);
  const react = useMutation(api.messages.toggleReaction);
  const markRead = useMutation(api.conversations.markRead);
  const setMutedMut = useMutation(api.conversations.setMuted);
  const startTypingMut = useMutation(api.typing.startTyping);
  const stopTypingMut = useMutation(api.typing.stopTyping);
  const uploadUrlMut = useMutation(api.messages.uploadUrl);

  // ---- chat state ----
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<Id<"messages"> | null>(null);
  const [menu, setMenu] = useState<Id<"messages"> | null>(null);
  const [sending, setSending] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const errTimerRef = useRef<number | null>(null);
  const [typingVisible, setTypingVisible] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const lastReadSentRef = useRef(0);
  const typingLastSentRef = useRef(0);
  const typingStopRef = useRef<number | null>(null);

  // ---- replies / search / jump ----
  const [replying, setReplying] = useState<ReplyQuote | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const { data: searchResults, unavailable: searchUnavailable } = useSoftQuery(
    api.messages.search,
    searchOpen && searchQ.trim().length > 0 && token ? { conversationId, q: searchQ, token } : "skip",
  ) as unknown as { data: SearchHit[] | undefined; unavailable: boolean };
  const [jumpAnchor, setJumpAnchor] = useState<Id<"messages"> | null>(null);
  // Soft: jump-to-message needs `messages.listAround`; while the backend is
  // missing it, a tap on an out-of-range quote simply stays put (no crash).
  const { data: anchoredRows } = useSoftQuery(
    api.messages.listAround,
    jumpAnchor && token ? { conversationId, anchorId: jumpAnchor, token } : "skip",
  ) as unknown as { data: ChatMessage[] | undefined; unavailable: boolean };
  const [highlightId, setHighlightId] = useState<Id<"messages"> | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const [viewing, setViewing] = useState<ChatMessage | null>(null);

  // ---- media compose ----
  const [photoPending, setPhotoPending] = useState<PendingPhoto | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [voicePhase, setVoicePhase] = useState<"idle" | "recording" | "sending">("idle");
  const [voiceMs, setVoiceMs] = useState(0);
  const voiceHandleRef = useRef<{ stop: () => Promise<VoiceRecording>; cancel: () => void } | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const isGroup = kind === "group";
  const anchored = jumpAnchor != null && anchoredRows != null;

  // Clean slate whenever the conversation (or the account) changes.
  useEffect(() => {
    setReplying(null);
    setSearchOpen(false);
    setSearchQ("");
    setJumpAnchor(null);
    setHighlightId(null);
    setViewing(null);
    setEditing(null);
    setMenu(null);
    setErrMsg(null);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    setPhotoPending((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setMediaBusy(false);
    voiceHandleRef.current?.cancel();
    voiceHandleRef.current = null;
    setVoicePhase("idle");
    setVoiceMs(0);
  }, [conversationId, token]);

  const membersById = useMemo(() => {
    const map = new Map<string, MemberInfo>();
    for (const m of convInfo?.members ?? []) map.set(m.userId, m);
    map.set(meId, { userId: meId, displayName: meName, themeColor: meColor });
    return map;
  }, [convInfo, meColor, meId, meName]);

  const senderOf = useCallback(
    (senderId: Id<"users">): MemberInfo =>
      membersById.get(senderId) ?? { userId: senderId, displayName: senderId === meId ? meName : "…", themeColor: meColor },
    [membersById, meColor, meId, meName],
  );

  const latest = (messages ?? []) as ChatMessage[];
  const rows: ChatMessage[] = anchored ? (anchoredRows ?? []) : latest;
  const muted = convInfo?.muted ?? false;

  // ---- typing indicator ----
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

  // ---- scroll stickiness ----
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
    if (anchored) return; // anchored view scrolls to its anchor, not the bottom
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
  }, [messages, latest.length, anchored]);

  const scrollToMsgId = useCallback((id: Id<"messages">) => {
    const el = scrollRef.current?.querySelector(`[data-mid="${id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const flash = useCallback((id: Id<"messages">) => {
    setHighlightId(id);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setHighlightId(null), 1900);
  }, []);

  // Once the around-anchor window arrives, land on the anchor.
  useEffect(() => {
    if (!jumpAnchor || !anchoredRows) return;
    if (!anchoredRows.some((r) => r._id === jumpAnchor)) return;
    scrollToMsgId(jumpAnchor);
    flash(jumpAnchor);
  }, [anchoredRows, jumpAnchor, scrollToMsgId, flash]);

  const jumpTo = useCallback(
    (id: Id<"messages">) => {
      setSearchOpen(false);
      setSearchQ("");
      if (anchored) {
        if ((anchoredRows ?? []).some((r) => r._id === id)) {
          scrollToMsgId(id);
          flash(id);
        } else {
          setJumpAnchor(id);
        }
        return;
      }
      if (latest.some((r) => r._id === id)) {
        scrollToMsgId(id);
        flash(id);
      } else {
        setJumpAnchor(id);
      }
    },
    [anchored, anchoredRows, flash, latest, scrollToMsgId],
  );

  const backToLatest = useCallback(() => {
    setJumpAnchor(null);
    setHighlightId(null);
    scrolledRef.current = false;
  }, []);

  // ---- read receipts ----
  useEffect(() => {
    if (anchored) return;
    const unread = latest.some((m) => !m.isMine && !m.deletedAt);
    if (unread && Date.now() - lastReadSentRef.current > 800) {
      lastReadSentRef.current = Date.now();
      markRead({ conversationId, token });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest.length, conversationId, token, anchored]);

  // close menu on Escape
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

  // ---- flaky-connection outbox (text only) ----
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
          await send({ conversationId: cid, body: item.body, token, clientMessageId: item.clientMsgId });
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
      (latest as ChatMessage[]).filter((m) => m.clientMessageId && !m.deletedAt).map((m) => m.clientMessageId as string),
    );
    const rest = queued.filter((p) => !ackedIds.has(p.clientMsgId));
    if (rest.length === queued.length) return;
    outboxRef.current[cid] = rest;
    saveOutbox(cid, rest);
    bumpOutbox();
  }, [latest, bumpOutbox]);

  const queueMessage = useCallback(
    (cid: Id<"conversations">, body: string, clientMsgId: string) => {
      const list2 = [...(outboxRef.current[cid] ?? [])];
      list2.push({ body, clientMsgId, queuedAt: Date.now() });
      outboxRef.current[cid] = list2;
      saveOutbox(cid, list2);
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
    if (curPending.length > prev && stickRef.current && !anchored) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [curPending.length, anchored]);

  // ---- draft persistence ----
  const draftConvRef = useRef<Id<"conversations"> | null>(null);
  useEffect(() => {
    if (editing) return;
    if (draftConvRef.current !== conversationId) return;
    if (photoPending) return;
    saveDraft(conversationId, draft);
  }, [conversationId, draft, editing, photoPending]);
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

  useEffect(
    () => () => {
      if (errTimerRef.current) window.clearTimeout(errTimerRef.current);
      if (outboxTimerRef.current) window.clearTimeout(outboxTimerRef.current);
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const showError = useCallback((text: string) => {
    setErrMsg(text);
    if (errTimerRef.current) window.clearTimeout(errTimerRef.current);
    errTimerRef.current = window.setTimeout(() => setErrMsg(null), 6000);
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
    try {
      if (editing) {
        try {
          await editMut({ messageId: editing, body: text, token });
        } catch {
          showError("ویرایش ذخیره نشد — دوباره تلاش کن");
          return;
        }
        setEditing(null);
        setDraft("");
        saveDraft(conversationId, "");
        forceScrollRef.current = true;
        scrolledRef.current = true;
        return;
      }
      const clientMsgId = newClientMsgId();
      try {
        await send({
          conversationId,
          body: text,
          token,
          clientMessageId: clientMsgId,
          replyToId: replying?.id,
        });
      } catch {
        // Offline/flaky: keep the text in the persistent outbox (reply
        // context is a UI nicety and is intentionally dropped on retry).
        queueMessage(conversationId, text, clientMsgId);
        saveDraft(conversationId, "");
        return;
      }
      setDraft("");
      saveDraft(conversationId, "");
      setReplying(null);
      if (anchored) backToLatest();
      forceScrollRef.current = true;
      scrolledRef.current = true;
    } finally {
      setSending(false);
    }
  };

  const handleReply = useCallback(
    (m: ChatMessage) => {
      setEditing(null);
      const sender = senderOf(m.senderId);
      setReplying({
        id: m._id,
        senderName: sender.displayName,
        senderColor: sender.themeColor,
        body: m.body,
        deleted: !!m.deletedAt,
        kind: m.kind ?? "text",
        isMine: m.isMine,
      });
      setMenu(null);
    },
    [senderOf],
  );

  // ---- media: upload + send ----
  const uploadAndSend = useCallback(
    async (args: { kind: MessageKind; blob: Blob; body?: string; durationMs?: number }) => {
      if (mediaBusy) return false;
      setMediaBusy(true);
      try {
        const up = await uploadUrlMut({ token });
        const storageId = await putStorageFile(up, args.blob);
        await send({
          conversationId,
          token,
          kind: args.kind,
          storageId: storageId as Id<"_storage">,
          body: args.body,
          mimeType: args.blob.type || undefined,
          durationMs: args.durationMs,
          clientMessageId: newClientMsgId(),
          replyToId: replying?.id,
        });
        return true;
      } catch {
        showError(args.kind === "image" ? "ارسال عکس نشد — دوباره تلاش کن" : "ارسال پیام صوتی نشد — دوباره تلاش کن");
        return false;
      } finally {
        setMediaBusy(false);
      }
    },
    [conversationId, mediaBusy, replying, send, showError, token, uploadUrlMut],
  );

  const pickImage = async (file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const blob = await compressImage(file);
      setPhotoPending({ blob, url: objectUrlFor(blob) });
      setErrMsg(null);
    } catch {
      showError("خواندن عکس ممکن نشد — عکس دیگری انتخاب کن");
    }
  };

  const cancelPhoto = () => {
    setPhotoPending((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    setDraft("");
  };

  const sendPhoto = async () => {
    if (!photoPending) return;
    const caption = draft.trim();
    const ok = await uploadAndSend({ kind: "image", blob: photoPending.blob, body: caption || undefined });
    if (ok) {
      cancelPhoto();
      setReplying(null);
      if (anchored) backToLatest();
      forceScrollRef.current = true;
      scrolledRef.current = true;
    }
  };

  const sendVoice = async (rec: VoiceRecording) => {
    // Under a second of audio is almost always a mis-tap.
    if (rec.durationMs < 900) {
      setVoiceError("ضبط خیلی کوتاه بود — دوباره امتحان کن");
      window.setTimeout(() => setVoiceError(null), 3000);
      return true; // consumed, nothing to send
    }
    const ok = await uploadAndSend({ kind: "voice", blob: rec.blob, durationMs: rec.durationMs });
    if (ok) {
      setReplying(null);
      if (anchored) backToLatest();
      forceScrollRef.current = true;
      scrolledRef.current = true;
    }
    return ok;
  };

  // ---- voice note control (record → review → send) ----
  const startVoice = useCallback(() => {
    if (!VOICE_SUPPORTED || voicePhase !== "idle" || mediaBusy) return;
    setVoiceMs(0);
    setVoiceError(null);
    try {
      const handle = startRecording({
        onTick: setVoiceMs,
        onError: (msg) => {
          voiceHandleRef.current = null;
          setVoicePhase("idle");
          setVoiceMs(0);
          showError(msg);
        },
      });
      voiceHandleRef.current = handle;
      setVoicePhase("recording");
    } catch {
      setVoicePhase("idle");
      showError("ضبط صدا ممکن نیست — میکروفون را بررسی کن");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voicePhase, mediaBusy, showError]);

  const cancelVoice = useCallback(() => {
    voiceHandleRef.current?.cancel();
    voiceHandleRef.current = null;
    setVoicePhase("idle");
    setVoiceMs(0);
  }, []);

  const finishVoice = useCallback(async () => {
    const handle = voiceHandleRef.current;
    if (!handle) return;
    setVoicePhase("sending");
    try {
      const rec = await handle.stop();
      voiceHandleRef.current = null;
      const ok = await sendVoice(rec);
      setVoiceMs(0);
      setVoicePhase("idle");
      void ok;
    } catch {
      voiceHandleRef.current = null;
      setVoicePhase("idle");
      setVoiceMs(0);
      showError("ضبط کامل نشد — دوباره امتحان کن");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendVoice, showError]);

  // If the user leaves mid-recording (e.g. call overlay takes over), stop.
  useEffect(() => {
    return () => {
      voiceHandleRef.current?.cancel();
      voiceHandleRef.current = null;
    };
  }, []);

  // ---- toggles ----
  const toggleMute = () => {
    void setMutedMut({ conversationId, muted: !muted, token }).catch(() => {});
  };

  // ---- header subtitle ----
  const dmPeer = !isGroup ? convInfo?.members?.find((m) => m.userId !== meId) : undefined;
  let subtitle: ReactNode = null;
  if (someoneTyping) {
    subtitle = <span className="text-ember-400">در حال نوشتن…</span>;
  } else if (isGroup) {
    const count = convInfo?.members?.length ?? 0;
    subtitle = count > 0 ? `گروه ${fa(count)} نفره` : "گروه";
  } else if (dmPeer?.online) {
    subtitle = <span className="font-bold text-sage-400">آنلاین</span>;
  } else if (dmPeer?.lastSeenAt) {
    subtitle = <>آخرین بازدید {relative(dmPeer.lastSeenAt)}</>;
  } else {
    subtitle = "گفتگوی خصوصی";
  }

  const title = name || (isGroup ? "گروه" : "گفتگو");

  const toggleSearch = () => {
    const next = !searchOpen;
    setSearchOpen(next);
    setSearchQ("");
  };

  const openSearchHit = (hit: SearchHit) => {
    jumpTo(hit._id);
  };

  const hitKindLabel = (hit: SearchHit) =>
    hit.kind === "image" ? "📷 عکس" : hit.kind === "voice" ? "🎤 پیام صوتی" : "";

  return (
    <div className="relative flex h-full flex-col bg-dusk-50">
      {/* ================= header ================= */}
      <div className="safe-area z-20 flex items-center gap-2 border-b border-dusk-300/40 bg-dusk-50/95 px-3 py-2 backdrop-blur">
        <button
          onClick={onBack}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-dusk-700 transition hover:bg-dusk-200/70"
          aria-label="بازگشت"
        >
          <ArrowRight size={20} />
        </button>
        <Avatar name={title} color={color} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-extrabold text-dusk-900">{title}</p>
          <p className={`truncate text-xs ${someoneTyping ? "text-ember-400" : "text-dusk-600"}`}>{subtitle}</p>
        </div>
        <HeaderBtn label="جستجو در گفتگو" onClick={toggleSearch} active={searchOpen}>
          <Search size={19} />
        </HeaderBtn>
        {convInfo !== undefined && (
          <HeaderBtn label={muted ? "لغو بی‌صدا" : "بی‌صدا کردن"} onClick={toggleMute} active={muted} tone={muted}>
            {muted ? <BellOff size={18} /> : <Bell size={18} />}
          </HeaderBtn>
        )}
        {isGroup ? (
          <>
            <button
              onClick={onCallAudio}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sage-600 text-white shadow-md shadow-black/30 transition hover:bg-sage-500 active:scale-95"
              aria-label="تماس صوتی گروهی"
              title="تماس صوتی گروهی"
            >
              <Phone size={17} />
            </button>
            <button
              onClick={onCallVideo}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ember-400 text-cocoa shadow-md shadow-black/30 ring-1 ring-ember-300/40 transition hover:bg-ember-300 active:scale-95"
              aria-label="تماس تصویری گروهی"
              title="تماس تصویری گروهی"
            >
              <Video size={17} />
            </button>
          </>
        ) : (
          <button
            onClick={onCallVideo}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ember-400 text-cocoa shadow-md shadow-black/30 ring-1 ring-ember-300/40 transition hover:bg-ember-300 active:scale-95"
            aria-label="تماس تصویری"
            title="تماس تصویری"
          >
            <Video size={17} />
          </button>
        )}
      </div>

      {/* ================= messages ================= */}
      <div className="relative min-h-0 flex-1">
        {anchored && (
          <div className="absolute inset-x-0 top-0 z-20 flex justify-center px-4 py-1.5">
            <button
              onClick={backToLatest}
              className="animate-rise flex items-center gap-1.5 rounded-full border border-ember-300/30 bg-dusk-100/95 px-3.5 py-1.5 text-[11px] font-bold text-ember-200 shadow-lg shadow-black/40 backdrop-blur transition hover:bg-dusk-200 active:scale-95"
            >
              <CornerUpLeft size={13} />
              نمایش اطراف پیام — بازگشت به جدیدترین‌ها
            </button>
          </div>
        )}

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="scrollbar-thin h-full space-y-2 overflow-y-auto px-3 pb-4 pt-4"
        >
          {/* empty states */}
          {!anchored && latest.length === 0 && curPending.length === 0 && (
            <div className="py-14 text-center">
              <div className="mx-auto grid h-20 w-20 place-items-center rounded-[32px]" style={{ backgroundColor: color + "22", color }}>
                <Pencil size={30} />
              </div>
              <p className="mt-4 font-extrabold text-dusk-950">سلام!</p>
              <p className="mt-1 text-sm text-dusk-600">
                {isGroup ? (
                  <>همهٔ اعضای گروه اینجا با هم گفتگو می‌کنند؛ عکس و پیام صوتی هم بفرستید. تماس گروهی صوتی و تصویری هم دارد.</>
                ) : (
                  <>
                    با {name} پیام بده، عکس بفرست یا با <Phone size={12} className="inline" style={{ marginBottom: -2 }} /> تماس بگیر.
                  </>
                )}
              </p>
            </div>
          )}
          {anchored && (!anchoredRows || anchoredRows.length === 0) && (
            <div className="flex justify-center py-10">
              <span className="animate-pulse rounded-full bg-dusk-200/80 px-4 py-1.5 text-xs font-bold text-dusk-600">
                در حال آوردن پیام‌ها…
              </span>
            </div>
          )}

          <div className="space-y-1">
            {rows.map((m, idx) => {
              const prev = idx > 0 ? rows[idx - 1] : null;
              const showDay = !anchored && (!prev || dayKey(m.createdAt) !== dayKey(prev.createdAt));
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
                  <div
                    data-mid={m._id}
                    className={`rounded-2xl transition-shadow ${highlightId === m._id ? "animate-flash" : ""}`}
                  >
                    <Bubble
                      msg={m}
                      meColor={meColor}
                      meName={meName}
                      menu={menu}
                      setMenu={setMenu}
                      isGroup={isGroup}
                      onReact={(emoji) => {
                        setMenu(null);
                        void react({ messageId: m._id, emoji, token }).catch(() => {});
                      }}
                      onReply={() => handleReply(m)}
                      onEdit={() => {
                        if (m.isMine && !m.deletedAt && m.kind === "text") {
                          setReplying(null);
                          setEditing(m._id);
                          setDraft(m.body);
                        }
                        setMenu(null);
                      }}
                      onDelete={() => {
                        if (m.isMine) delMut({ messageId: m._id, token });
                        setMenu(null);
                      }}
                      onJump={() => {
                        if (m.replyToId) jumpTo(m.replyToId);
                      }}
                      onOpenImage={(img) => setViewing(img)}
                    />
                  </div>
                </Fragment>
              );
            })}
            {!anchored &&
              curPending.map((p) => <PendingBubble key={p.clientMsgId} body={p.body} />)}
          </div>
          <div ref={bottomRef} className="h-px" />
        </div>

        {showJump && !anchored && (
          <button
            onClick={scrollToBottom}
            aria-label="رفتن به آخرین پیام"
            className="absolute bottom-5 left-4 z-10 grid h-11 w-11 place-items-center rounded-full border border-ember-300/30 bg-dusk-100/95 text-ember-300 shadow-xl shadow-black/50 backdrop-blur transition hover:bg-dusk-200 active:scale-90"
          >
            <ArrowDown size={18} />
          </button>
        )}
      </div>

      {/* ================= composer ================= */}
      <div className="safe-area relative z-20 flex flex-col gap-1.5 border-t border-dusk-300/50 bg-dusk-100/90 px-3 pb-3 pt-2.5 backdrop-blur">
        {errMsg && (
          <div className="animate-rise flex items-center gap-2 rounded-xl bg-rose-500/15 px-3 py-2 text-xs font-bold text-rose-300 ring-1 ring-rose-400/25">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-rose-500 text-[10px] font-black text-white">!</span>
            <span className="min-w-0 flex-1">{errMsg}</span>
            <button onClick={() => setErrMsg(null)} className="font-black text-rose-400/80 transition hover:text-rose-300" aria-label="بستن">
              ✕
            </button>
          </div>
        )}
        {voiceError && (
          <div className="animate-rise flex items-center gap-2 rounded-xl bg-ember-400/12 px-3 py-2 text-xs font-bold text-ember-200 ring-1 ring-ember-400/25">
            <Mic size={13} /> {voiceError}
          </div>
        )}
        {replying && (
          <div className="mb-0.5 flex items-center gap-2 overflow-hidden rounded-xl bg-ember-400/12 px-3 py-2 ring-1 ring-ember-400/25">
            <span className="w-1 shrink-0 self-stretch rounded-full" style={{ backgroundColor: replying.senderColor }} />
            <button
              type="button"
              onClick={() => jumpTo(replying.id)}
              className="min-w-0 flex-1 cursor-pointer text-start"
              title="رفتن به پیام اصلی"
            >
              <span className="block truncate text-[11px] font-black text-ember-100">
                پاسخ به {replying.senderName}
              </span>
              <span className="block truncate text-xs text-ember-200/80">
                {replying.deleted
                  ? "پیام حذف شد"
                  : replying.kind === "image"
                    ? "📷 عکس"
                    : replying.kind === "voice"
                      ? "🎤 پیام صوتی"
                      : replying.body}
              </span>
            </button>
            <button
              onClick={() => setReplying(null)}
              aria-label="لغو پاسخ"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-ember-300/80 transition hover:bg-ember-400/15 active:scale-90"
            >
              <X size={14} />
            </button>
          </div>
        )}
        {editing && (
          <div className="mb-0.5 flex items-center gap-2 rounded-xl bg-ember-400/12 px-3 py-2 text-sm text-ember-200 ring-1 ring-ember-400/25">
            <Pencil size={15} /> ویرایش پیام
            <button
              onClick={() => {
                setEditing(null);
                setDraft("");
              }}
              className="font-bold"
              aria-label="لغو ویرایش"
            >
              ✕
            </button>
            <span className="ml-auto truncate text-xs text-ember-300/80">{draft || "…"}</span>
          </div>
        )}
        {curPending.length > 0 && (
          <div className="animate-rise flex items-center gap-2 rounded-xl bg-ember-400/12 px-3 py-2 text-xs font-bold text-ember-200 ring-1 ring-ember-400/25">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ember-400 text-[10px] font-black text-cocoa">
              {fa(curPending.length)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {curPending.length === 1 ? "پیام در حال ارسال است — خودکار دوباره تلاش می‌شود" : "پیام‌ها در حال ارسال‌اند — خودکار دوباره تلاش می‌شود"}
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

        {/* photo preview row */}
        {photoPending && (
          <div className="animate-rise flex items-end gap-2">
            <div className="relative shrink-0 overflow-hidden rounded-xl ring-1 ring-ember-300/40">
              <img src={photoPending.url} alt="" className="h-12 w-12 object-cover" />
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              placeholder="توضیح عکس (اختیاری)…"
              className="min-h-[44px] max-h-20 flex-1 resize-none rounded-2xl border border-dusk-300/60 bg-dusk-50/80 px-4 py-2.5 text-[15px] text-dusk-950 caret-ember-300 shadow-sm outline-none placeholder:text-dusk-600 focus:border-ember-400/70 focus:ring-2 focus:ring-ember-400/30"
            />
            <button
              type="button"
              onClick={cancelPhoto}
              disabled={mediaBusy}
              aria-label="لغو عکس"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-dusk-600 transition hover:bg-dusk-200/80 active:scale-90 disabled:opacity-50"
            >
              <X size={18} />
            </button>
            <button
              type="button"
              onClick={sendPhoto}
              disabled={mediaBusy}
              aria-label="ارسال عکس"
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-ember-300 to-ember-500 text-cocoa shadow-lg shadow-black/40 transition active:scale-90 ${
                mediaBusy ? "cursor-wait opacity-70" : "hover:from-ember-400 hover:to-ember-600"
              }`}
            >
              {mediaBusy ? <RefreshCw size={17} className="animate-spin" /> : <Send size={16} style={{ transform: "scaleX(-1)" }} />}
            </button>
          </div>
        )}

        {!photoPending && voicePhase === "idle" && (
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="فرستادن عکس"
              title="عکس"
              className="grid h-12 w-11 shrink-0 place-items-center rounded-full text-dusk-600 transition hover:bg-dusk-200/80 active:scale-90"
            >
              <ImagePlus size={22} />
            </button>
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
              placeholder={editing ? "ویرایش متن…" : replying ? "پاسخ به " + replying.senderName + "…" : "پیام خود را بنویسید…"}
              className="min-h-[48px] max-h-32 flex-1 resize-none rounded-2xl border border-dusk-300/60 bg-dusk-50/80 px-4 py-3 text-[15px] text-dusk-950 caret-ember-300 shadow-sm outline-none placeholder:text-dusk-600 focus:border-ember-400/70 focus:ring-2 focus:ring-ember-400/30"
            />
            {VOICE_SUPPORTED && (
              <button
                type="button"
                onClick={startVoice}
                aria-label="ضبط پیام صوتی"
                title="پیام صوتی"
                className="grid h-12 w-11 shrink-0 place-items-center rounded-full text-dusk-600 transition hover:bg-dusk-200/80 active:scale-90"
              >
                <Mic size={22} />
              </button>
            )}
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
        )}
        {!photoPending && voicePhase !== "idle" && (
          <div className="animate-rise flex items-center gap-3 rounded-2xl border border-rose-400/25 bg-rose-500/10 px-3 py-2">
            <span className="relative flex h-3 w-3 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-70" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-bold text-dusk-900">
              {voicePhase === "sending" ? (
                "در حال ارسال…"
              ) : (
                <>
                  در حال ضبط…
                  <span className="mx-1 font-black tabular-nums text-rose-300" dir="ltr">
                    {formatDurationMs(voiceMs)}
                  </span>
                </>
              )}
            </span>
            {voicePhase === "recording" && (
              <>
                <button
                  type="button"
                  onClick={cancelVoice}
                  aria-label="لغو ضبط"
                  title="لغو"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-dusk-200 text-dusk-700 transition hover:bg-dusk-300/80 active:scale-90"
                >
                  <Trash2 size={17} />
                </button>
                <button
                  type="button"
                  onClick={() => void finishVoice()}
                  aria-label="ارسال پیام صوتی"
                  title="ارسال"
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-sage-600 text-white shadow-md shadow-black/30 transition hover:bg-sage-500 active:scale-90"
                >
                  <Check size={18} strokeWidth={3} />
                </button>
              </>
            )}
            {voicePhase === "sending" && (
              <RefreshCw size={18} className="animate-spin text-ember-300" aria-label="در حال ارسال" />
            )}
          </div>
        )}
      </div>

      {/* ================= search overlay ================= */}
      {searchOpen && (
        <div className="absolute inset-x-0 bottom-0 top-[57px] z-30 flex flex-col bg-dusk-100/98 backdrop-blur-xl">
          <div className="flex items-center gap-2 px-3 py-2.5">
            <button
              onClick={toggleSearch}
              aria-label="بستن جستجو"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-dusk-600 transition hover:bg-dusk-200/80 active:scale-90"
            >
              <ArrowRight size={18} />
            </button>
            <div className="relative min-w-0 flex-1">
              <Search size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-dusk-600" />
              <input
                autoFocus
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
                placeholder="جستجو در گفتگو…"
                className="w-full rounded-full border border-dusk-300/50 bg-dusk-50/90 py-2.5 pl-9 pr-9 text-[15px] text-dusk-950 caret-ember-300 outline-none placeholder:text-dusk-600 focus:border-ember-400/60 focus:ring-2 focus:ring-ember-400/25"
                style={{ paddingRight: "2.25rem" }}
              />
              {searchQ && (
                <button
                  onClick={() => setSearchQ("")}
                  aria-label="پاک کردن"
                  className="absolute left-3 top-1/2 -translate-y-1/2 grid h-5 w-5 place-items-center rounded-full text-dusk-600 transition hover:bg-dusk-200"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
          <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-6">
            {searchQ.trim().length === 0 ? (
              <p className="px-4 py-10 text-center text-sm leading-6 text-dusk-600">
                هر متنی را بنویس تا پیام‌های این گفتگو را پیدا کنم؛ عکس‌ها با توضیحشان هم پیدا می‌شوند.
              </p>
            ) : searchResults === undefined && !searchUnavailable ? (
              <p className="animate-pulse px-4 py-10 text-center text-sm text-dusk-600">در حال جستجو…</p>
            ) : searchResults === undefined || searchResults.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm leading-6 text-dusk-600">
                {searchUnavailable
                  ? "جستجو در این نسخه در دسترس نیست — بعداً دوباره امتحان کن."
                  : `چیزی برای «${searchQ.trim()}» پیدا نشد — تا ۳۰۰ پیامِ آخر جستجو می‌شود.`}
              </p>
            ) : (
              <div>
                <p className="px-3 pb-1.5 text-[11px] font-bold text-dusk-600">
                  {fa(searchResults.length)} پیام پیدا شد
                </p>
                {searchResults.map((hit) => (
                  <button
                    key={hit._id}
                    onClick={() => openSearchHit(hit)}
                    className="flex w-full items-start gap-3 rounded-2xl px-3 py-2.5 text-start transition hover:bg-dusk-200/70 active:bg-dusk-200"
                  >
                    <Avatar name={hit.senderName} color={hit.senderColor} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-extrabold text-dusk-900">{hit.senderName}</span>
                        <span className="shrink-0 text-[10px] text-dusk-600">{clock(hit.createdAt)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[13px] leading-6 text-dusk-700">
                        {hitKindLabel(hit)}
                        {hit.body}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          void pickImage(f);
          e.target.value = "";
        }}
      />

      {/* lightbox */}
      {viewing && (
        <Lightbox msg={viewing} senderName={senderOf(viewing.senderId).displayName} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

/* Small round ghost button used in the chat header. */
function HeaderBtn({
  children,
  onClick,
  label,
  active = false,
  tone = false,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  active?: boolean;
  tone?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`grid h-10 w-10 shrink-0 place-items-center rounded-full transition active:scale-90 ${
        active
          ? tone
            ? "bg-ember-400/25 text-ember-200 ring-1 ring-ember-300/40"
            : "bg-sage-600 text-white"
          : "text-dusk-600 hover:bg-dusk-200/80"
      }`}
    >
      {children}
    </button>
  );
}

/* ================================================================== */

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
  if (s.getFullYear() === d.getFullYear() && s.getMonth() === d.getMonth() && s.getDate() === d.getDate()) {
    return "دیروز";
  }
  return formatDay(ts);
}

function PendingBubble({ body }: { body: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[82%]">
        <div
          className="rounded-[20px] rounded-br-md border border-dashed border-ember-400/60 px-4 py-2.5 text-[15px] leading-7 text-dusk-900 shadow-sm"
          style={{ background: "linear-gradient(135deg, #3a250f, #1d1208)" }}
        >
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
  meName,
  menu,
  setMenu,
  isGroup,
  onReact,
  onReply,
  onEdit,
  onDelete,
  onJump,
  onOpenImage,
}: {
  msg: ChatMessage;
  meColor: string;
  meName: string;
  menu: Id<"messages"> | null;
  setMenu: (id: Id<"messages"> | null) => void;
  isGroup: boolean;
  onReact: (emoji: string) => void;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onJump: () => void;
  onOpenImage: (m: ChatMessage) => void;
}) {
  const mine = msg.isMine;
  const isMenu = menu === msg._id;
  const kind = msg.kind ?? "text";
  const deleted = !!msg.deletedAt;
  void meName;

  const bubbleStyle = mine
    ? { background: `linear-gradient(135deg, ${meColor}, ${darken(meColor)})` }
    : undefined;

  const chip = msg.reply ? (
    <ReplyChip
      reply={{
        id: msg.replyToId ?? ("" as Id<"messages">),
        senderName: msg.reply.senderName,
        senderColor: msg.reply.senderColor,
        body: msg.reply.body,
        deleted: msg.reply.deleted,
        kind: msg.reply.kind,
        isMine: false,
      }}
      mine={mine}
      onClick={onJump}
    />
  ) : null;

  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      {isMenu && (
        <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setMenu(null); }} aria-hidden="true" />
      )}
      <div className={`flex max-w-[84%] flex-col ${mine ? "items-end" : "items-start"}`}>
        <div
          onClick={(e) => {
            e.stopPropagation();
            setMenu(isMenu ? null : msg._id);
          }}
          className={`relative select-none rounded-[20px] shadow-sm transition active:scale-[0.99] ${
            mine ? "rounded-br-md text-white shadow-md shadow-dusk-900/15" : "rounded-bl-md bg-dusk-100 text-dusk-950 shadow-[0_1px_3px_rgba(0,0,0,0.35)] ring-1 ring-dusk-300/50"
          } ${kind === "image" ? "overflow-hidden p-1" : "px-4 py-2.5"} ${deleted ? "opacity-75" : ""}`}
          style={mine ? bubbleStyle : undefined}
        >
          {chip}
          {deleted ? (
            <span className={`italic opacity-90 ${kind === "image" ? "px-3 py-2" : ""}`}>
              {mine ? "این پیام را حذف کردی" : "این پیام حذف شد"}
            </span>
          ) : kind === "image" ? (
            <>
              <ImageBubble msg={msg} onOpen={onOpenImage} />
              {msg.body && (
                <p className="whitespace-pre-wrap break-words px-2.5 pb-0.5 pt-2 text-[15px] leading-7">{msg.body}</p>
              )}
            </>
          ) : kind === "voice" ? (
            msg.url ? (
              <VoiceNoteBubble url={msg.url} durationMs={msg.durationMs} mine={mine} />
            ) : (
              <span className="flex items-center gap-2 py-1 text-sm opacity-80">
                <Clock size={13} /> در حال بارگذاری…
              </span>
            )
          ) : (
            <p className="whitespace-pre-wrap break-words">{msg.body}</p>
          )}

          <div className={`mt-0.5 flex items-center gap-1 text-[10px] ${kind === "image" ? "px-2.5 pb-1.5" : ""} ${mine ? "text-white/75" : "text-dusk-600"}`}>
            {msg.editedAt && !deleted && <span>ویرایش شد</span>}
            <span>{clock(msg.createdAt)}</span>
            {mine && !isGroup && !deleted && (
              <span className="flex items-center text-ember-300" title={msg.read ? "خوانده شد" : "ارسال شد"}>
                {msg.read && <Check size={11} strokeWidth={3} />}
                <Check size={11} strokeWidth={3} className={msg.read ? "-ml-[6px]" : ""} />
              </span>
            )}
          </div>

          {!deleted && Object.keys(msg.reactions).length > 0 && (
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

          {isMenu && !deleted && (
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
              <button
                onClick={onReply}
                className="grid h-9 w-9 place-items-center rounded-xl text-sage-300 transition hover:bg-dusk-200/80"
                aria-label="پاسخ"
                title="پاسخ"
              >
                <CornerUpLeft size={16} />
              </button>
              {mine && kind === "text" && (
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
