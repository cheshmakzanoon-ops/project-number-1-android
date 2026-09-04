import type { Id } from "../convex/_generated/dataModel";

/**
 * A minimal copy of the signed-in identity, kept on the device.
 *
 * The very first thing the app does on load is ask the backend "who is this
 * device?" — but every returning user already knows the answer (they typed
 * their name on this exact phone and it was saved). Rendering the app shell
 * immediately from this cache while the `me` query refreshes in the
 * background turns a slow round-trip into an instant paint on repeat visits.
 * The cached identity is only ever a stand-in: the query result replaces it
 * the moment it arrives, and the cache is cleared when the server says the
 * device is unknown.
 */
export interface CachedIdentity {
  _id: Id<"users">;
  username: string;
  displayName: string;
  themeColor: string;
}

const KEY = "garma.identity";

export function loadCachedIdentity(): CachedIdentity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (
      v &&
      typeof v === "object" &&
      typeof (v as CachedIdentity)._id === "string" &&
      typeof (v as CachedIdentity).username === "string" &&
      typeof (v as CachedIdentity).displayName === "string" &&
      typeof (v as CachedIdentity).themeColor === "string"
    ) {
      return v as CachedIdentity;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCachedIdentity(id: CachedIdentity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    /* storage unavailable: cache is best-effort */
  }
}

export function clearCachedIdentity(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
