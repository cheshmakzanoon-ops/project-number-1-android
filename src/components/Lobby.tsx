import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { Download, Edit, Phone, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { ContactSheet } from "./ContactSheet";
import { useInstallPrompt } from "../lib/useInstallPrompt";
import { fa, relative, preview } from "../lib/format";
import type { DirectoryEntry } from "../lib/types";
import type { Id } from "../convex/_generated/dataModel";

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

export function Lobby({
  token,
  meId,
  meName,
  onOpen,
  onCall,
  onMessageContact,
  onVideoContact,
  onAudioContact,
}: {
  token: string;
  meId: string;
  meName: string;
  onOpen: (convId: string, name: string, color: string, otherId: string) => void;
  onCall: (convId: string, otherId: string, otherName: string, otherColor: string) => void;
  onMessageContact: (c: DirectoryEntry) => void;
  onVideoContact: (c: DirectoryEntry) => void;
  onAudioContact: (c: DirectoryEntry) => void;
}) {
  const conversations = useQuery(
    api.conversations.myConversations,
    token ? { token } : "skip",
  ) as unknown as LobbyRow[] | undefined;
  const directory = useQuery(api.users.directory, token ? { token } : "skip") as
    | DirectoryEntry[]
    | undefined;
  const [sheet, setSheet] = useState(false);
  const install = useInstallPrompt();
  const onlineNow = (lastSeenAt: number) => Date.now() - lastSeenAt < 60_000;

  // Re-render on an interval so relative timestamps ("۵ دقیقه") and the
  // online dot keep up with the clock instead of freezing until the next
  // Convex update.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="paper relative flex h-full flex-col bg-dusk-50">
      <header className="safe-area px-5 pb-3 pt-2">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[1.7rem] font-black leading-tight text-dusk-900">گرما</h1>
            <p className="text-sm text-dusk-500">سلام {meName} عزیز 🌿</p>
          </div>
          <button
            onClick={() => setSheet(true)}
            className="grid h-11 w-11 place-items-center rounded-full bg-dusk-900 text-white shadow-lg transition active:scale-95"
            aria-label="گفتگوی جدید"
          >
            <Edit size={19} />
          </button>
        </div>
      </header>

      {/* In-app install offer: on Xiaomi/MIUI Chrome the native prompt is
          buried in the browser menu — this button triggers it directly. */}
      {install.canInstall && (
        <div className="mx-5 mb-1 flex items-center gap-3 rounded-2xl border border-ember-200 bg-ember-50/80 px-4 py-3 shadow-sm">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ember-500 text-white">
            <Download size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-dusk-900">گرما را نصب کن</p>
            <p className="truncate text-xs text-dusk-500">آیکون صفحه اصلی، مثل یک اپ واقعی</p>
          </div>
          <button
            type="button"
            onClick={install.promptInstall}
            className="shrink-0 rounded-full bg-ember-500 px-4 py-2 text-xs font-extrabold text-white shadow transition hover:bg-ember-600 active:scale-95"
          >
            نصب
          </button>
          <button
            type="button"
            onClick={install.dismiss}
            aria-label="بستن"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-dusk-400 transition hover:bg-dusk-100"
          >
            <X size={15} />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-28 scrollbar-thin">
        {!conversations ? (
          <LobbySkeleton />
        ) : conversations.length === 0 ? (
          <EmptyState
            onNew={() => setSheet(true)}
            hasContacts={(directory?.length ?? 0) > 0}
          />
        ) : (
          <div>
            {conversations.map((row) => {
              const other = row.members.find((m) => m.user._id !== meId);
              const name = row.kind === "group" ? (row.name ?? "گروه") : other?.user.displayName ?? "گفتگو";
              const color = other?.user.themeColor ?? "#8a6340";
              const online = other ? onlineNow(other.user.lastSeenAt) : false;
              const otherId = other?.user._id ?? "";
              return (
                <div
                  key={row._id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(row._id, name, color, otherId)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onOpen(row._id, name, color, otherId);
                    }
                  }}
                  className="group flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-3 text-start transition active:bg-dusk-100/60"
                >
                  <Avatar name={name} color={color} size={52} online={online} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="truncate font-bold text-dusk-900">{name}</p>
                      <span className="shrink-0 text-[11px] text-dusk-400">
                        {row.lastMessageAt_ ? relative(row.lastMessageAt_) : ""}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <p className={`min-w-0 flex-1 truncate text-sm ${row.unread ? "font-bold text-dusk-900" : "text-dusk-500"}`}>
                        {row.lastMessage
                          ? `${row.lastMessageSender ? row.lastMessageSender + "، " : ""}${preview(row.lastMessage)}`
                          : row.kind === "group"
                            ? "گروه جدید"
                            : "گفتگو را شروع کن"}
                      </p>
                      {row.unread > 0 && (
                        <span
                          className="grid h-[20px] min-w-[20px] shrink-0 place-items-center rounded-full bg-ember-500 px-1.5 text-[11px] font-bold leading-none text-white shadow-sm shadow-ember-500/40"
                          aria-label={`${fa(row.unread)} پیام خوانده‌نشده`}
                        >
                          {row.unread > 99 ? "۹۹+" : fa(row.unread)}
                        </span>
                      )}
                      {otherId && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCall(row._id, otherId, name, color);
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ember-100 text-ember-600 transition hover:bg-ember-200 active:scale-90"
                          aria-label="تماس تصویری"
                          title="تماس تصویری"
                        >
                          <Phone size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <button
        onClick={() => setSheet(true)}
        className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-ember-500 px-6 py-3.5 font-extrabold text-white shadow-xl shadow-ember-500/30 transition hover:bg-ember-600 active:scale-95 safe-area"
      >
        <Edit size={19} />
        گفتگوی جدید
      </button>

      <ContactSheet
        open={sheet}
        onClose={() => setSheet(false)}
        contacts={directory ?? []}
        onMessage={onMessageContact}
        onVideo={onVideoContact}
        onAudio={onAudioContact}
      />
    </div>
  );
}

function EmptyState({ onNew, hasContacts }: { onNew: () => void; hasContacts: boolean }) {
  return (
    <div className="animate-rise mt-16 px-8 text-center">
      <div className="mx-auto grid h-20 w-20 place-items-center rounded-[32px] bg-gradient-to-br from-ember-400 to-ember-600 text-white shadow-lg shadow-ember-400/30">
        <Edit size={34} />
      </div>
      <h2 className="mt-5 text-xl font-extrabold text-dusk-900">{hasContacts ? "هنوز گفتگویی نیست" : "خانواده را دعوت کن"}</h2>
      <p className="mx-auto mt-2 max-w-[19rem] text-sm leading-6 text-dusk-500">
        {hasContacts
          ? "به یکی از اعضای خانواده پیام بده تا گفتگو شروع شود."
          : "پیوند این برنامه را برای مادر و پدر بفرست؛ با یک اسم وارد میشوند، بدون ایمیل و شماره."}
      </p>
      <button
        onClick={onNew}
        className="mt-6 rounded-full bg-dusk-900 px-7 py-3 font-bold text-white transition hover:bg-dusk-800 active:scale-95"
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
          <div className="h-[52px] w-[52px] animate-pulse rounded-[28%] bg-dusk-100" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-1/2 animate-pulse rounded-full bg-dusk-100" />
            <div className="h-3 w-3/4 animate-pulse rounded-full bg-dusk-100/70" />
          </div>
        </div>
      ))}
    </div>
  );
}