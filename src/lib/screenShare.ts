/**
 * Web-side screen-share capability + Android companion launch helpers.
 *
 * The honest dual path:
 *
 *  - Browsers that genuinely implement `navigator.mediaDevices.getDisplayMedia`
 *    capture the screen themselves (LiveKit web screen share).
 *  - Android browsers that do not — Chrome/WebView on Android has no web API
 *    for this, and no JavaScript can create one — are routed to the native
 *    MediaProjection companion, which joins the SAME LiveKit room as an
 *    auxiliary participant and publishes the screen.
 *  - Everything else gets a truthful message. Nothing here pretends the web
 *    API exists, and the camera is never used as a fake "screen".
 *
 * A device that ADVERTISES the API but cannot actually deliver it (the common
 * Chrome-Android case: the function exists but never yields a capture) is
 * learned and remembered, so the next tap goes straight to the native path
 * instead of failing twice.
 */
import { IS_EMBEDDED, IS_IOS } from "./browser";

/** Which capture path a device will take (web / native companion / none). */
export type ScreenSharePath = "web" | "android-native" | "unsupported";

/** Package + custom scheme of the MediaProjection companion app. */
export const ANDROID_COMPANION_PACKAGE = "com.garma.screenshare";
export const ANDROID_COMPANION_SCHEME = "garma-screenshare";

/** Bundled family installation guide; never imply an unpublished store listing exists. */
export const ANDROID_COMPANION_INSTALL_URL = "/screen-share-help.html";

/** Remembers that this device's web display capture does not really work. */
const WEB_BROKEN_KEY = "garma.share.webBroken";

/** True on Android (phone/tablet/WebView). */
export function isAndroid(): boolean {
  try {
    return /Android/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}

/** True when the browser exposes a display-capture entry point at all. */
export function webDisplayCaptureApiAvailable(): boolean {
  try {
    return typeof navigator.mediaDevices?.getDisplayMedia === "function";
  } catch {
    return false;
  }
}

/** Did a previous attempt on this device prove the web path unusable? */
export function webDisplayCaptureKnownBroken(): boolean {
  try {
    return localStorage.getItem(WEB_BROKEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Record that this device's web display capture failed for real (the API is
 * present but the platform cannot deliver a stream). Only ever called after an
 * actual failed attempt, never speculatively.
 */
export function markWebDisplayCaptureBroken(): void {
  try {
    localStorage.setItem(WEB_BROKEN_KEY, "1");
  } catch {
    /* storage unavailable: the in-memory path decision still applies */
  }
}

/** A successful web capture proves the web path works on this device. */
export function clearWebDisplayCaptureBroken(): void {
  try {
    localStorage.removeItem(WEB_BROKEN_KEY);
  } catch {
    /* noop */
  }
}

/** Everything the path decision depends on (injectable for tests). */
export interface ShareEnvironment {
  android: boolean;
  ios: boolean;
  embedded: boolean;
  webApi: boolean;
  webKnownBroken: boolean;
}

/** Read the current environment from the browser. */
export function currentShareEnvironment(): ShareEnvironment {
  return {
    android: isAndroid(),
    ios: IS_IOS,
    embedded: IS_EMBEDDED,
    webApi: webDisplayCaptureApiAvailable(),
    webKnownBroken: webDisplayCaptureKnownBroken(),
  };
}

/**
 * Pick the capture path for this device.
 *
 * - embedded frames can do neither (browsers withhold screen capture from
 *   cross-origin iframes), so the honest answer is "unsupported" and the UI
 *   tells the user to open the app in a real tab;
 * - a working web API wins (it is the better experience: in-page picker,
 *   native track `ended`, no extra app);
 * - Android without a working web path uses the native companion;
 * - anything else is truthfully unsupported.
 */
export function resolveScreenSharePath(env: ShareEnvironment): ScreenSharePath {
  if (env.embedded) return "unsupported";
  const webUsable = env.webApi && !(env.android && env.webKnownBroken);
  if (webUsable) return "web";
  if (env.android) return "android-native";
  return "unsupported";
}

/**
 * Build the Android intent URL that launches the companion with nothing but an
 * opaque one-time handoff code.
 *
 * No token, JWT, room credential or API secret is ever placed here — and no
 * server address either: a crafted link must not be able to point the
 * companion at an attacker-controlled endpoint, because that would hand the
 * attacker a redeemable code. The companion uses the deployment URL baked into
 * its own build.
 *
 * `browserFallbackUrl` is where Chrome goes when the companion is not
 * installed (back to this app, which explains how to install it).
 */
export function androidCompanionLaunchUrl(code: string, browserFallbackUrl: string): string {
  const fallback = /^https?:\/\//i.test(browserFallbackUrl)
    ? browserFallbackUrl
    : "https://localhost/?screen-share=no-companion";
  const query = new URLSearchParams({ code }).toString();
  return (
    `intent://share?${query}` +
    `#Intent;scheme=${ANDROID_COMPANION_SCHEME};package=${ANDROID_COMPANION_PACKAGE};` +
    `S.browser_fallback_url=${encodeURIComponent(fallback)};end`
  );
}

/** Persian message for a device that has no capture path at all. */
export function unsupportedScreenShareMessage(env: ShareEnvironment): string {
  if (env.embedded) {
    return "اشتراک صفحه در این نمای جاسازی‌شده قفل است؛ لینک اپ را مستقیم در مرورگر باز کن.";
  }
  if (env.ios) {
    return "سافاری آیفون و آی‌پد اجازه نمی‌دهد وب‌سایت صفحهٔ گوشی را بفرستد؛ برای اشتراک صفحه از گوشی اندروید (با اپ همراه) یا کامپیوتر استفاده کن.";
  }
  return "این مرورگر اشتراک صفحه را پشتیبانی نمی‌کند و اپ همراه اندروید هم در دسترس نیست؛ کروم یا فایرفاکس روی کامپیوتر را امتحان کن.";
}
