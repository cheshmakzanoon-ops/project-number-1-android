const KEY = "garma.device.token";

export function getDeviceToken(): string {
  const existing = localStorage.getItem(KEY);
  if (existing) return existing;
  // no crypto available? fall back to random
  let id = existing ?? "";
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (c && c.randomUUID) {
    id = c.randomUUID();
  } else {
    id = "tok-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  localStorage.setItem(KEY, id);
  return id;
}