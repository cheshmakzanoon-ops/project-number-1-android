import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { Bell, BellRing, ExternalLink, X } from "lucide-react";
import { api } from "./convex/_generated/api";
import { IS_EMBEDDED, openAppTopLevel } from "./lib/browser";
import { getDeviceToken } from "./lib/token";
import { Signup } from "./components/Signup";
import { Lobby } from "./components/Lobby";
import { Chat } from "./components/Chat";
import { CallOverlay } from "./components/CallOverlay";
import { InstallBanner } from "./components/InstallBanner";
import { useCallkit, type CallKind, type CallPeer } from "./lib/useCallkit";
import { usePush } from "./lib/usePush";
import { Avatar } from "./components/Avatar";
import { useSoftQuery } from "./lib/softQuery";
import {
  clearCachedIdentity,
  loadCachedIdentity,
  saveCachedIdentity,
  type CachedIdentity,
} from "./lib/identityCache";
import type { ConvPeer, DirectoryEntry } from "./lib/types";
import type { Id } from "./convex/_generated/dataModel";

interface ActiveChat {
  cid: Id<"conversations">;
  kind: "dm" | "group";
  name: string;
  color: string;
  /** Everyone else in this conversation (for group calls / chat labels). */
  peers: ConvPeer[];
}

/** The lobby's three tabs: chats / status rings / recent calls. */
type LobbyTab = "chats" | "status" | "calls";

export function App() {
  const token = useMemo(() => getDeviceToken(), []);
  // Soft: a backend that answers with an error (mid-deploy, function missing
  // on an older deployment, transient server error) must never throw through
  // `useQuery` and unmount the app onto the crash panel. It is treated like
  // "backend unreachable": the friendly retry screen handles it, and the app
  // springs back to life the moment the same query starts answering.
  const { data: queryMeData, unavailable: meUnavailable } = useSoftQuery(
    api.users.me,
    token ? { token } : "skip",
  ) as unknown as {
    data: (CachedIdentity & { createdAt: number; lastSeenAt: number }) | null | undefined;
    unavailable: boolean;
  };
  const queryMe = queryMeData;
  // Every returning device already knows who it is (their name was saved on
  // this phone) — paint the app immediately from that cache while the `me`
  // query refreshes in the background, so repeat visits never wait on a
  // network round-trip before showing anything.
  const [cachedMe, setCachedMe] = useState<CachedIdentity | null>(() => loadCachedIdentity());
  const me = queryMe ?? cachedMe;
  const register = useMutation(api.users.register);
  const startDM = useMutation(api.conversations.startDM);
  const startGroup = useMutation(api.conversations.startGroup);
  const heartbeat = useMutation(api.users.heartbeat);

  const [active, setActive] = useState<ActiveChat | null>(null);
  const [busy, setBusy] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [connTrouble, setConnTrouble] = useState(false);
  const [tab, setTab] = useState<LobbyTab>("chats");
  // Embedded-preview (dev pane) notice: browsers withhold camera/mic/screen
  // capture from iframes, so media features must be tried in a real tab.
  const [embHintDismissed, setEmbHintDismissed] = useState(false);
  const [embHintNote, setEmbHintNote] = useState(false);
  // "زنگ تماس" (notification) banner — hidden for this session after dismiss.
  const [notifDismissed, setNotifDismissed] = useState(false);
  const callkit = useCallkit(token);
  const push = usePush(token);
  const { session } = callkit;

  // Keep the on-device identity in step with the server: cache it once the
  // query answers, drop it when the backend says this device is unknown (e.g.
  // after a backend reset) so we don't paint a ghost identity forever.
  useEffect(() => {
    if (queryMe === null) {
      clearCachedIdentity();
      setCachedMe(null);
    } else if (queryMe) {
      saveCachedIdentity(queryMe);
    }
  }, [queryMe]);

  // If the backend hasn't connected after a while, show a clear message rather
  // than a silent endless spinner (or a stale cached shell).
  useEffect(() => {
    if (queryMe !== undefined) {
      setConnTrouble(false);
      return;
    }
    const t = window.setTimeout(() => setConnTrouble(true), 9000);
    return () => window.clearTimeout(t);
  }, [queryMe]);

  useEffect(() => {
    // leaving the overlay (call ended) also clears minimized state
    if (!session) setMinimized(false);
  }, [session]);

  // Presence heartbeat. Browsers throttle background tabs, so also beat the
  // moment the tab becomes visible again or the network returns.
  useEffect(() => {
    if (!me) return;
    const beat = () => heartbeat({ token });
    beat();
    const id = window.setInterval(beat, 20_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") beat();
    };
    const onOnline = () => beat();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [me, token, heartbeat]);

  const handleRegister = useCallback(
    async (name: string) => {
      setBusy(true);
      setAuthErr(null);
      try {
        await register({ token, displayName: name });
      } catch {
        setAuthErr("نتونستیم به سرور وصل شویم — اتصال اینترنت را بررسی کن و دوباره تلاش کن.");
      } finally {
        setBusy(false);
      }
    },
    [register, token],
  );

  // ---- Opening conversations ---------------------------------------------

  const openConv = useCallback(
    (cid: Id<"conversations">, kind: "dm" | "group", name: string, color: string, peers: ConvPeer[]) => {
      setActive({ cid, kind, name, color, peers });
    },
    [],
  );

  const openChatWith = useCallback(
    async (c: DirectoryEntry) => {
      try {
        const cid = await startDM({ token, otherId: c._id });
        openConv(
          cid,
          "dm",
          c.displayName,
          c.themeColor,
          [{ userId: c._id, displayName: c.displayName, themeColor: c.themeColor }],
        );
      } catch {
        /* noop */
      }
    },
    [openConv, startDM, token],
  );

  const callContact = useCallback(
    async (c: DirectoryEntry, kind: CallKind) => {
      try {
        const cid = await startDM({ token, otherId: c._id });
        const peers: CallPeer[] = [
          { userId: c._id, displayName: c.displayName, themeColor: c.themeColor, joined: false },
        ];
        await callkit.startCall(cid, kind, peers);
      } catch {
        /* noop */
      }
    },
    [callkit, startDM, token],
  );

  const callConv = useCallback(
    (convId: Id<"conversations">, peers: ConvPeer[], kind: CallKind) => {
      const callPeers: CallPeer[] = peers.map((p) => ({ ...p, joined: false }));
      void callkit.startCall(convId, kind, callPeers);
    },
    [callkit],
  );

  const callActiveChat = useCallback(() => {
    if (!active) return;
    void callConv(active.cid, active.peers, "video");
  }, [active, callConv]);

  const callActiveChatAudio = useCallback(() => {
    if (!active) return;
    void callConv(active.cid, active.peers, "audio");
  }, [active, callConv]);

  const createGroup = useCallback(
    async (members: ConvPeer[]) => {
      if (members.length < 2) return;
      try {
        const cid = await startGroup({ token, memberIds: members.map((m) => m.userId) });
        const name = members.map((m) => m.displayName).join("، ");
        const color = members[0]?.themeColor ?? "#8a6340";
        openConv(cid, "group", name, color, members);
      } catch {
        /* noop */
      }
    },
    [openConv, startGroup, token],
  );

  // ---- Render states ----
  const connTroubleScreen = (showPanel: boolean) => (
    <div className="grid h-full place-items-center bg-dusk-50">
      <div className="flex flex-col items-center gap-4">
        {!showPanel && <div className="h-10 w-10 animate-pulse rounded-full bg-ember-400/50" />}
        {showPanel && (
          <div className="animate-rise mx-6 max-w-xs rounded-3xl border border-ember-300/25 bg-dusk-100/95 p-6 text-center shadow-2xl shadow-black/40 backdrop-blur">
            <p className="text-lg font-extrabold text-dusk-950">اتصال برقرار نشد</p>
            <p className="mt-2 text-sm leading-6 text-dusk-600">
              انگار به سرور وصل نمی‌شویم. اتصال اینترنت را بررسی کن و دوباره تلاش کن.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-5 rounded-full bg-ember-400 px-7 py-3 font-bold text-cocoa shadow-lg shadow-black/30 transition hover:bg-ember-300 active:scale-95"
            >
              تلاش دوباره
            </button>
          </div>
        )}
      </div>
    </div>
  );

  // No connection and no (refreshed) identity: surface the retry panel. An
  // immediate query error counts as unreachable too — no 9s wait on a dead/
  // mismatched backend.
  if ((connTrouble && queryMe === undefined) || meUnavailable) return connTroubleScreen(true);
  // First visit on this device: nothing cached yet, wait briefly.
  if (queryMe === undefined && cachedMe === null) return connTroubleScreen(false);
  // The backend doesn't know this device token (fresh install / reset): sign up.
  if (queryMe === null) {
    return <Signup onRegister={handleRegister} busy={busy} error={authErr} />;
  }

  const identity = me as CachedIdentity;

  // Notification permission banner: shown in production (push needs the real
  // backend) until the user grants permission, so an installed app always has
  // a working ring even when the app is closed. The request itself happens
  // inside the button tap — iOS Safari only shows the permission prompt from
  // a user gesture.
  const showNotifBanner =
    import.meta.env.PROD &&
    !notifDismissed &&
    me &&
    "Notification" in window &&
    push.notifPerm === "default";

  // Minimized call pill title/avatar.
  let pillName = "";
  let pillColor = "#8a6340";
  if (session) {
    const peers = session.peers ?? [];
    const joined = peers.filter((p) => p.joined);
    const target = joined[0] ?? (session.initiatedByMe ? peers[0] : null);
    if (session.phase === "incoming" && !session.initiatedByMe) {
      pillName = session.callerName;
      pillColor = session.callerColor;
    } else if (target) {
      pillName = target.displayName;
      pillColor = target.themeColor;
    } else if (peers.length > 0) {
      pillName = peers[0].displayName;
      pillColor = peers[0].themeColor;
    } else {
      pillName = "تماس";
    }
  }

  return (
    <div
      className="relative mx-auto flex h-full max-w-md flex-col shadow-xl shadow-black/50"
      style={{ background: "var(--color-dusk-50)" }}
    >
      <InstallBanner />
      {/* Only inside an embedded frame (the dev preview) — a top-level tab or
          an installed app never sees this. Camera/mic/screen capture need a
          real tab, so offer to open one before the user taps call. */}
      {IS_EMBEDDED && !embHintDismissed && (
        <div
          role="status"
          className="animate-rise relative z-30 mx-3 mt-2 flex items-center gap-3 rounded-2xl border border-ember-400/25 bg-gradient-to-l from-dusk-100/95 via-[#2a1a0a]/95 to-dusk-100/95 px-3 py-2.5 shadow-lg shadow-black/40 backdrop-blur"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ember-400/90 text-cocoa">
            <ExternalLink size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-extrabold text-dusk-950">تماس‌ها را در تب جدید تست کن</p>
            <p className="mt-0.5 text-[11px] leading-5 text-dusk-600">
              پیش‌نمایش دوربین، میکروفون و اشتراک صفحه را قفل می‌کند؛ اپ را مستقیم باز کن.
              {embHintNote &&
                " اگر تب باز نشد، دکمهٔ «باز کردن در تب جدید» را بالای پیش‌نمایش بزن."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (openAppTopLevel()) setEmbHintDismissed(true);
              else setEmbHintNote(true);
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-ember-400 px-3.5 py-2 text-xs font-extrabold text-cocoa shadow-md shadow-black/30 transition hover:bg-ember-300 active:scale-95"
          >
            <ExternalLink size={14} strokeWidth={2.5} />
            باز کردن
          </button>
          <button
            type="button"
            onClick={() => setEmbHintDismissed(true)}
            aria-label="بعداً"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-dusk-500 transition hover:bg-dusk-300/40 hover:text-dusk-700 active:scale-90"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {showNotifBanner && (
        <div
          role="status"
          className="animate-rise relative z-30 mx-3 mt-2 flex items-center gap-3 rounded-2xl border border-sage-400/25 bg-gradient-to-l from-dusk-100/95 via-[#12231a]/95 to-dusk-100/95 px-3 py-2.5 shadow-lg shadow-black/40 backdrop-blur"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sage-600/90 text-white">
            <BellRing size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-extrabold text-dusk-950">زنگ تماس را روشن کن</p>
            <p className="mt-0.5 text-[11px] leading-5 text-dusk-600">
              اگر اپ بسته باشد هم با این اجازه، تماس‌ها زنگ می‌زند و لرزش دارد.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void push.enable();
            }}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-sage-600 px-3.5 py-2 text-xs font-extrabold text-white shadow-md shadow-sage-600/30 transition hover:bg-sage-500 active:scale-95"
          >
            <Bell size={14} strokeWidth={2.5} />
            روشن کن
          </button>
          <button
            type="button"
            onClick={() => setNotifDismissed(true)}
            aria-label="بعداً"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-dusk-500 transition hover:bg-dusk-300/40 hover:text-dusk-700 active:scale-90"
          >
            <X size={15} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {active ? (
          <Chat
            token={token}
            meColor={identity.themeColor}
            meName={identity.displayName}
            meId={identity._id}
            conversationId={active.cid}
            kind={active.kind}
            name={active.name}
            color={active.color}
            onBack={() => setActive(null)}
            onCallVideo={callActiveChat}
            onCallAudio={callActiveChatAudio}
          />
        ) : (
          <Lobby
            token={token}
            meId={identity._id}
            meName={identity.displayName}
            tab={tab}
            onTab={setTab}
            onOpen={(cid, kind, name, color, peers) =>
              openConv(cid as Id<"conversations">, kind, name, color, peers)
            }
            onCall={callConv}
            onMessageContact={openChatWith}
            onVideoContact={(c) => callContact(c, "video")}
            onAudioContact={(c) => callContact(c, "audio")}
            onGroupCreate={(members) => {
              void createGroup(members);
            }}
          />
        )}
      </div>

      {/* The overlay stays MOUNTED while minimized (invisible) so the call
          timer keeps ticking and the media/connection keep flowing. */}
      {session && <CallOverlay kit={callkit} onMinimize={() => setMinimized(true)} hidden={minimized} />}

      {session && minimized && (
        <button
          onClick={() => setMinimized(false)}
          className="fixed bottom-5 right-4 z-50 flex items-center gap-2 rounded-full bg-[#0e0803]/90 py-1.5 pl-4 pr-1.5 text-white shadow-2xl backdrop-blur transition active:scale-95"
        >
          <Avatar name={pillName} color={pillColor} size={38} />
          <span className="max-w-[110px] truncate text-sm font-bold">{pillName}</span>
          <span className="flex items-center gap-1.5 text-xs text-sage-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sage-400" />
            {session.phase === "active"
              ? session.kind === "video"
                ? "تماس تصویری"
                : "تماس صوتی"
              : session.joinOffer
                ? "در جریان است"
                : session.kind === "video"
                  ? "تماس تصویری"
                  : "تماس صوتی"}
          </span>
        </button>
      )}

      {callkit.error && !session && (
        <div className="safe-area fixed inset-x-0 top-0 z-[70] flex justify-center p-3">
          <div className="animate-rise flex max-w-sm items-center gap-2 rounded-2xl bg-rose-500/95 px-4 py-3 text-sm text-white shadow-2xl">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-rose-500 text-xs font-black">!</span>
            {callkit.error === "livekit_not_configured"
              ? "تماس هنوز در دسترس نیست — کلیدهای تماس (LiveKit) را تنظیم کن."
              : callkit.error === "already_in_call"
                ? "الان در یک تماس دیگری هستی. اول همان را تمام کن."
                : "برقراری تماس ممکن نشد. دوباره تلاش کن."}
          </div>
        </div>
      )}
    </div>
  );
}
