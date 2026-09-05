import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { PhoneIncoming, PhoneMissed, PhoneOutgoing, Video } from "lucide-react";
import { Avatar } from "./Avatar";
import { clock, fa, relative, secondsToClock } from "../lib/format";
import type { Id } from "../convex/_generated/dataModel";

/** One row of the calls.recent query (all-tap view). */
interface RecentCallRow {
  callId: Id<"calls">;
  conversationId: Id<"conversations">;
  kind: "audio" | "video";
  status: "ended" | "declined" | "missed";
  initiatedByMe: boolean;
  startedAt: number;
  endedAt: number | null;
  peers: Array<{ userId: Id<"users">; displayName: string; themeColor: string }>;
  convKind: "dm" | "group";
  name: string;
  missed: boolean;
  outgoing: boolean;
  acceptedByAnyone: boolean;
}

/**
 * تماس‌ها tab — the call history the calls.recent query already serves.
 * Tap a row to video-call that person/conversation back.
 */
export function RecentCalls({
  token,
  onCallBack,
}: {
  token: string;
  onCallBack?: (convId: Id<"conversations">) => void;
}) {
  const recent = useQuery(api.calls.recent, token ? { token } : "skip") as unknown as
    | RecentCallRow[]
    | undefined;
  const [filter, setFilter] = useState<"all" | "missed">("all");

  const rows = useMemo(() => {
    const all = recent ?? [];
    return filter === "missed" ? all.filter((r) => r.missed) : all;
  }, [recent, filter]);

  return (
    <div className="animate-rise pt-2">
      {/* filter pills */}
      <div className="mx-1 mb-2 flex items-center gap-1">
        <Pill active={filter === "all"} onClick={() => setFilter("all")}>
          همه
        </Pill>
        <Pill active={filter === "missed"} onClick={() => setFilter("missed")}>
          از دست رفته
        </Pill>
      </div>

      {!recent ? (
        <div className="space-y-3 px-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 rounded-2xl px-3 py-3">
              <div className="h-[46px] w-[46px] animate-pulse rounded-[28%] bg-dusk-300/50" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-1/2 animate-pulse rounded-full bg-dusk-300/50" />
                <div className="h-3 w-1/3 animate-pulse rounded-full bg-dusk-300/40" />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="animate-rise mt-14 px-8 text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-[26px] bg-gradient-to-br from-ember-300 to-ember-500 text-cocoa shadow-lg shadow-black/40 ring-1 ring-ember-300/30">
            <PhoneIncoming size={28} />
          </div>
          <h2 className="mt-4 text-lg font-extrabold text-dusk-950">
            {filter === "missed" ? "تماس از دست رفته نداری" : "هنوز تماسی نداشتی"}
          </h2>
          <p className="mx-auto mt-2 max-w-[17rem] text-sm leading-6 text-dusk-600">
            تماس‌های صوتی و تصویری این‌جا با تاریخشان نشان داده می‌شوند.
          </p>
        </div>
      ) : (
        <div>
          {rows.map((r) => {
            const peer = r.peers[0];
            const title =
              r.convKind === "group" && r.name
                ? r.name
                : (peer?.displayName ?? (r.outgoing ? "تماس خروجی" : "تماس ورودی"));
            const color = peer?.themeColor ?? "#8a6340";
            const duration =
              r.acceptedByAnyone && r.endedAt
                ? secondsToClock(Math.max(0, Math.round((r.endedAt - r.startedAt) / 1000)))
                : null;
            const Icon = r.missed
              ? PhoneMissed
              : r.outgoing
                ? PhoneOutgoing
                : PhoneIncoming;
            return (
              <div
                key={r.callId}
                role="button"
                tabIndex={0}
                onClick={() => onCallBack?.(r.conversationId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onCallBack?.(r.conversationId);
                  }
                }}
                className="flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-3 text-start transition active:bg-dusk-200/60"
              >
                {peer ? (
                  <Avatar name={title} color={color} size={46} />
                ) : (
                  <span className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[28%] bg-dusk-200 text-dusk-600">
                    <PhoneIncoming size={20} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate font-bold ${
                      r.missed ? "text-rose-300" : "text-dusk-900"
                    }`}
                  >
                    {title}
                    {r.convKind === "group" && r.peers.length > 1 && (
                      <span className="mr-1.5 text-[11px] font-semibold text-dusk-600">
                        {fa(r.peers.length + 1)} نفر
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-dusk-600">
                    <Icon
                      size={14}
                      className={r.missed ? "text-rose-400" : "text-sage-400"}
                    />
                    {relative(r.startedAt)} · {clock(r.startedAt)}
                    {duration && (
                      <span className="text-dusk-500"> ({duration})</span>
                    )}
                  </p>
                </div>
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ember-400/15 text-ember-300 transition hover:bg-ember-400/25 active:scale-90"
                  aria-label={r.kind === "video" ? "تماس تصویری" : "تماس"}
                  title={r.kind === "video" ? "تماس تصویری" : "تماس"}
                >
                  <Video size={16} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Pill({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
        active
          ? "bg-ember-400 text-cocoa shadow-md shadow-black/30"
          : "bg-dusk-200/70 text-dusk-600 hover:text-dusk-800"
      }`}
    >
      {children}
    </button>
  );
}
