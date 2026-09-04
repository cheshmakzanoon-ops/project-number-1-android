import { useCallback, useEffect, useState } from "react";

/** The non-standard event Chrome/Edge fire so a page can drive its own install UI. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * Captures Chrome's beforeinstallprompt so the app can offer its own
 * "Install گرما" banner. This is the reliable path on Android (including
 * Xiaomi/MIUI Chrome) where the native install option is buried in the
 * browser menu and easy to miss.
 *
 * The banner is deliberately shown again on EVERY page load (dismissal is
 * remembered only for the current tab session, via sessionStorage — never
 * localStorage) so every person who opens the app's URL is re-reminded they
 * can put it on their home screen. The only thing that hides it for good is
 * actually installing (display-mode: standalone) or accepting the prompt.
 *
 * On iOS Safari there is no beforeinstallprompt, so the banner switches to
 * "Add to Home Screen" guidance instead. No-op on browsers where neither
 * applies — those still have the native menu item.
 */
export function useInstallPrompt(): {
  visible: boolean;
  isIOS: boolean;
  canPromptNative: boolean;
  promptInstall: () => void;
  dismiss: () => void;
} {
  const [evt, setEvt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState<boolean>(() => {
    try {
      if (
        window.matchMedia("(display-mode: standalone)").matches ||
        (navigator as unknown as { standalone?: boolean }).standalone
      ) {
        return true;
      }
    } catch {
      /* noop */
    }
    return false;
  });
  // Per-tab-session only: closing the tab and reopening the URL brings the
  // offer right back. sessionStorage starts empty on every fresh visit.
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem("garma.install.dismissed") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault(); // keep Chrome's mini-infobar from appearing
      setEvt(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setEvt(null);
    };
    const onDisplayMode = (e: MediaQueryListEvent) => {
      if (e.matches) setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    const mql = window.matchMedia("(display-mode: standalone)");
    mql.addEventListener("change", onDisplayMode);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      mql.removeEventListener("change", onDisplayMode);
    };
  }, []);

  const promptInstall = useCallback(() => {
    if (!evt) return;
    // One native prompt per captured event. If they dismiss it here, don't
    // re-ask inside this same session — but the next fresh page load will.
    void evt.prompt();
    void evt.userChoice
      .then((choice) => {
        if (choice.outcome === "accepted") {
          setInstalled(true);
        } else {
          setDismissed(true);
          try {
            sessionStorage.setItem("garma.install.dismissed", "1");
          } catch {
            /* noop */
          }
        }
        setEvt(null);
      })
      .catch(() => {
        setEvt(null);
      });
  }, [evt]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      sessionStorage.setItem("garma.install.dismissed", "1");
    } catch {
      /* noop */
    }
  }, []);

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  // Shown on every fresh open of the URL: either Chrome offered the native
  // install event, or this is iOS where we explain Add-to-Home-Screen.
  const visible = !installed && !dismissed && (evt != null || isIOS);

  return { visible, isIOS, canPromptNative: evt != null, promptInstall, dismiss };
}
