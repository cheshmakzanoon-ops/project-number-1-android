/* Garma service worker.
 * Network-first with a runtime cache fallback for same-origin GET requests.
 * Live data always comes fresh when online; when offline the last-known
 * response (or the app shell) is used. Only registered in production builds.
 *
 * The cache name is the version stamp for the whole app shell (icons,
 * manifest, index.html). Bump it whenever those assets change — the browser
 * only re-installs this worker when sw.js itself changes bytes, and a fresh
 * cache name is what actually evicts stale icons/shell from phones that
 * already installed the app.
 */
const CACHE = "garma-shell-v6";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/icon-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ---- Incoming-call push (works while the app/tab is fully closed) ----
// No `sound` option is set on purpose: Android/Chrome then plays the PHONE'S
// OWN default notification sound for the ring, exactly like a native call.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    return;
  }
  if (data.type !== "incoming_call") return;

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Foreground client(s): the app itself shows the full ring screen
      // (in-app ringtone + vibrate), so a second system notification would
      // only double the noise. Every other state — closed, backgrounded,
      // screen locked — goes through the OS notification below, which is
      // exactly the "rings no matter what" path for an installed app.
      if (clients.some((c) => c.visibilityState === "visible")) return;

      // BEST-EFFORT TAKEOVER: the app is open but sitting behind another
      // app/tab. Focus its window so the in-app ring screen — which covers
      // the entire viewport — is what the user actually sees, instead of a
      // notification banner.
      //
      // Two hard web-platform limits remain, and no JavaScript can lift them:
      //   1. a CLOSED app cannot be launched from a push event (openWindow()
      //      requires a user gesture a push does not have);
      //   2. a full-screen takeover over another app, or on a locked/asleep
      //      screen, is Android's Full-Screen Intent / iOS CallKit — native
      //      APIs a PWA cannot reach. The notification below is the
      //      guaranteed path for both.
      for (const c of clients) {
        if (!("focus" in c)) continue;
        try {
          await c.focus();
        } catch {
          break; // focus refused; fall through to the notification
        }
        // Only trust focus when the window REALLY became visible; otherwise
        // the user would get no ring at all.
        await new Promise((r) => setTimeout(r, 120));
        const after = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        if (after.some((x) => x.visibilityState === "visible")) return;
        break;
      }

      const notif = {
        // Body comes from the server so the wording matches the call kind
        // (video vs audio); keep a fallback for older pushes.
        body: data.body || "تماس ورودی",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: `incoming-call-${data.callId ?? "x"}`, // newer rings replace older ones
        renotify: true,
        requireInteraction: true, // stays on screen until answered/dismissed
        vibrate: Array.isArray(data.vibrate) ? data.vibrate : [500, 200, 500, 200, 500],
        // WhatsApp-style action buttons. Chrome/Android renders these
        // directly on the notification: the user can answer or reject the
        // call without the app opening. FCM replaces any missing/unknown
        // action with "Open" (launches the app into the in-app ring), so a
        // payload without them keeps working on every browser.
        actions: data.callId
          ? [
              { action: "accept", title: "پاسخ" },
              { action: "decline", title: "رد" },
            ]
          : [],
        data: { callId: data.callId, kind: data.kind, timestamp: data.timestamp || Date.now() },
      };
      try {
        await self.registration.showNotification(data.title || "گرما", notif);
      } catch {
        // Some browsers reject when a previous identical-tag notification is
        // still showing with requireInteraction; retry after closing it.
        const existing = await self.registration.getNotifications({
          tag: notif.tag,
        });
        for (const n of existing) n.close();
        await self.registration.showNotification(data.title || "گرما", notif);
      }
    })(),
  );
});

// Tapping the notification body opens (or focuses) the app, which shows the
// full in-app incoming-call screen via the normal Convex subscription.
// Tapping «پاسخ» (Accept) or «رد» (Decline) ACTS from the notification: the
// command goes straight to a running app (postMessage), or — when no window
// is open — the app is launched with the command in the URL. Either way the
// app runs the same accept/decline code path as the on-screen buttons.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const action = event.notification.action; // "" for a plain tap, "accept"/"decline" for the buttons
  const data = event.notification.data || {};
  const callId = typeof data.callId === "string" ? data.callId : "";
  const isCallAction = !!callId && (action === "accept" || action === "decline");

  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const usable = list.filter((c) => "focus" in c);

      // A call action never means "just open the app": hand the command to a
      // running instance (no reload — media/camera state is preserved), and
      // only launch a fresh one when none is up. Every window is told; the
      // handler matches by call id, so extra copies are ignored.
      if (isCallAction) {
        for (const c of usable) {
          try {
            c.postMessage({ type: "call-action", callId, action });
          } catch {
            /* client may be mid-navigation; the launch below covers it */
          }
        }
        if (usable.length > 0) {
          try {
            await usable[0].focus();
          } catch {
            /* focus is best-effort; the command was delivered */
          }
          return;
        }
        await self.clients.openWindow(
          `${self.location.origin}/?call=${encodeURIComponent(callId)}&callAction=${action}`,
        );
        return;
      }

      // Plain tap on the notification body: just bring the app to the front.
      for (const c of usable) {
        if ("focus" in c) return c.focus();
      }
      await self.clients.openWindow("/");
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only handle same-origin requests; Convex WebSocket + API run on another host.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok || res.type === "opaque") {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || (req.mode === "navigate" ? caches.match("/") : undefined)),
      ),
  );
});