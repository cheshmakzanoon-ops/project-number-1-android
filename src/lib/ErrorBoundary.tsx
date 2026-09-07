import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
  stack: string | null;
}

/**
 * Last line of defense: a render/effect crash anywhere in the app must never
 * leave the phone on a silent black screen (React unmounts the tree on an
 * uncaught error and the page behind it is dark). If something still slips
 * through, this shows a visible warm panel with a working reload button — and
 * prints the error to the console so a screenshot/report can name the cause.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, stack: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[garma] crash:", error, info.componentStack);
    // Show the failing component chain ON the panel: on a phone the console is
    // effectively invisible, and naming the component is what lets a bug report
    // (or a screenshot) identify the crash instead of a generic "error".
    this.setState((prev) => ({ ...prev, stack: info.componentStack || null }));
  }

  render() {
    if (!this.state.error) return this.props.children;
    const err = this.state.error;
    return (
      <div
        dir="rtl"
        className="grid h-full w-full place-items-center"
        style={{ background: "#1a1008", color: "#fff3cf", fontFamily: "Vazirmatn, system-ui, sans-serif" }}
      >
        <div className="mx-6 max-w-sm rounded-3xl border border-[#e5a53f]/25 bg-[#271a0e] p-6 text-center shadow-2xl">
          <p className="text-lg font-extrabold">یک مشکل غیرمنتظره پیش آمد</p>
          <p className="mt-2 text-sm leading-6" style={{ color: "#a9865f" }}>
            اپ از کار افتاد — با دکمهٔ زیر دوباره راه‌اندازی‌اش کن. اگر دوباره تکرار شد،
            متن خطا را برای ما بفرست.
          </p>
          <p
            dir="ltr"
            className="mx-auto mt-3 max-h-24 overflow-auto rounded-xl bg-black/30 px-3 py-2 text-left text-[11px] leading-5"
            style={{ color: "#e3c493" }}
          >
            {err.name}: {err.message}
          </p>
          {this.state.stack && (
            <p
              dir="ltr"
              className="mx-auto mt-2 max-h-28 overflow-auto rounded-xl bg-black/30 px-3 py-2 text-left text-[10px] leading-4"
              style={{ color: "#c9a678" }}
            >
              {this.state.stack}
            </p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-full bg-[#e5a53f] px-7 py-3 font-bold shadow-lg transition hover:brightness-110 active:scale-95"
            style={{ color: "#241203" }}
          >
            تلاش دوباره
          </button>
        </div>
      </div>
    );
  }
}
