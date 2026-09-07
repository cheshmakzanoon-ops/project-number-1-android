/**
 * Browser-context helpers shared by the call kit and call UI.
 *
 * The single most common reason a call \"connects but has no media\" during
 * development is that the app is running inside an embedded frame (the dev
 * preview pane, another site, a WebView). Browsers withhold camera, mic and
 * screen capture from cross-origin iframes unless the EMBEDDING page grants
 * them via `<iframe allow=\"camera; microphone; display-capture\">` — the app
 * itself cannot override that. The fix is to open the same app URL in a real
 * top-level tab (or install it), where the normal permission prompts appear.
 */

/** True when the app runs inside an embedded frame (not the top-level page). */
export const IS_EMBEDDED = (() => {
  try {
    return window.self !== window.top;
  } catch {
    // Reading `top` is blocked ⇒ cross-origin frame ⇒ embedded.
    return true;
  }
})();

/** iPhone / iPad (UA + iPadOS≥13 which masquerades as a Mac). */
export const IS_IOS =
  /iP(hone|ad|od)/i.test(navigator.userAgent) ||
  (/Macintosh/i.test(navigator.userAgent) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1);

/** Roughly a phone/tablet-sized device (iOS incl. iPad, or Android). */
export const IS_PHONE = IS_IOS || /Android/i.test(navigator.userAgent);

/** True when the app runs as an installed PWA window (standalone display mode). */
export const IS_STANDALONE =
  (typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches) ||
  ((navigator as Navigator & { standalone?: boolean }).standalone === true);

/**
 * Open the app in a new top-level browser tab so camera/mic/screen capture
 * work. Call this from a click handler (browsers only allow the popup with a
 * user gesture). Returns false when the browser refused to open the tab — the
 * caller should fall back to telling the user to open it themselves.
 */
export function openAppTopLevel(): boolean {
  try {
    const w = window.open(window.location.href, "_blank", "noopener");
    return !!w;
  } catch {
    return false;
  }
}
