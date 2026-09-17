/* Garma PWA shell and incoming-call notification actions.
 * Closed/locked-device delivery depends on browser permission and OS policy.
 * A website cannot promise native full-screen incoming-call behavior.
 */
const CACHE = "garma-shell-v7";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png",
  "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/icon-maskable.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith("garma-shell-") && key !== CACHE)
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()));
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

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Do not retain API responses, query-string commands, or arbitrary user media.
  const cacheable = !url.search && (SHELL.includes(url.pathname) || url.pathname.startsWith("/assets/"));
  if (!cacheable && req.mode !== "navigate") return;
  const response = fetch(req);
  if (cacheable) {
    event.waitUntil(response.then(async (res) => {
      if (res.ok) { const cache = await caches.open(CACHE); await cache.put(req, res.clone()); }
    }).catch(() => {})); // quota/network failures must not break an otherwise valid response
  }
  event.respondWith(response.catch(async () => {
    const cached = await caches.match(cacheable ? req : "/");
    if (cached) return cached;
    if (req.mode === "navigate") {
      const shell = await caches.match("/");
      if (shell) return shell;
    }
    return new Response("Offline. Reconnect and try again.", { status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }));
});
