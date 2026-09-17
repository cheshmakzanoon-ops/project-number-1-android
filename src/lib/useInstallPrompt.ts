import { useCallback, useEffect, useRef, useState } from "react";
import { withTimeout } from "./callLifecycle";

type InstallChoice = { outcome: "accepted" | "dismissed" };
type InstallPromptEvent = Event & {
  prompt: () => Promise<InstallChoice | void>;
  userChoice: Promise<InstallChoice>;
};

/** One browser-owned install prompt per captured event; rejection is not installation. */
export function useInstallPrompt(): {
  visible: boolean; isIOS: boolean; canPromptNative: boolean;
  promptInstall: () => void; dismiss: () => void; error: string | null;
} {
  const [evt, setEvt] = useState<InstallPromptEvent | null>(null);
  const captured = useRef<InstallPromptEvent | null>(null);
  const lifetime = useRef({ alive: true, generation: 0 });
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(() => {
    try { return Boolean(window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone); }
    catch { return false; }
  });
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem("garma.install.dismissed") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    const owner = lifetime.current;
    owner.alive = true;
    const onPrompt = (event: Event) => {
      event.preventDefault();
      captured.current = event as InstallPromptEvent;
      setEvt(captured.current); setError(null);
      owner.generation++;
    };
    const onInstalled = () => {
      owner.generation++;
      captured.current = null; setEvt(null); setInstalled(true); setError(null);
    };
    const onDisplayMode = (event: MediaQueryListEvent) => { if (event.matches) onInstalled(); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    let media: MediaQueryList | undefined;
    try {
      media = window.matchMedia?.("(display-mode: standalone)");
      if (typeof media?.addEventListener === "function") media.addEventListener("change", onDisplayMode);
      else media?.addListener?.(onDisplayMode);
    } catch { /* Optional browser install detection must not break the messenger. */ }
    return () => {
      owner.alive = false; owner.generation++;
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      if (typeof media?.removeEventListener === "function") media.removeEventListener("change", onDisplayMode);
      else media?.removeListener?.(onDisplayMode);
    };
  }, []);
  const promptInstall = useCallback(() => {
    const event = captured.current;
    const owner = lifetime.current;
    if (!event || !owner.alive) return;
    // Consume synchronously: React state alone does not prevent a second click.
    captured.current = null; setEvt(null); setError(null);
    const generation = ++owner.generation;
    const current = () => owner.alive && owner.generation === generation;
    void (async () => {
      try {
        // Invoke while still in the user's click handler. Observe both native
        // promises immediately so neither can reject without a handler.
        const [, choice] = await withTimeout(Promise.all([event.prompt(), event.userChoice]), 60_000, "install_prompt_timeout");
        if (!current()) return;
        if (choice.outcome === "accepted") setInstalled(true);
        else {
          setDismissed(true);
          try { sessionStorage.setItem("garma.install.dismissed", "1"); } catch { /* session-only memory */ }
        }
      } catch {
        if (current()) setError("پنجرهٔ نصب باز نشد؛ از منوی مرورگر «نصب برنامه» یا «افزودن به صفحه اصلی» را انتخاب کن.");
      }
    })();
  }, []);
  const dismiss = useCallback(() => {
    lifetime.current.generation++;
    setDismissed(true); setError(null);
    try { sessionStorage.setItem("garma.install.dismissed", "1"); } catch { /* session-only memory */ }
  }, []);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return { visible: !installed && !dismissed && (evt !== null || isIOS || error !== null),
    isIOS, canPromptNative: evt !== null, promptInstall, dismiss, error };
}
