import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import { useSoftQuery } from "../lib/softQuery";
import { Camera, Eye, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { clock, fa, relative } from "../lib/format";
import { compressImage, putStorageFile } from "../lib/media";
import type { Id } from "../convex/_generated/dataModel";

/** One projected status row (mirrors statuses.statusView server-side). */
interface StatusRow {
  _id: Id<"statuses">;
  kind: "text" | "image";
  body: string;
  url?: string;
  createdAt: number;
  expiresAt: number;
  viewers: Array<{ userId: Id<"users">; displayName: string; themeColor: string; viewedAt: number }>;
  ownerId: Id<"users">;
  ownerName: string;
  ownerColor: string;
}

/**
 * وضعیت‌ها tab — WhatsApp-style 24h status rings:
 *  - "me" ring opens the composer (or my own story when I have one),
 *  - every other person with a live status shows a ring that opens the
 *    fullscreen story viewer (auto-advances, marks as seen),
 *  - my own story can be deleted from the viewer.
 */
export function StatusStrip({
  token,
  meId,
  meName,
}: {
  token: string;
  meId: Id<"users">;
  meName: string;
}) {
  // Soft queries: if the backend doesn't have the statuses module yet (or a
  // query hiccups), the tab shows its normal empty state instead of crashing
  // the whole app — and lights up by itself once the module is live.
  const { data: feed } = useSoftQuery(api.statuses.feed, token ? { token } : "skip") as unknown as {
    data: StatusRow[] | undefined;
    unavailable: boolean;
  };
  const { data: mine } = useSoftQuery(api.statuses.mine, token ? { token } : "skip") as unknown as {
    data: StatusRow[] | undefined;
    unavailable: boolean;
  };

  const post = useMutation(api.statuses.post);
  const remove = useMutation(api.statuses.remove);
  const view = useMutation(api.statuses.view);
  const uploadUrl = useMutation(api.statuses.uploadUrl);

  const [composer, setComposer] = useState(false);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);
  const [viewer, setViewer] = useState<{ ownerId: Id<"users">; mine: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Group the feed by owner (each person = one ring, newest first inside).
  const byOwner = useMemo(() => {
    const map = new Map<Id<"users">, StatusRow[]>();
    for (const s of feed ?? []) {
      const arr = map.get(s.ownerId) ?? [];
      arr.push(s);
      map.set(s.ownerId, arr);
    }
    return [...map.entries()].sort(
      (a, b) => (b[1][0]?.createdAt ?? 0) - (a[1][0]?.createdAt ?? 0),
    );
  }, [feed]);

  // Re-render every 30s so «X ساعت پیش» labels stay fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!err) return;
    const t = window.setTimeout(() => setErr(null), 4000);
    return () => window.clearTimeout(t);
  }, [err]);

  const postText = useCallback(async () => {
    const body = text.trim();
    if (!body) return;
    setPosting(true);
    try {
      await post({ token, kind: "text", body });
      setText("");
      setComposer(false);
    } catch {
      setErr("ثبت وضعیت ممکن نشد — دوباره تلاش کن.");
    } finally {
      setPosting(false);
    }
  }, [post, text, token]);

  const postPhoto = useCallback(async () => {
    if (!photo) return;
    setPosting(true);
    try {
      const blob = await compressImage(photo.blob);
      const up = await uploadUrl({ token });
      const storageId = (await putStorageFile(up, blob)) as Id<"_storage">;
      await post({ token, kind: "image", storageId, mimeType: "image/jpeg", body: text.trim() });
      setPhoto(null);
      setText("");
      setComposer(false);
    } catch {
      setErr("ثبت عکس وضعیت ممکن نشد — دوباره تلاش کن.");
    } finally {
      setPosting(false);
    }
  }, [photo, post, text, token, uploadUrl]);

  const mineAll = mine ?? [];
  const hasMine = mineAll.length > 0;

  return (
    <div className="animate-rise pt-2">
      <div className="flex items-stretch gap-3 overflow-x-auto px-2 pb-3 scrollbar-thin">
        {/* ---- my ring: compose (or view my own story) ---- */}
        <button
          type="button"
          onClick={() => setComposer(true)}
          className="flex w-[72px] shrink-0 flex-col items-center gap-1.5"
          aria-label="وضعیت جدید"
        >
          <span className="relative">
            <Avatar name={meName} color="#8a6340" size={58} />
            <span className="absolute -bottom-0.5 -end-0.5 grid h-6 w-6 place-items-center rounded-full border-2 border-dusk-50 bg-ember-400 text-cocoa shadow-md">
              <Plus size={14} strokeWidth={3} />
            </span>
          </span>
          <span className="max-w-[72px] truncate text-[11px] font-bold text-dusk-700">من</span>
        </button>

        {hasMine && (
          <StatusRing
            name={meName}
            color="#8a6340"
            label="وضعیت من"
            unseen={mineAll.some((s) => (s.viewers ?? []).length === 0 && s.ownerId !== meId)}
            onClick={() => setViewer({ ownerId: meId, mine: true })}
          />
        )}

        {byOwner.map(([ownerId, rows]) => {
          const first = rows[0];
          if (!first) return null;
          const seenByMe = rows.every((r) =>
            (r.viewers ?? []).some((v) => v.userId === meId),
          );
          return (
            <StatusRing
              key={ownerId}
              name={first.ownerName}
              color={first.ownerColor}
              label={relative(first.createdAt)}
              unseen={!seenByMe}
              onClick={() => setViewer({ ownerId, mine: false })}
            />
          );
        })}

        {(feed?.length ?? 0) === 0 && !hasMine && (
          <div className="flex flex-1 flex-col items-start justify-center px-2 py-6">
            <p className="text-sm font-extrabold text-dusk-900">هنوز وضعیتی نیست</p>
            <p className="mt-1 max-w-[16rem] text-xs leading-5 text-dusk-600">
              اولین وضعیت را بگذار؛ بعد از ۲۴ ساعت خودبه‌خود پاک می‌شود.
            </p>
          </div>
        )}
      </div>

      {err && (
        <p className="mx-2 rounded-xl bg-rose-500/15 px-3 py-2 text-xs font-bold text-rose-200">
          {err}
        </p>
      )}

        {byOwner.map(([ownerId, rows]) => (
          <StatusRowCard
            key={ownerId}
            row={rows[0]}
            count={rows.length}
            onOpen={() => setViewer({ ownerId, mine: ownerId === meId })}
          />
        ))}

      {/* ================= composer ================= */}
      {composer && (
        <div className="fixed inset-0 z-40 flex flex-col bg-[#120a05]/97 backdrop-blur-sm">
          <div className="safe-area flex items-center justify-between px-4 pt-3">
            <button
              onClick={() => {
                setComposer(false);
                setPhoto(null);
              }}
              aria-label="بستن"
              className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
            >
              <X size={20} />
            </button>
            <p className="text-sm font-bold text-white/80">وضعیت جدید</p>
            <span className="h-10 w-10" />
          </div>
          <div className="flex flex-1 flex-col items-center justify-center px-6">
            {photo ? (
              <img
                src={photo.url}
                alt=""
                className="max-h-[55vh] w-auto rounded-3xl border border-white/10 object-contain shadow-2xl"
              />
            ) : (
              <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={300}
                rows={4}
                placeholder="حال و روزت را بنویس…"
                className="w-full max-w-sm resize-none rounded-3xl border border-ember-300/25 bg-dusk-100 px-5 py-4 text-lg font-bold text-dusk-950 caret-ember-300 outline-none placeholder:text-dusk-600 focus:border-ember-400/60"
              />
            )}
            <p className="mt-2 text-[11px] text-white/40">{fa(300 - text.length)}</p>
          </div>
          <div className="safe-area mx-auto flex w-full max-w-md items-center justify-between px-6 pb-5">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              aria-label="انتخاب عکس"
              className="grid h-14 w-14 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20 active:scale-95"
            >
              <Camera size={22} />
            </button>
            <button
              type="button"
              onClick={() => void (photo ? postPhoto() : postText())}
              disabled={posting || (!text.trim() && !photo)}
              className={`flex items-center gap-2 rounded-full px-7 py-3.5 font-extrabold shadow-lg transition active:scale-95 ${
                posting || (!text.trim() && !photo)
                  ? "cursor-not-allowed bg-dusk-300/50 text-dusk-500"
                  : "bg-ember-400 text-cocoa shadow-black/40 hover:bg-ember-300"
              }`}
            >
              <Send size={18} />
              ثبت وضعیت
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setPhoto({ blob: f, url: URL.createObjectURL(f) });
              e.target.value = "";
            }}
          />
        </div>
      )}

      {/* ================= story viewer ================= */}
      {viewer && (
        <StatusViewer
          token={token}
          ownerId={viewer.ownerId}
          mine={viewer.mine}
          onClose={() => setViewer(null)}
          onDelete={async (id) => {
            try {
              await remove({ token, statusId: id });
            } catch {
              /* noop */
            }
          }}
          onView={(id) => {
            void view({ token, statusId: id }).catch(() => {});
          }}
        />
      )}
      {viewer && <span className="hidden">{viewer.mine}</span>}
    </div>
  );
}

/** One ring in the strip. */
function StatusRing({
  name,
  color,
  label,
  unseen,
  onClick,
}: {
  name: string;
  color: string;
  label: string;
  unseen: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-[72px] shrink-0 flex-col items-center gap-1.5"
      aria-label={`وضعیت ${name}`}
    >
      <span className={unseen ? "animate-ring rounded-[28%]" : "rounded-[28%]"}>
        <span className="block rounded-[28%] bg-gradient-to-br from-ember-400/60 to-sage-400/40 p-[3px]">
          <span className="block rounded-[28%] bg-dusk-50 p-[2px]">
            <Avatar name={name} color={color} size={52} />
          </span>
        </span>
      </span>
      <span className="max-w-[72px] truncate text-[11px] font-bold text-dusk-700">{label}</span>
    </button>
  );
}

/** A tappable summary card under the strip (who + caption + time). */
function StatusRowCard({
  row,
  count,
  onOpen,
}: {
  row: StatusRow;
  count: number;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex w-full cursor-pointer items-center gap-3 rounded-2xl px-3 py-3 text-start transition active:bg-dusk-200/60"
    >
      <Avatar name={row.ownerName} color={row.ownerColor} size={46} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-bold text-dusk-900">{row.ownerName}</p>
        <p className="mt-0.5 truncate text-sm text-dusk-600">
          {relative(row.createdAt)}
          {row.kind === "image" && row.body ? ` — ${row.body}` : ""}
          {count > 1 ? ` (${fa(count)})` : ""}
        </p>
      </div>
    </div>
  );
}

/** Fullscreen 24h-story viewer: auto-advance + progress bars + seen marking. */
function StatusViewer({
  token,
  ownerId,
  mine,
  onClose,
  onDelete,
  onView,
}: {
  token: string;
  ownerId: Id<"users">;
  mine: boolean;
  onClose: () => void;
  onDelete: (id: Id<"statuses">) => void | Promise<void>;
  onView: (id: Id<"statuses">) => void;
}) {
  const { data: rows } = useSoftQuery(
    api.statuses.forOwner,
    token ? { token, ownerId } : "skip",
  ) as unknown as { data: StatusRow[] | undefined; unavailable: boolean };
  const [idx, setIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [showViewers, setShowViewers] = useState(false);

  const list = rows ?? [];
  const current = list[Math.min(idx, Math.max(0, list.length - 1))];

  const advance = useCallback(() => {
    setProgress(0);
    setIdx((i) => {
      if (i + 1 < list.length) return i + 1;
      onClose();
      return i;
    });
  }, [list.length, onClose]);

  // 6 seconds per status, auto-advance.
  useEffect(() => {
    if (!current) return;
    const id = window.setInterval(() => {
      setProgress((p) => {
        if (p >= 100) return p;
        return p + 2;
      });
    }, 120);
    return () => window.clearInterval(id);
  }, [current]);

  useEffect(() => {
    if (progress >= 100) advance();
  }, [progress, advance]);

  // Mark as seen.
  useEffect(() => {
    if (current && !mine) onView(current._id);
  }, [current, mine, onView]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!current) {
    return (
      <div className="fixed inset-0 z-40 grid place-items-center bg-[#120a05]/97">
        <button onClick={onClose} aria-label="بستن" className="absolute top-4 end-4 grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white">
          <X size={20} />
        </button>
        <p className="text-sm text-white/60">این وضعیت تمام شده است.</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-[#120a05]">
      {/* progress bars */}
      <div className="safe-area flex gap-1 px-3 pt-3">
        {list.map((s, i) => (
          <span key={s._id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/20">
            <span
              className="block h-full rounded-full bg-ember-300 transition-[width] duration-100"
              style={{ width: `${i < idx ? 100 : i === idx ? Math.min(progress, 100) : 0}%` }}
            />
          </span>
        ))}
      </div>

      <div className="flex items-center gap-3 px-4 pt-3">
        <Avatar name={current.ownerName} color={current.ownerColor} size={38} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-extrabold text-white">{current.ownerName}</p>
          <p className="text-[11px] text-white/50">{clock(current.createdAt)}</p>
        </div>
        {mine && (
          <button
            onClick={() => {
              void onDelete(current._id);
              onClose();
            }}
            aria-label="حذف وضعیت"
            className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-rose-300 transition hover:bg-white/20"
          >
            <Trash2 size={17} />
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="بستن"
          className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
        >
          <X size={18} />
        </button>
      </div>

      {/* tap zones: right = previous, left = next (RTL-friendly) */}
      <div className="relative flex-1">
        <button
          className="absolute inset-y-0 start-0 z-10 w-1/3"
          onClick={() => {
            setProgress(0);
            setIdx((i) => Math.max(0, i - 1));
          }}
          aria-label="قبلی"
        />
        <button
          className="absolute inset-y-0 end-0 z-10 w-2/3"
          onClick={advance}
          aria-label="بعدی"
        />
        <div className="grid h-full place-items-center px-6">
          {current.kind === "image" && current.url ? (
            <img
              src={current.url}
              alt=""
              className="max-h-[70vh] max-w-full rounded-3xl border border-white/10 object-contain"
            />
          ) : null}
          {current.body && (
            <p
              className={`whitespace-pre-wrap break-words text-center font-extrabold leading-9 text-white ${
                current.kind === "image" ? "mt-4 max-w-md text-xl" : "max-w-lg text-3xl"
              }`}
            >
              {current.body}
            </p>
          )}
        </div>
      </div>

      {/* footer: viewers (owner) or count */}
      <div className="safe-area flex items-center justify-between px-5 pb-4">
        <span className="flex items-center gap-1.5 text-xs text-white/55">
          <Eye size={14} />
          {mine
            ? `${fa((current.viewers ?? []).length)} دیده‌شده`
            : `${fa(list.length)} وضعیت`}
        </span>
        {mine && (current.viewers ?? []).length > 0 && (
          <button
            onClick={() => setShowViewers((v) => !v)}
            className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[11px] font-bold text-white/80 transition hover:bg-white/20"
          >
            <Pencil size={12} /> دیدن لیست
          </button>
        )}
      </div>

      {showViewers && (
        <div className="absolute inset-x-4 bottom-16 z-20 max-h-72 overflow-y-auto rounded-3xl border border-white/10 bg-[#241408]/95 p-2 shadow-2xl backdrop-blur">
          {(current.viewers ?? []).map((v) => (
            <div key={v.userId} className="flex items-center gap-3 px-2 py-2">
              <Avatar name={v.displayName} color={v.themeColor} size={32} />
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-white/90">
                {v.displayName}
              </span>
              <span className="text-[10px] text-white/45">{clock(v.viewedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
