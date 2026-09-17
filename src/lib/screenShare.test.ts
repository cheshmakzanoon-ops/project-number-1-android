import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANDROID_COMPANION_INSTALL_URL,
  ANDROID_COMPANION_PACKAGE,
  ANDROID_COMPANION_SCHEME,
  androidCompanionLaunchUrl,
  clearWebDisplayCaptureBroken,
  currentShareEnvironment,
  markWebDisplayCaptureBroken,
  resolveScreenSharePath,
  unsupportedScreenShareMessage,
  webDisplayCaptureKnownBroken,
  type ShareEnvironment,
} from "./screenShare";

const env = (over: Partial<ShareEnvironment> = {}): ShareEnvironment => ({
  android: false,
  ios: false,
  embedded: false,
  webApi: true,
  webKnownBroken: false,
  ...over,
});

beforeEach(() => {
  clearWebDisplayCaptureBroken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearWebDisplayCaptureBroken();
});

describe("screen-share path selection", () => {
  it("uses web display capture when the browser really implements it", () => {
    expect(resolveScreenSharePath(env())).toBe("web");
    // Android that advertises a working API and has not failed before: try the
    // web path first (no extra app needed when it works).
    expect(resolveScreenSharePath(env({ android: true }))).toBe("web");
  });

  it("routes an Android browser without display capture to the native companion, never to 'unsupported'", () => {
    const path = resolveScreenSharePath(env({ android: true, webApi: false }));
    expect(path).toBe("android-native");
    expect(path).not.toBe("unsupported");
    // Once a real attempt proved the API useless on this device, go straight
    // to the companion.
    expect(resolveScreenSharePath(env({ android: true, webKnownBroken: true }))).toBe("android-native");
  });

  it("never advertises browser capture on a device that does not have it", () => {
    // iOS Safari has no display capture and no companion.
    expect(resolveScreenSharePath(env({ ios: true, webApi: false }))).toBe("unsupported");
    const msg = unsupportedScreenShareMessage(env({ ios: true, webApi: false }));
    expect(msg).toContain("اندروید");
    // A desktop browser without the API: honest message, no Android claim.
    const desktop = unsupportedScreenShareMessage(env({ webApi: false }));
    expect(desktop).toContain("پشتیبانی نمی‌کند");
  });

  it("an embedded frame can do neither and says so", () => {
    expect(resolveScreenSharePath(env({ embedded: true }))).toBe("unsupported");
    expect(resolveScreenSharePath(env({ embedded: true, android: true }))).toBe("unsupported");
    expect(unsupportedScreenShareMessage(env({ embedded: true }))).toContain("جاسازی");
  });
});

describe("web capture capability memory", () => {
  it("remembers only a real failure, and forgets it after a real success", () => {
    // An Android device that ADVERTISES the API but has not been tried yet.
    const live = () => env({ android: true, webKnownBroken: webDisplayCaptureKnownBroken() });
    expect(webDisplayCaptureKnownBroken()).toBe(false);
    expect(resolveScreenSharePath(live())).toBe("web");

    markWebDisplayCaptureBroken();
    expect(webDisplayCaptureKnownBroken()).toBe(true);
    // …and now the same device goes straight to the companion.
    expect(resolveScreenSharePath(live())).toBe("android-native");

    // A web capture that really produced a track proves the path works again.
    clearWebDisplayCaptureBroken();
    expect(webDisplayCaptureKnownBroken()).toBe(false);
    expect(resolveScreenSharePath(live())).toBe("web");
  });

  it("reads the live environment from the browser", () => {
    const md = {
      getDisplayMedia: () => Promise.resolve({} as unknown as MediaStream),
      enumerateDevices: () => Promise.resolve([]),
      getUserMedia: () => Promise.resolve({} as unknown as MediaStream),
    };
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile",
      configurable: true,
    });
    Object.defineProperty(window.navigator, "mediaDevices", { value: md, configurable: true });
    const read = currentShareEnvironment();
    expect(read.android).toBe(true);
    expect(read.embedded).toBe(false);
    // The probe reflects what the device really exposes, rather than
    // assuming Android means "no capture API".
    expect(read.webApi).toBe(true);
    expect(resolveScreenSharePath(read)).toBe("web");

    // …and without the API (the Chrome-Android reality) it routes natively.
    Object.defineProperty(window.navigator, "mediaDevices", {
      value: { enumerateDevices: md.enumerateDevices, getUserMedia: md.getUserMedia },
      configurable: true,
    });
    const noApi = currentShareEnvironment();
    expect(noApi.webApi).toBe(false);
    expect(resolveScreenSharePath(noApi)).toBe("android-native");
  });
});

describe("Android companion launch URL", () => {
  const code = "Z".repeat(43);

  it("carries ONLY the opaque one-time code — never a token, JWT or server URL", () => {
    const url = androidCompanionLaunchUrl(code, "https://app.example/call");
    expect(url.startsWith("intent://share?")).toBe(true);
    expect(url).toContain(`scheme=${ANDROID_COMPANION_SCHEME}`);
    expect(url).toContain(`package=${ANDROID_COMPANION_PACKAGE}`);
    expect(url).toContain(encodeURIComponent("https://app.example/call"));
    expect(decodeURIComponent(url)).toContain(`code=${code}`);
    // No credentials and no attacker-chosen endpoint of any kind.
    for (const forbidden of ["token", "jwt", "secret", "key=", "server=", "credentials"]) {
      expect(url.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("falls back to a safe in-app URL when no valid fallback is given", () => {
    const url = androidCompanionLaunchUrl(code, "javascript:alert(1)");
    expect(url).not.toContain("javascript");
    expect(decodeURIComponent(url)).toContain("browser_fallback_url=https://localhost/");
  });

  it("points users to the bundled guide rather than an unverified store listing", () => {
    expect(ANDROID_COMPANION_INSTALL_URL).toBe("/screen-share-help.html");
  });
});
