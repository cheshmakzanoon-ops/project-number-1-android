const KEY = "garma.device.token";
let sessionToken: string | undefined;

export function getDeviceToken(): string {
  if (sessionToken) return sessionToken;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return (sessionToken = saved);
  } catch { /* private/restricted storage: keep identity for this page session */ }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  sessionToken = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem(KEY, sessionToken); } catch { /* in-memory session */ }
  return sessionToken;
}
