import { lazy, Suspense, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { api } from "../convex/_generated/api";
import { useSoftQuery } from "../lib/softQuery";
import { Edit, MessageCircle, Phone, Users, Video } from "lucide-react";
import { Avatar } from "./Avatar";
import { StatusStrip } from "./StatusStrip";
import { RecentCalls } from "./RecentCalls";
import { fa, relative, preview } from "../lib/format";
import type { ConvPeer, DirectoryEntry } from "../lib/types";
import type { Id } from "../convex/_generated/dataModel";

// ContactSheet pulls in framer-motion (~100KB), which is only needed when
// the "گفتگوی جدید" sheet is actually opened — so it's split into its own
// chunk and fetched on demand instead of delaying the first paint.
const ContactSheet = lazy(() =>
  import("./ContactSheet").then((m) => ({ default: m.ContactSheet })),
);

type LobbyRow = {
  _id: Id<"conversations">;
  kind: "dm" | "group";
  name?: string;
  lastMessageAt: number;
  unread: number;
  lastMessage: string | null;
  lastMessageSender: string | null;
  lastMessageAt_: number | null;
  members: Array<{
    user: { _id: Id<"users">; displayName: string; themeColor: string; lastSeenAt: number };
    online: boolean;
  }>;
};

/** The lobby's three tabs — chats (default), status rings, recent calls. */
export type LobbyTab = "chats" | "status" | "calls";

/** Other members of a row as ConvPeer (used to ring a whole conversation). */
function peersOf(row: LobbyRow, meId: string): ConvPeer[] {
  return row.members
    .filter((m) => m.user._id !== meId)
    .map((m) => ({
      userId: m.user._id as Id<"users">,
      displayName: m.user.displayName,
      themeColor: m.user.themeColor,
    }));
}

export function Lobby({
  token,
  meId,
  meName,
  tab,
  onTab,
  onOpen,
  onCall,
  onMessageContact,
  onVideoContact,
  onAudioContact,
  onGroupCreate,
}: {
  token: string;
  meId: Id<"users">;
  meName: string;
  tab: LobbyTab;
  onTab: (t: LobbyTab) => void;
  onOpen: (
    convId: string,
    kind: "dm" | "group",
    name: string,
    color: string,
    peers: ConvPeer[],
  ) => void;
  onCall: (convId: Id<"conversations">, peers: ConvPeer[], kind: "audio" | "video") => void;
  onMessageContact: (c: DirectoryEntry) => void;
  onVideoContact: (c: DirectoryEntry) => void;
  onAudioContact: (c: DirectoryEntry) => void;
  onGroupCreate: (members: ConvPeer[]) => void;
}) {
  // Soft queries: if a backend query can't be answered (older deployment
  // missing a function, transient error), the lobby shows its loading/empty
  // state instead of crashing the whole app — and fills in automatically
  // once the query starts answering.
  const { data: conversations } = useSoftQuery(
    api.conversations.myConversations,
    token ? { token } : "skip",
  ) as unknown as { data: LobbyRow[] | undefined; unavailable: boolean };
  const { data: directory } = useSoftQuery(api.users.directory, token ? { token } : "skip") as unknown as {
    data: DirectoryEntry[] | undefined;
    unavailable: boolean;
  };
  const [sheet, setSheet] = useState(false);
  const onlineNow = (lastSeenAt: number) => Date.now() - lastSeenAt < 60_000;

  // Re-render on an interval so relative timestamps and the online dot keep
  // up with the clock instead of freezing until the next Convex update.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const openRow = (row: LobbyRow) => {
    const peers = peersOf(row, meId);
    if (row.kind === "dm") {
      const other = peers[0];
      onOpen(
        row._id,
        "dm",
        other?.displayName ?? row.name ?? "گفتگو",
        other?.themeColor ?? "#8a6340",
        peers,
      );
    } else {
      onOpen(row._id, "group", row.name ?? "گروه", peers[0]?.themeColor ?? "#8a6340", peers);
    }
  };

  return (
    <div className="paper relative flex h-full flex-col bg-dusk-50">
      <header className="safe-area px-5 pb-2 pt-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <img
              src="/icons/icon.svg"
              alt=""
              aria-hidden="true"
              className="h-12 w-12 rounded-[16px] shadow-md shadow-black/40 ring-1 ring-ember-300/20"
            />
            <div>
              <h1 className="text-[1.7rem] font-black leading-tight text-dusk-950 drop-shadow-[0_2px_10px_rgba(242,192,105,0.15)]">
                گرما
              </h1>
              <p className="text-sm text-dusk-600">سلام {meName} عزیز 🌿</p>
            </div>
          </div>
          {tab === "chats" && (
            <button
              onClick={() => setSheet(true)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ember-400 text-cocoa shadow-lg shadow-black/30 transition hover:bg-ember-300 active:scale-95"
              aria-label="گفتگوی جدید"
            >
              <Edit size={19} />
            </button>
          )}
        </div>

        {/* ---- bottom-of-app tabs: گفتگوها / وضعیت‌ها / تماس‌ها ---- */}
        <div className="mt-3 flex items-center gap-1 rounded-full bg-dusk-200/70 p-1">
          <TabPill active={tab === "chats"} onClick={() => onTab("chats")}>
            <MessageCircle size={15} /> گفتگوها
          </TabPill>
          <TabPill active={tab === "status"} onClick={() => onTab("status")}>
            <span className="relative flex items-center gap-1.5">
              <StatusDotOnline token={token} />
              وضعیت‌ها
            </span>
          </TabPill>
          <TabPill active={tab === "calls"} onClick={() => onTab("calls")}>
            <Phone size={15} /> تماس‌ها
          </TabPill>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-3 pb-28 scrollbar-thin">
        {tab === "status" ? (
          <StatusStrip token={token} meId={meId} meName={meName} />
        ) : tab === "calls" ? (
          <RecentCalls token={token} />
        ) : !conversations ? (
          <LobbySkeleton />
        ) : conversations.length === 0 ? (
          <EmptyState
            onNew={() => setSheet(true)}
            hasContacts={(directory?.length ?? 0) > 0}
          />
        ) : (
          <div>
            {conversations.map((row) => {
              const peers = peersOf(row, meId);
              const isGroup = row.kind === "group";
              const mainRow = row.members.find((m) => m.user._id !== meId);
              const main = peers[0];
              const name = isGroup ? (row.name ?? "گروه") : (main?.displayName ?? "گفتگو");
              const color = main?.themeColor ?? "#8a6340";
              const online = mainRow ? onlineNow(mainRow.user.lastSeenAt) : false;
              const memberCount = row.members.length;
              return (
                <div
                  key={row._id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openRow(row)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openRow(row);
                    }
                  }}
                  className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-3 text-start transition active:bg-dusk-200/60"
                >
                  <div className="relative shrink-0">
                    {isGroup ? (
                      <GroupAvatar peers={peers} />
                    ) : (
                      <Avatar name={name} color={color} size={52} online={online} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate font-bold text-dusk-900">
                        {name}
                        {isGroup && memberCount > 1 && (
                          <span className="mr-1.5 text-[11px] font-semibold text-dusk-600">
                            {fa(memberCount)} نفر
                          </span>
                        )}
                      </p>
                      <span className="shrink-0 text-[11px] text-dusk-600">
                        {row.lastMessageAt_ ? relative(row.lastMessageAt_) : ""}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <p className={`min-w-0 flex-1 truncate text-sm ${row.unread ? "font-bold text-dusk-950" : "text-dusk-600"}`}>
                        {row.lastMessage
                          ? `${row.lastMessageSender ? row.lastMessageSender + "، " : ""}${preview(row.lastMessage)}`
                          : isGroup
                            ? "گروه جدید — گفتگو یا تماس گروهی شروع کن"
                            : "گفتگو را شروع کن"}
                      </p>
                      {row.unread > 0 && (
                        <span
                          className="grid h-[20px] min-w-[20px] shrink-0 place-items-center rounded-full bg-ember-400 px-1.5 text-[11px] font-bold leading-none text-cocoa shadow-sm shadow-black/40"
                          aria-label={`${fa(row.unread)} پیام خوانده‌نشده`}
                        >
                          {row.unread > 99 ? "۹۹+" : fa(row.unread)}
                        </span>
                      )}
                      {isGroup && peers.length > 0 && (
                        <>
                          <RowCallBtn
                            label="تماس صوتی گروهی"
                            onClick={(e) => {
                              e.stopPropagation();
                              onCall(row._id, peers, "audio");
                            }}
                          >
                            <Phone size={15} />
                          </RowCallBtn>
                          <RowCallBtn
                            label="تماس تصویری گروهی"
                            tone
                            onClick={(e) => {
                              e.stopPropagation();
                              onCall(row._id, peers, "video");
                            }}
                          >
                            <Video size={16} />
                          </RowCallBtn>
                        </>
                      )}
                      {!isGroup && main && (
                        <RowCallBtn
                          label="تماس تصویری"
                          tone
                          onClick={(e) => {
                            e.stopPropagation();
                            onCall(row._id, peers, "video");
                          }}
                        >
                          <Video size={16} />
                        </RowCallBtn>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {tab === "chats" && (
        <button
          onClick={() => setSheet(true)}
          className="safe-area fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ember-400 px-6 py-3.5 font-extrabold text-cocoa shadow-xl shadow-black/40 ring-1 ring-ember-300/40 transition hover:bg-ember-300 active:scale-95"
        >
          <Edit size={19} />
          گفتگوی جدید
        </button>
      )}

      <Suspense fallback={null}>
        <ContactSheet
          open={sheet}
          onClose={() => setSheet(false)}
          contacts={directory ?? []}
          canMakeGroup={(directory?.length ?? 0) >= 2}
          onMessage={onMessageContact}
          onVideo={onVideoContact}
          onAudio={onAudioContact}
          onGroupCreate={(selected) => {
            const members: ConvPeer[] = selected.map((c) => ({
              userId: c._id,
              displayName: c.displayName,
              themeColor: c.themeColor,
            }));
            onGroupCreate(members);
            setSheet(false);
          }}
        />
      </Suspense>
    </div>
  );
}

function RowCallBtn({
  children,
  onClick,
  label,
  tone = false,
}: {
  children: ReactNode;
  onClick: (e: MouseEvent) => void;
  label: string;
  tone?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerDown={(e) => e.stopPropagation()}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full transition active:scale-90 ${
        tone
          ? "bg-ember-400/15 text-ember-300 hover:bg-ember-400/25"
          : "bg-sage-600/20 text-sage-300 hover:bg-sage-600/30"
      }`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

/** One of the three lobby tabs (گفتگوها / وضعیت‌ها / تماس‌ها). */
function TabPill({
  children,
  active,
  onClick,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 text-[13px] font-bold transition ${
        active
          ? "bg-ember-400 text-cocoa shadow-md shadow-black/30"
          : "text-dusk-600 hover:text-dusk-800"
      }`}
    >
      {children}
    </button>
  );
}

/** Tiny green dot on the وضعیت‌ها tab when someone has a live status. */
function StatusDotOnline({ token }: { token: string }) {
  // Soft: on a backend whose statuses module isn't deployed yet (or a
  // transient error) this resolves to no dot instead of crashing the lobby.
  const { data: feed } = useSoftQuery(api.statuses.feed, token ? { token } : "skip");
  const count = Array.isArray(feed) ? feed.length : 0;
  if (count === 0) return null;
  return <span className="h-2 w-2 rounded-full bg-sage-400" />;
}

/** Small stacked avatars for a group conversation row. */
function GroupAvatar({ peers }: { peers: ConvPeer[] }) {
  const shown = peers.slice(0, 3);
  const size = 30;
  return (
    <div
      className="grid place-items-center rounded-[26%] bg-[radial-gradient(circle_at_30%_20%,rgba(242,192,105,0.28),rgba(36,20,8,0.9)_70%)] ring-1 ring-ember-300/25"
      style={{ width: 52, height: 52 }}
    >
      {shown.length === 0 ? (
        <Users size={22} className="text-ember-300/80" />
      ) : shown.length === 1 ? (
        <Avatar name={shown[0].displayName} color={shown[0].themeColor} size={44} />
      ) : (
        <div className="flex -space-x-2.5 rtl:space-x-reverse">
          {shown.map((p) => (
            <div key={p.userId} className="rounded-full ring-2 ring-dusk-50">
              <Avatar name={p.displayName} color={p.themeColor} size={size} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onNew, hasContacts }: { onNew: () => void; hasContacts: boolean }) {
  return (
    <div className="animate-rise mt-16 px-8 text-center">
      <div className="mx-auto grid h-20 w-20 place-items-center rounded-[32px] bg-gradient-to-br from-ember-300 to-ember-500 text-cocoa shadow-lg shadow-black/40 ring-1 ring-ember-300/30">
        <Edit size={34} />
      </div>
      <h2 className="mt-5 text-xl font-extrabold text-dusk-950">{hasContacts ? "هنوز گفتگویی نیست" : "خانواده را دعوت کن"}</h2>
      <p className="mx-auto mt-2 max-w-[19rem] text-sm leading-6 text-dusk-600">
        {hasContacts
          ? "با یک نفر گفتگو را شروع کن یا با انتخاب چند نفر یک گروه بساز تا تماس گروهی بگیرید."
          : "پیوند این برنامه را برای مادر و پدر بفرست؛ با یک اسم وارد میشوند، بدون ایمیل و شماره."}
      </p>
      <button
        onClick={onNew}
        className="mt-6 rounded-full bg-ember-400 px-7 py-3 font-bold text-cocoa shadow-lg shadow-black/30 transition hover:bg-ember-300 active:scale-95"
      >
        گفتگوی جدید
      </button>
    </div>
  );
}

function LobbySkeleton() {
  return (
    <div className="space-y-3 px-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl px-3 py-3">
          <div className="h-[52px] w-[52px] animate-pulse rounded-[28%] bg-dusk-300/50" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/2 animate-pulse rounded-full bg-dusk-300/50" />
            <div className="h-3 w-3/4 animate-pulse rounded-full bg-dusk-300/40" />
          </div>
        </div>
      ))}
    </div>
  );
}
