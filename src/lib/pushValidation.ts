export function validPushSubscription(endpoint: string, p256dh: string, auth: string): boolean {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    const trusted = host === "fcm.googleapis.com" || host === "web.push.apple.com" ||
      host === "updates.push.services.mozilla.com" || host.endsWith(".push.services.mozilla.com") ||
      host.endsWith(".notify.windows.com");
    return trusted && url.protocol === "https:" && !url.port && !url.username && !url.password &&
      !url.hash && endpoint.length <= 4096 && /^[A-Za-z0-9_-]{87}=?$/.test(p256dh) &&
      /^[A-Za-z0-9_-]{22}={0,2}$/.test(auth);
  } catch { return false; }
}
