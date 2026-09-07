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
 * screen forever. So probe the candidate first: any non-5xx response means a
 * live server is behind it (Convex answers unknown GET paths with 4xx, which
 * is fine — the WebSocket upgrade that follows is what matters). A dead proxy
 * (5xx / network error / >2.5s hang) falls back to the canonical deployment
 * with no user-visible wait beyond the probe.
 */
async function resolveConvexUrl(): Promise<string> {
  const candidate = sandboxConvexCandidate();
  if (!candidate) return CONVEX_URL;
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(candidate, {
      cache: "no-store",
      mode: "cors",
      signal: ctrl.signal,
    });
    if (res.status < 500) return candidate;
  } catch {
    /* not reachable → canonical below */
  } finally {
    window.clearTimeout(t);
  }
  return CONVEX_URL;
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
  useEffect(() => {
    let mounted = true;
    void getConvexUrl().then((url) => {
      if (!mounted) return;
      setClient(new ConvexReactClient(url));
    });
    return () => {
      mounted = false;
    };
  }, []);

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
