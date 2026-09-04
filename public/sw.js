/* Garma service worker.
 * Network-first with a runtime cache fallback for same-origin GET requests.
 * Live data always comes fresh when online; when offline the last-known
 * response (or the app shell) is used. Only registered in production builds.
 */
const CACHE = "garma-shell-v2";
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
      // If the app is open and visible right now, skip the system
      // notification — the app is already showing its own ring screen.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (clients.some((c) => c.visibilityState === "visible")) return;

      await self.registration.showNotification(data.title || "گرما", {
        // Body comes from the server so the wording matches the call kind
        // (video vs audio); keep a fallback for older pushes.
        body: data.body || "تماس ورودی",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: `incoming-call-${data.callId ?? "x"}`, // newer rings replace older ones
        renotify: true,
        requireInteraction: true, // stays on screen until answered/dismissed
        vibrate: Array.isArray(data.vibrate) ? data.vibrate : [500, 200, 500, 200, 500],
        data: { callId: data.callId, kind: data.kind },
      });
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