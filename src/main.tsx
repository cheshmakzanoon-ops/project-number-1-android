import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import "./index.css";
import { App } from "./App";

const address = resolveConvexUrl();
const client = new ConvexReactClient(address);

/**
 * Pick a Convex URL the browser can actually reach.
 * - In production the build gets a real VITE_CONVEX_URL.
 * - In the Freebuff preview, the local Convex dev server runs on port 3210 of
 *   the same proxy host as the app (e.g. https://3210-<workspace>.…net), so we
 *   derive that from window.location instead of the container-local localhost.
 */
// Service worker makes the app installable as a home-screen app and keeps a
// working shell offline. Registered only in production builds.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

function resolveConvexUrl(): string {
  // Freebuff sandbox preview: the host looks like "5173-<workspace>…", and the
  // matching local Convex dev server is exposed on the same proxy host with the
  // "3210" port prefix, so point the app there in the sandbox.
  if (typeof window !== "undefined" && window.location) {
    const host = window.location.hostname;
    const dash = host.indexOf("-");
    if (dash > 0 && !isNaN(Number(host.slice(0, dash)))) {
      return `https://3210${host.slice(dash)}`;
    }
  }
  // Everywhere else — including the deployed app — talk to the single Convex
  // Cloud backend. This deliberately ignores any injected VITE_CONVEX_URL so a
  // build environment's default can never silently redirect the app to a wrong
  // backend. The URL is hard-coded inline to keep the module's top-level call
  // ordering-independent (safe under minification, no temporal-dead-zone risk).
  return "https://precise-ptarmigan-412.eu-west-1.convex.cloud";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={client}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
