import { Component, type ReactNode } from "react";

/** Production recovery never renders request arguments, messages or credentials. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {
    console.error("[garma] UI recovery required (GARMA-UI-01)");
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div dir="rtl" role="alert" className="grid h-full w-full place-items-center bg-dusk-50 text-dusk-950">
      <div className="mx-6 max-w-sm rounded-3xl border border-ember-300/25 bg-dusk-100 p-6 text-center shadow-2xl">
        <p className="text-lg font-extrabold">یک مشکل غیرمنتظره پیش آمد</p>
        <p className="mt-2 text-sm leading-6 text-dusk-700">با دکمهٔ زیر دوباره تلاش کن. پیام‌های ارسال‌نشدهٔ متنی که روی این دستگاه ذخیره شده‌اند پاک نمی‌شوند.</p>
        <p dir="ltr" className="mt-3 text-xs text-dusk-600">GARMA-UI-01</p>
        <button type="button" onClick={() => window.location.reload()}
          className="mt-5 rounded-full bg-ember-400 px-7 py-3 font-bold text-cocoa">تلاش دوباره</button>
      </div>
    </div>;
  }
}
