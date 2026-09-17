/**
 * Lazily loads the LiveKit client library.
 *
 * livekit-client is the single heaviest dependency in the app — roughly a
 * third of the entire JS bundle. It is only needed once a call actually
 * starts, so loading it on demand keeps the app shell (signup / lobby /
 * chat) from parsing it. The service worker precaches the compiled chunk
 * after installation so a later call is not blocked by a missing asset.
 */

export type LiveKitModule = typeof import("livekit-client");

let cached: LiveKitModule | null = null;
let pending: Promise<LiveKitModule> | null = null;

/** Start (and cache) the fetch of the LiveKit bundle. */
export function loadLiveKit(): Promise<LiveKitModule> {
  if (!pending) {
    pending = import("livekit-client").then((m) => {
      cached = m;
      return m;
    }).catch((error: unknown) => {
      // Network/chunk failures must not poison every subsequent redial.
      pending = null;
      throw error;
    });
  }
  return pending;
}

/**
 * Synchronous access to the loaded module. Safe to call only once a Room
 * exists (or while a connect is in flight) — every code path that touches
 * LiveKit objects runs after loadLiveKit() has resolved.
 */
export function livekit(): LiveKitModule {
  if (!cached) throw new Error("livekit_not_loaded");
  return cached;
}
