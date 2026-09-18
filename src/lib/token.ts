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

export function deviceTokenPersists(): boolean {
  try { return !!sessionToken && localStorage.getItem(KEY) === sessionToken; }
  catch { return false; }
}

let inviteCache: string | undefined;
/** Invite fragments are removed before rendering; never place invites in query strings. */
export function getFamilyInvite(): string {
  if (inviteCache !== undefined) return inviteCache;
  try {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const invite = params.get("invite");
    if (invite !== null) {
      params.delete("invite");
      const fragment = params.toString();
      window.history.replaceState(null, "", window.location.pathname + window.location.search + (fragment ? `#${fragment}` : ""));
      inviteCache = /^[A-Za-z0-9_-]{4,128}$/.test(invite) ? invite : "";
      try { sessionStorage.setItem("garma.pending-invite", inviteCache); } catch { /* page memory */ }
      return inviteCache;
    }
    inviteCache = sessionStorage.getItem("garma.pending-invite") ?? "";
  } catch { inviteCache = ""; }
  return inviteCache;
}
export function clearFamilyInvite(): void {
  inviteCache = "";
  try { sessionStorage.removeItem("garma.pending-invite"); } catch { /* page memory */ }
}
