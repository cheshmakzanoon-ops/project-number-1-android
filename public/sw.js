/* Garma PWA shell and incoming-call notification actions.
 * Closed/locked-device delivery depends on browser permission and OS policy.
 * A website cannot promise native full-screen incoming-call behavior.
 */
const CACHE = "garma-shell-dev";
const PRECACHE_ASSETS = []; // build-injected
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png",
  "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/icon-maskable.png", ...PRECACHE_ASSETS];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = (await caches.keys()).filter(key => key.startsWith("garma-shell-") && key !== CACHE);
    // Keep one previous shell while already-open tabs finish using its hashed
    // chunks. Updating a worker never reloads or interrupts an active call.
    for (const key of keys.slice(0, -1)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("push", (event) => {
  let data;
  try { data = event.data?.json(); } catch { return; }
  if (!data || data.type !== "incoming_call" || typeof data.callId !== "string") return;
  // Never ring for a push that spent minutes queued while the phone was offline.
  if (typeof data.timestamp === "number" && Date.now() - data.timestamp > 75_000) return;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (clients.some((client) => client.visibilityState === "visible")) return;
    await self.registration.showNotification(data.title || "گرما", {
      body: data.body || "تماس ورودی", icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
      tag: `incoming-call-${data.callId}`, renotify: true, requireInteraction: true,
      vibrate: [500, 200, 500, 200, 500],
      actions: [{ action: "accept", title: "پاسخ" }, { action: "decline", title: "رد" }],
      data: { callId: data.callId, kind: data.kind, timestamp: data.timestamp || Date.now() },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // action belongs to NotificationEvent, never to Notification.
  const action = event.action;
  const callId = typeof event.notification.data?.callId === "string" ? event.notification.data.callId : "";
  const isAction = callId && (action === "accept" || action === "decline");
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const usable = list.filter((c) => typeof c.focus === "function")
      .sort((a, b) => Number(b.focused) - Number(a.focused));
    // Deliver to exactly one tab. Broadcasting Accept made several clients
    // race to join under the same LiveKit identity and evict each other.
    for (const client of usable) {
      try {
        if (isAction) client.postMessage({ type: "call-action", callId, action });
        try { await client.focus(); } catch { /* command still delivered */ }
        return;
      } catch { /* closed/navigating client: try another, then cold launch */ }
    }
    const target = isAction ? `/?call=${encodeURIComponent(callId)}&callAction=${action}` : "/";
    await self.clients.openWindow(self.location.origin + target);
  })());
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // Authentication stays in the app, not in this worker or its cache.
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true })
    .then((clients) => { for (const client of clients) client.postMessage({ type: "push-subscription-changed" }); }));
});

async function networkWithDeadline(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try { return await fetch(request, { signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Private APIs, arbitrary media, and URL commands never enter the cache.
  const cacheable = !url.search && SHELL.includes(url.pathname);
  if (!cacheable && req.mode !== "navigate") return;
  event.respondWith((async () => {
    // Storage can be disabled or evicted while the worker is still active.
    const cache = await caches.open(CACHE).catch(() => null);
    const match = async (key) => { try { return await cache?.match(key); } catch { return undefined; } };
    // Vite asset names are content-addressed, so the precached copy is final.
    if (cacheable && url.pathname.startsWith("/assets/")) {
      const asset = await match(req);
      if (asset) return asset;
    }
    try {
      const response = await networkWithDeadline(req);
      if (!response.ok && req.mode === "navigate") {
        const shell = await match("/");
        if (shell) return shell;
      }
      if (response.ok && cacheable && cache) {
        try { await cache.put(req, response.clone()); } catch { /* quota: network still succeeds */ }
      }
      return response;
    } catch {
      const cached = await match(cacheable ? req : "/");
      if (cached) return cached;
      if (req.mode === "navigate") {
        const shell = await match("/");
        if (shell) return shell;
      }
      return new Response("آفلاین هستی؛ به اینترنت وصل شو و دوباره تلاش کن.", { status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
  })());
});
