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
import { clock } from "./lib/format";
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
  const me = useQuery(api.users.me, token ? { token } : "skip");
  const register = useMutation(api.users.register);
  const startDM = useMutation(api.conversations.startDM);
  const heartbeat = useMutation(api.users.heartbeat);

  const [active, setActive] = useState<ActiveChat | null>(null);
  const [busy, setBusy] = useState(false);
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

  // If the backend hasn't connected after a while, show a clear message rather
  // than a silent endless spinner, so a dead/filtered connection is obvious and
  // recoverable from.
  useEffect(() => {
    if (me !== undefined) {
      setConnTrouble(false);
      return;
    }
    const t = window.setTimeout(() => setConnTrouble(true), 9000);
    return () => window.clearTimeout(t);
  }, [me]);

  useEffect(() => {
    // leaving the overlay (call ended) also clears minimized state
    if (!session) setMinimized(false);
  }, [session]);

  // Presence heartbeat
  useEffect(() => {
    if (!me) return;
    const beat = () => heartbeat({ token });
    beat();
    const id = window.setInterval(beat, 20_000);
    return () => window.clearInterval(id);
  }, [me, token, heartbeat]);

  const handleRegister = useCallback(
    async (name: string) => {
      setBusy(true);
      try {
        await register({ token, displayName: name });
      } catch {
        /* covered by UI feedback */
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
  if (me === undefined) {
    return (
      <div className="grid h-full place-items-center bg-dusk-50">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-pulse rounded-full bg-ember-400/50" />
          {connTrouble && (
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
  }

  if (me === null) {
    return <Signup onRegister={handleRegister} busy={busy} />;
  }

  return (
    <div className="mx-auto h-full max-w-md shadow-xl shadow-dusk-200/40" style={{ background: "var(--color-dusk-50)" }}>
      {active ? (
        <Chat
          token={token}
          meColor={me.themeColor}
          conversationId={active.cid}
          name={active.name}
          color={active.color}
          onBack={() => setActive(null)}
          onCall={callActiveChat}
        />
      ) : (
        <Lobby
          token={token}
          meId={me._id}
          meName={me.displayName}
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

      {session && !minimized && <CallOverlay kit={callkit} onMinimize={() => setMinimized(true)} />}

      {session && minimized && (
        <button
          onClick={() => setMinimized(false)}
          className="fixed bottom-5 right-4 z-50 flex items-center gap-2 rounded-full bg-dusk-950/90 py-1.5 pl-4 pr-1.5 text-white shadow-2xl backdrop-blur transition active:scale-95"
        >
          <Avatar name={session.otherName} color={session.otherColor} size={38} />
          <span className="max-w-[90px] truncate text-sm font-bold">{session.otherName}</span>
          <span className="text-xs opacity-60">
            {clock(Date.now())} · {session.kind === "video" ? "تصویری" : "صوتی"}
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