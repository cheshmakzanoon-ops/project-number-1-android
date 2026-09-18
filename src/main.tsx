import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "./lib/ErrorBoundary";

/**
 * The app talks to ONE Convex Cloud deployment. There is no .env indirection
 * for the backend URL, on purpose: a build-environment default can never
 * silently redirect the app to a wrong backend. The URL is hard-coded inline
 * to keep module top-level code ordering-independent (safe under
 * minification, no temporal-dead-zone risk).
 */
const CONVEX_URL = "https://precise-ptarmigan-412.eu-west-1.convex.cloud";

/**
 * In the Freebuff preview the app and a local Convex dev server can share the
 * same proxy host with different port prefixes (e.g. 5173-<workspace>… vs
 * 3210-<workspace>…). Return that derived URL when the host looks like a
 * sandbox preview host, else null (deployed app talks straight to CONVEX_URL).
 */
function sandboxConvexCandidate(): string | null {
  if (typeof window !== "undefined" && window.location) {
    const host = window.location.hostname;
    const dash = host.indexOf("-");
    if (dash > 0 && !isNaN(Number(host.slice(0, dash)))) {
      return `https://3210${host.slice(dash)}`;
    }
  }
  return null;
}

/**
 * Pick a Convex URL the browser can actually reach.
 *
 * The 3210 local-proxy URL is only usable when a Convex dev server is really
 * listening there. Newer `convex dev` builds target the linked cloud
 * deployment directly and never open port 3210 — in that case the derived URL
 * answers with a proxy 502 and the app would sit on the "can't connect"
 * screen forever. So probe the candidate first, and demand a real Convex
 * answer: the standard `/version` endpoint returns 200 with a short plain-text
 * version body, while a proxy with nothing behind the port answers with an
 * error page (or 200 + HTML). Only a non-empty, non-HTML 200 is treated as a
 * live backend — a status-code-only check let a dead sandbox URL through, and
 * the app then pointed its WebSocket at it and showed "اتصال برقرار نشد" even
 * though the canonical deployment was reachable. A dead candidate falls back
 * with no user-visible wait beyond the probe.
 */
async function resolveConvexUrl(): Promise<string> {
  const candidate = import.meta.env.DEV ? sandboxConvexCandidate() : null;
  if (!candidate) return CONVEX_URL;
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${candidate}/version`, {
      cache: "no-store",
      mode: "cors",
      signal: ctrl.signal,
    });
    if (res.ok) {
      const body = (await res.text()).trim();
      if (body && !body.startsWith("<")) return candidate;
    }
  } catch {
    /* not reachable → canonical below */
  } finally {
    window.clearTimeout(t);
  }
  return CONVEX_URL;
}

// External fonts stay optional, asynchronous, and compatible with script-src self.
for (const link of document.querySelectorAll<HTMLLinkElement>('link[data-async-font]')) {
  if (link.sheet) link.media = "all";
  else link.addEventListener("load", () => { link.media = "all"; }, { once: true });
}

// Resolved once per page load and reused across StrictMode double-effects.
let convexUrlPromise: Promise<string> | null = null;
function getConvexUrl(): Promise<string> {
  convexUrlPromise ??= resolveConvexUrl();
  return convexUrlPromise;
}

/** Service worker: makes the app installable as a home-screen app and keeps a
 * working shell offline. Registered in every environment (including the dev
 * preview) so the browser treats the page as installable and fires
 * `beforeinstallprompt` — without it the in-app install offer would never
 * appear when someone opens the app URL in the preview. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // updateViaCache: "none" makes the browser re-fetch sw.js on every load
    // instead of serving it from the HTTP cache — that byte comparison is
    // what triggers a new worker install, and a new install is what swaps
    // the app shell cache (icons/manifest/theme) on phones that installed
    // the app before a rebrand. Without it an updated icon set could keep
    // serving the old cached one for weeks.
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .catch(() => {});
  });
}

/** Boots the Convex client only after the backend URL is actually known. */
function Root() {
  const [client, setClient] = useState<ConvexReactClient | null>(null);
  const [bootFailed, setBootFailed] = useState(false);
  useEffect(() => {
    let mounted = true;
    let ownedClient: ConvexReactClient | null = null;
    void getConvexUrl().then((url) => {
      if (!mounted) return;
      ownedClient = new ConvexReactClient(url);
      setClient(ownedClient);
    }).catch(() => { if (mounted) setBootFailed(true); });
    return () => {
      mounted = false;
      void ownedClient?.close();
    };
  }, []);

  if (bootFailed) throw new Error("backend_client_start_failed");
  if (!client) {
    // Brief warm-up splash (theme base #1a1008). The app's own loading pulse
    // takes over the moment the client is ready.
    return (
      <div
        style={{ background: "#1a1008" }}
        className="grid h-full w-full place-items-center"
      >
        <div className="h-10 w-10 animate-pulse rounded-full bg-ember-400/50" />
      </div>
    );
  }

  return (
    <ConvexProvider client={client}>
      <App />
    </ConvexProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* A crash anywhere (render, effect, Convex query) shows a recovery panel
        instead of unmounting the tree onto the dark page behind it — which
        otherwise reads as a frozen black screen on phones. */}
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);
