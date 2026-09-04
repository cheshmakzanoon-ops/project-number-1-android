import { useCallback, useEffect, useState } from "react";

/** The non-standard event Chrome fires so a page can drive its own install UI. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "garma.install.dismissed";

/**
 * Captures Chrome's beforeinstallprompt so the app can offer its own
 * "Install" button. This is the reliable path on Android (including
 * Xiaomi/MIUI Chrome), where the native install option is buried in the
 * browser menu and easy to miss. No-op on browsers without the event —
 * those fall back to the menu item.
 */
export function useInstallPrompt(): {
  canInstall: boolean;
  promptInstall: () => void;
  dismiss: () => void;
} {
  const [evt, setEvt] = useState<InstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // keep Chrome's mini-infobar from appearing
      setEvt(e as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", () => setEvt(null));
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const promptInstall = useCallback(() => {
    if (!evt) return;
    void evt.prompt();
    void evt.userChoice.then(() => setEvt(null));
  }, [evt]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* noop */
    }
  }, []);

  return { canInstall: evt != null && !dismissed, promptInstall, dismiss };
}
