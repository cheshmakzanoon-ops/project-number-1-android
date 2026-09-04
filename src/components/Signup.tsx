import { useState } from "react";
import { ArrowLeft, Phone, ShieldCheck, Users } from "lucide-react";

export function Signup({
  onRegister,
  busy,
  error = null,
}: {
  onRegister: (name: string) => void;
  busy: boolean;
  error?: string | null;
}) {
  const [name, setName] = useState("");
  const canGo = name.trim().length >= 2;

  return (
    <div className="paper relative flex min-h-full flex-col bg-dusk-50">
      {/* top ornament */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 overflow-hidden">
        <div className="absolute -top-16 left-1/2 h-72 w-72 -translate-x-1/2 rounded-full bg-gradient-to-br from-ember-300/50 to-sage-400/40 blur-3xl" />
      </div>

      <main className="relative z-10 flex flex-1 flex-col items-center px-6 pt-[14vh]">
        {/* logo mark */}
        <div className="flex items-center gap-3">
          <div className="grid h-16 w-16 place-items-center rounded-[22px] bg-gradient-to-br from-ember-400 to-ember-600 text-white shadow-lg shadow-ember-400/30">
            <Users size={30} />
          </div>
          <div>
            <h1 className="text-4xl font-black tracking-tight text-dusk-900">گرما</h1>
            <p className="-mt-1 text-sm font-semibold text-ember-600">گفتگوی خانواده</p>
          </div>
        </div>

        <p className="mt-7 max-w-[20rem] text-center text-base leading-8 text-dusk-600">
          جای گرم همهٔ خانواده؛ هر کس فقط با نوشتن نامش وارد میشود و میتواند <b>پیام بدهد</b> و
          به بقیه <b>تماس صوتی</b> بگیرد.
        </p>

        <div className="mt-8 w-full max-w-xs rounded-3xl border border-dusk-100 bg-white/85 p-2 shadow-sm backdrop-blur">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canGo && !busy) onRegister(name.trim());
            }}
            maxLength={40}
            placeholder="نامت را اینجا بنویس…"
            autoFocus
            className="h-14 w-full rounded-2xl bg-transparent px-4 text-center text-lg font-bold text-dusk-900 outline-none placeholder:font-normal placeholder:text-dusk-300"
          />
        </div>

        <button
          onClick={() => canGo && onRegister(name.trim())}
          disabled={!canGo || busy}
          className={`mt-3 flex w-full max-w-xs items-center justify-center gap-2 rounded-full px-6 py-4 text-lg font-extrabold text-white shadow-xl transition active:scale-[0.98] ${
            canGo && !busy
              ? "bg-ember-500 shadow-ember-500/30 hover:bg-ember-600"
              : "cursor-not-allowed bg-dusk-200 text-dusk-400"
          }`}
        >
          {busy ? "در حال ورود…" : "ورود به گرما"}
          {!busy && <ArrowLeft size={20} />}
        </button>

        <p className="mt-3 flex min-h-5 items-start justify-center gap-1.5 text-center text-xs leading-5 text-rose-600" aria-live="polite">
          {error ? (
            <>
              <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-rose-500 text-[9px] font-black text-white">
                !
              </span>
              {error}
            </>
          ) : name.trim() && name.trim().length < 2 ? (
            <span className="text-dusk-400">حداقل ۲ حرف</span>
          ) : null}
        </p>
      </main>

      {/* trust row */}
      <footer className="relative z-10 mb-6 flex items-center justify-center gap-6 px-6 pb-4 text-[11px] text-dusk-500">
        <span className="flex items-center gap-1.5">
          <Phone size={13} className="text-sage-500" /> تماس صوتی
        </span>
        <span className="flex items-center gap-1.5">
          <ShieldCheck size={13} className="text-sage-500" /> بدون ایمیل و شماره
        </span>
        <span className="flex items-center gap-1.5">
          <Users size={13} className="text-sage-500" /> فقط خانواده
        </span>
      </footer>
    </div>
  );
}