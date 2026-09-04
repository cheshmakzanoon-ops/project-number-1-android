import { Download, X } from "lucide-react";
import { useInstallPrompt } from "../lib/useInstallPrompt";

/**
 * In-app "install گرما" offer, rendered at the top of every screen and shown
 * again on every fresh open of the app URL (see useInstallPrompt) until the
 * app is actually installed on the device. Tapping the action launches the
 * browser's native install dialog on Android/desktop Chrome; on iOS it
 * explains the Add-to-Home-Screen flow instead.
 */
export function InstallBanner() {
  const install = useInstallPrompt();
  if (!install.visible) return null;

  return (
    <div
      role="status"
      className="animate-rise relative z-40 mx-3 mt-2 flex items-center gap-3 overflow-hidden rounded-2xl border border-ember-300/25 bg-gradient-to-l from-dusk-100/95 via-[#241607]/95 to-dusk-100/95 px-3 py-2.5 shadow-lg shadow-black/40 backdrop-blur"
    >
      {/* warm glow accent on the left edge */}
      <span className="pointer-events-none absolute inset-y-0 start-0 w-1 bg-gradient-to-b from-ember-300/80 to-ember-600/60" />

      <img
        src="/icons/icon.svg"
        alt=""
        aria-hidden="true"
        className="h-11 w-11 shrink-0 rounded-[14px] shadow-md shadow-black/40 ring-1 ring-ember-300/30"
      />

      <div className="min-w-0 flex-1">
        {install.isIOS ? (
          <>
            <p className="text-[13px] font-extrabold text-dusk-950">گرما را به صفحه اصلی اضافه کن</p>
            <p className="mt-0.5 text-[11px] leading-5 text-dusk-600">
              در سافاری: دکمهٔ اشتراک‌گذاری ← «افزودن به صفحه اصلی»
            </p>
          </>
        ) : (
          <>
            <p className="text-[13px] font-extrabold text-dusk-950">گرما را روی گوشی‌ات نصب کن</p>
            <p className="mt-0.5 truncate text-[11px] leading-5 text-dusk-600">
              مثل یک اپ واقعی؛ سریع‌تر باز می‌شود و تماس‌ها حتی وقتی بسته است زنگ می‌زند
            </p>
          </>
        )}
      </div>

      {!install.isIOS && install.canPromptNative && (
        <button
          type="button"
          onClick={install.promptInstall}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-ember-400 px-3.5 py-2 text-xs font-extrabold text-cocoa shadow-md shadow-ember-500/25 transition hover:bg-ember-300 active:scale-95"
        >
          <Download size={14} strokeWidth={2.5} />
          نصب
        </button>
      )}
      <button
        type="button"
        onClick={install.dismiss}
        aria-label="بستن"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-dusk-500 transition hover:bg-dusk-300/40 hover:text-dusk-700 active:scale-90"
      >
        <X size={15} />
      </button>
    </div>
  );
}
