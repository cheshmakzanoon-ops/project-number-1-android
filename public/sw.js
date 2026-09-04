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
const CACHE = "garma-shell-v4";
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

// Tapping the notification opens (or focuses) the app, which then shows the
// full in-app incoming-call screen via the normal Convex subscription.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow("/");
    }),
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