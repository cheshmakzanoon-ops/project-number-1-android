import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "./convex/_generated/api";
import { getDeviceToken } from "./lib/token";
import { Signup } from "./components/Signup";
import { Lobby } from "./components/Lobby";
import { Chat } from "./components/Chat";
import { CallOverlay } from "./components/CallOverlay";
import { useCallkit, type CallKind } from "./lib/useCallkit";
import { usePush } from "./lib/usePush";
import { Avatar } from "./components/Avatar";
import {
  clearCachedIdentity,
  loadCachedIdentity,
  saveCachedIdentity,
  type CachedIdentity,
} from "./lib/identityCache";
import type { Id } from "./convex/_generated/dataModel";
import type { DirectoryEntry } from "./lib/types";

interface ActiveChat {
  cid: Id<"conversations">;
  otherId: Id<"users">;
  name: string;
  color: string;
}

export function App() {
  const token = useMemo(() => getDeviceToken(), []);
  const queryMe = useQuery(api.users.me, token ? { token } : "skip") as unknown as
    | (CachedIdentity & { createdAt: number; lastSeenAt: number })
    | null
    | undefined;
  // Every returning device already knows who it is (their name was saved on
  // this phone) — paint the app immediately from that cache while the `me`
  // query refreshes in the background, so repeat visits never wait on a
  // network round-trip before showing anything.
  const [cachedMe, setCachedMe] = useState<CachedIdentity | null>(() => loadCachedIdentity());
  const me = queryMe ?? cachedMe;
  const register = useMutation(api.users.register);
  const startDM = useMutation(api.conversations.startDM);
  const heartbeat = useMutation(api.users.heartbeat);

  const [active, setActive] = useState<ActiveChat | null>(null);
  const [busy, setBusy] = useState(false);
  const [authErr, setAuthErr] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [connTrouble, setConnTrouble] = useState(false);
  const callkit = useCallkit(token);
  const push = usePush(token);
  const { session } = callkit;

  // Ask once for notification permission right after the user joins: without
  // it we cannot ring this phone when the app is closed and someone calls.
  const askedNotifRef = useRef(false);
  useEffect(() => {
    if (!me || askedNotifRef.current) return;
    if (push.notifPerm !== "granted") {
      askedNotifRef.current = true;
      void push.enable();
    }
  }, [me, push]);

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
  // than a silent endless spinner (or a stale cached shell), so a
  // dead/filtered connection is obvious and recoverable from.
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
  // moment the tab becomes visible again or the network returns — presence
  // should never lag behind what the app is actually doing.
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
        // The register mutation only fails on a dead connection (the request
        // never reached the server) — tell the user plainly instead of letting
        // the button silently do nothing.
        setAuthErr("نتونستیم به سرور وصل شویم — اتصال اینترنت را بررسی کن و دوباره تلاش کن.");
      } finally {
        setBusy(false);
      }
    },
    [register, token],
  );

  const openChatWith = useCallback(
    async (c: DirectoryEntry) => {
      try {
        const cid = await startDM({ token, otherId: c._id });
        setActive({ cid, otherId: c._id, name: c.displayName, color: c.themeColor });
      } catch {
        /* noop */
      }
    },
    [startDM, token],
  );

  const callContact = useCallback(
    async (c: DirectoryEntry, kind: CallKind) => {
      try {
        const cid = await startDM({ token, otherId: c._id });
        await callkit.startCall(cid, c._id, c.displayName, c.themeColor, kind);
      } catch {
        /* noop */
      }
    },
    [callkit, startDM, token],
  );

  const callConversation = useCallback(
    (convId: string, otherId: string, otherName: string, otherColor: string) => {
      void callkit.startCall(
        convId as Id<"conversations">,
        otherId as Id<"users">,
        otherName,
        otherColor,
        "video",
      );
    },
    [callkit],
  );

  const callActiveChat = useCallback(() => {
    if (!active) return;
    void callkit.startCall(active.cid, active.otherId, active.name, active.color, "video");
  }, [active, callkit]);

  // ---- Render states ----
  const connTroubleScreen = (showPanel: boolean) => (
    <div className="grid h-full place-items-center bg-dusk-50">
      <div className="flex flex-col items-center gap-4">
        {!showPanel && <div className="h-10 w-10 animate-pulse rounded-full bg-ember-400/50" />}
        {showPanel && (
          <div className="animate-rise mx-6 max-w-xs rounded-3xl border border-dusk-100 bg-white/90 p-6 text-center shadow-xl backdrop-blur">
            <p className="text-lg font-extrabold text-dusk-900">اتصال برقرار نشد</p>
            <p className="mt-2 text-sm leading-6 text-dusk-500">
              انگار به سرور وصل نمی‌شویم. اتصال اینترنت را بررسی کن و دوباره تلاش کن.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="mt-5 rounded-full bg-ember-500 px-7 py-3 font-bold text-white shadow-lg shadow-ember-500/30 transition hover:bg-ember-600 active:scale-95"
            >
              تلاش دوباره
            </button>
          </div>
        )}
      </div>
    </div>
  );

  // No connection and no (refreshed) identity: whatever the screen would show
  // is stale, so surface the retry panel instead of a silent skeleton.
  if (connTrouble && queryMe === undefined) return connTroubleScreen(true);
  // First visit on this device: nothing cached yet, so wait briefly for the
  // backend to say whether this token is known.
  if (queryMe === undefined && cachedMe === null) return connTroubleScreen(false);
  // The backend doesn't know this device token (fresh install / reset): sign up.
  if (queryMe === null) {
    return <Signup onRegister={handleRegister} busy={busy} error={authErr} />;
  }

  // Past the gates above this is guaranteed: either the query answered with a
  // user, or a cached identity stands in while the query refreshes.
  const identity = me as CachedIdentity;

  return (
    <div className="mx-auto h-full max-w-md shadow-xl shadow-dusk-200/40" style={{ background: "var(--color-dusk-50)" }}>
      {active ? (
        <Chat
          token={token}
          meColor={identity.themeColor}
          conversationId={active.cid}
          name={active.name}
          color={active.color}
          onBack={() => setActive(null)}
          onCall={callActiveChat}
        />
      ) : (
        <Lobby
          token={token}
          meId={identity._id}
          meName={identity.displayName}
          onOpen={(cid, name, color, otherId) =>
            setActive({
              cid: cid as Id<"conversations">,
              otherId: otherId as Id<"users">,
              name,
              color,
            })
          }
          onCall={callConversation}
          onMessageContact={openChatWith}
          onVideoContact={(c) => callContact(c, "video")}
          onAudioContact={(c) => callContact(c, "audio")}
        />
      )}

      {/* The overlay stays MOUNTED while minimized (invisible) so the call
          timer keeps ticking and the media/connection keep flowing — unmount-
          and-remount used to reset the elapsed timer on every restore. */}
      {session && <CallOverlay kit={callkit} onMinimize={() => setMinimized(true)} hidden={minimized} />}

      {session && minimized && (
        <button
          onClick={() => setMinimized(false)}
          className="fixed bottom-5 right-4 z-50 flex items-center gap-2 rounded-full bg-dusk-950/90 py-1.5 pl-4 pr-1.5 text-white shadow-2xl backdrop-blur transition active:scale-95"
        >
          <Avatar name={session.otherName} color={session.otherColor} size={38} />
          <span className="max-w-[90px] truncate text-sm font-bold">{session.otherName}</span>
          <span className="flex items-center gap-1.5 text-xs text-sage-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sage-400" />
            {session.kind === "video" ? "تماس تصویری" : "تماس صوتی"}
          </span>
        </button>
      )}

      {callkit.error && !session && (
        <div className="safe-area fixed inset-x-0 top-0 z-[70] flex justify-center p-3">
          <div className="animate-rise flex max-w-sm items-center gap-2 rounded-2xl bg-dusk-900 px-4 py-3 text-sm text-white shadow-2xl">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-rose-500 text-xs font-black">!</span>
            {callkit.error === "livekit_not_configured"
              ? "تماس هنوز در دسترس نیست — کلیدهای تماس (LiveKit) را تنظیم کن."
              : "برقراری تماس ممکن نشد. دوباره تلاش کن."}
          </div>
        </div>
      )}
    </div>
  );
}