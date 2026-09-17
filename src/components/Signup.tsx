import { useState } from "react";
import { getFamilyInvite } from "../lib/token";
import { ArrowLeft, Phone, ShieldCheck, Users } from "lucide-react";

export function Signup({
  onRegister,
  busy,
  error = null,
}: {
  onRegister: (name: string, inviteCode: string) => void;
  busy: boolean;
  error?: string | null;
}) {
  const [name, setName] = useState("");
  const [inviteCode, setInviteCode] = useState(getFamilyInvite);
  const canGo = name.trim().length >= 2 && /^[A-Za-z0-9_-]{32,128}$/.test(inviteCode.trim());

  return (
    <div className="paper relative flex min-h-full flex-col bg-dusk-50">
      {/* top ornament */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden">
        <div className="absolute -top-20 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(226,158,69,0.22),rgba(105,171,127,0.06)_55%,transparent_72%)] blur-xl" />
      </div>

      <main className="relative z-10 flex flex-1 flex-col items-center px-6 pt-[13vh]">
        {/* logo mark */}
        <div className="flex items-center gap-3.5">
          <img
            src="/icons/icon.svg"
            alt="نشان گرمای خانواده"
            className="h-[72px] w-[72px] rounded-[24px] shadow-xl shadow-black/50 ring-1 ring-ember-300/25"
          />
          <div>
            <h1 className="text-4xl font-black tracking-tight text-dusk-950 drop-shadow-[0_2px_12px_rgba(242,192,105,0.18)]">
              گرما
            </h1>
            <p className="-mt-1 text-sm font-semibold text-ember-400">گفتگوی خانواده</p>
          </div>
        </div>

        <p className="mt-7 max-w-[21rem] text-center text-base leading-8 text-dusk-700">
          جای گرم همهٔ خانواده؛ با لینک دعوت و نوشتن نامت وارد شو، <b className="text-dusk-950">پیام بده</b>،
          <b className="text-dusk-950"> تماس صوتی و تصویری</b> بگیر و با چند نفر یک <b className="text-dusk-950">گروه</b> بساز.
        </p>

        <div className="mt-8 w-full max-w-xs rounded-3xl border border-dusk-300/50 bg-dusk-100/90 p-2 shadow-lg shadow-black/30 backdrop-blur">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canGo && !busy) onRegister(name.trim(), inviteCode.trim());
            }}
            maxLength={40}
            aria-label="نام نمایشی"
            placeholder="نامت را اینجا بنویس…"
            autoFocus
            className="h-14 w-full rounded-2xl bg-transparent px-4 text-center text-lg font-bold text-dusk-950 caret-ember-400 outline-none placeholder:font-normal placeholder:text-dusk-600"
          />
        </div>

        <label className="mt-3 w-full max-w-xs text-sm text-dusk-700">
          کد دعوت خانواده
          <input aria-label="کد دعوت خانواده" type="password" autoComplete="off" dir="ltr"
            value={inviteCode} onChange={e => setInviteCode(e.target.value)} maxLength={128}
            placeholder="از لینک دعوت پر می‌شود"
            className="mt-1 h-12 w-full rounded-2xl border border-dusk-300/50 bg-dusk-100 px-4 text-dusk-950" />
          <span className="mt-1 block text-xs leading-5">این کد فقط برای ورود روی دستگاه جدید است؛ نامت رمز عبور نیست.</span>
        </label>
        <button
          onClick={() => canGo && onRegister(name.trim(), inviteCode.trim())}
          disabled={!canGo || busy}
          className={`mt-3 flex w-full max-w-xs items-center justify-center gap-2 rounded-full px-6 py-4 text-lg font-extrabold text-cocoa shadow-xl transition active:scale-[0.98] ${
            canGo && !busy
              ? "bg-ember-400 shadow-ember-500/20 hover:bg-ember-300"
              : "cursor-not-allowed bg-dusk-300/70 text-dusk-500"
          }`}
        >
          {busy ? "در حال ورود…" : "ورود به گرما"}
          {!busy && <ArrowLeft size={20} strokeWidth={2.5} />}
        </button>

        <p className="mt-3 flex min-h-5 items-start justify-center gap-1.5 text-center text-xs leading-5 text-rose-300" aria-live="polite">
          {error ? (
            <>
              <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-rose-500 text-[9px] font-black text-white">
                !
              </span>
              {error}
            </>
          ) : name.trim() && name.trim().length < 2 ? (
            <span className="text-dusk-600">حداقل ۲ حرف</span>
          ) : null}
        </p>
      </main>

      {/* trust row */}
      <footer className="relative z-10 mb-6 flex items-center justify-center gap-6 px-6 pb-4 text-[11px] text-dusk-600">
        <span className="flex items-center gap-1.5">
          <Phone size={13} className="text-sage-400" /> تماس صوتی
        </span>
        <span className="flex items-center gap-1.5">
          <ShieldCheck size={13} className="text-sage-400" /> بدون ایمیل و شماره
        </span>
        <span className="flex items-center gap-1.5">
          <Users size={13} className="text-sage-400" /> فقط خانواده
        </span>
      </footer>
    </div>
  );
}
