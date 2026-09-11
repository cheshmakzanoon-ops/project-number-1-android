/**
 * Explicit ownership model for the call lifecycle.
 *
 * A callId alone cannot identify every asynchronous operation: several
 * connection attempts can belong to the same call, and a cancelled operation
 * can outlive the component that started it. Every asynchronous piece of call
 * work therefore carries its own owner identity:
 *
 * - `CallOwner`  — one locally adopted call lifecycle (the whole call).
 * - `OpHandle`   — one operation inside that lifecycle: a room connect, a
 *                  camera capture, a screen share, a camera switch…
 *
 * Rules encoded here (see the repair contract):
 * - Ending a call disposes its owner synchronously; a disposed owner never
 *   becomes current again.
 * - An obsolete operation may dispose of ITS OWN resources, never another
 *   owner's.
 * - A timeout (deadline) is not cancellation: the underlying browser/SDK work
 *   keeps running, so its eventual result must be observed and released.
 * - Timers belong to an owner; an old timer clears only its own id.
 */

/** One local call lifecycle. The `seq` is the immutable identity; `callId`
 *  is null while the call is still being prepared (no server row yet) and is
 *  set exactly once when the server call id arrives. */
export interface CallOwner {
  readonly seq: number;
  /** Server call id once known; null during the preparing phase. */
  callId: string | null;
  readonly kind: "audio" | "video";
  /** Set synchronously the moment this lifecycle ends locally. */
  disposed: boolean;
}

let ownerSeq = 0;

export function createOwner(callId: string | null, kind: "audio" | "video"): CallOwner {
  ownerSeq += 1;
  return { seq: ownerSeq, callId, kind, disposed: false };
}

/** What kind of work an operation represents. */
export type OpKind = "connect" | "camera" | "share" | "switch" | "accept" | "start";

/** One asynchronous operation inside a call lifecycle. The `id` is the
 *  immutable identity used to decide whether a late completion may act. */
export interface OpHandle {
  readonly id: number;
  readonly owner: CallOwner;
  readonly kind: OpKind;
  /** True once this operation was abandoned (superseded or cancelled). */
  cancelled: boolean;
}

let opSeq = 0;

export function createOp(owner: CallOwner, kind: OpKind): OpHandle {
  opSeq += 1;
  return { id: opSeq, owner, kind, cancelled: false };
}

/** True only when `op` is still THE current operation of its kind and its
 *  owner has not been disposed — an obsolete completion must never act. */
export function opCurrent(op: OpHandle | null | undefined, current: OpHandle | null | undefined): boolean {
  return !!op && op === current && !op.cancelled && !op.owner.disposed;
}

/** Cancel an operation: idempotent, synchronous. */
export function cancelOp(op: OpHandle | null | undefined): void {
  if (op) op.cancelled = true;
}

/**
 * Owner-scoped timer registry. Every timeout/interval of a call lifecycle is
 * registered here, so teardown can clear ALL of them at once while an old
 * callback clearing "its own" id can never clear a newer owner's timer
 * (ids live in this registry only while their own timer is pending).
 */
export class TimerRegistry {
  private timeouts = new Set<number>();
  private intervals = new Set<number>();

  setTimeout(cb: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.timeouts.delete(id);
      cb();
    }, ms);
    this.timeouts.add(id);
    return id;
  }

  setInterval(cb: () => void, ms: number): number {
    const id = window.setInterval(cb, ms);
    this.intervals.add(id);
    return id;
  }

  clearTimeout(id: number | null | undefined): void {
    if (id == null) return;
    // Only clear ids this registry actually owns.
    if (!this.timeouts.delete(id)) return;
    window.clearTimeout(id);
  }

  clearInterval(id: number | null | undefined): void {
    if (id == null) return;
    if (!this.intervals.delete(id)) return;
    window.clearInterval(id);
  }

  /** Clear every pending timer of this owner (teardown). */
  clearAll(): void {
    for (const id of this.timeouts) window.clearTimeout(id);
    for (const id of this.intervals) window.clearInterval(id);
    this.timeouts.clear();
    this.intervals.clear();
  }
}

/**
 * Reject after `ms` so a hung promise can never wedge the caller.
 *
 * A timeout is NOT cancellation of the underlying work: whatever `p` holds
 * (a getUserMedia capture, a room connect…) keeps running and may still
 * produce a result. Callers that own a resource behind `p` should use
 * {@link deadline} instead, which hands them the late result so it can be
 * released; this plain wrapper is only for promises whose late result needs
 * no disposal (a token fetch, a connect on a room that is discarded anyway).
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (ok: boolean, v: T | Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(t);
      if (ok) resolve(v as T);
      else reject(v as Error);
    };
    const t = window.setTimeout(() => finish(false, new Error(label)), ms);
    p.then(
      (v) => finish(true, v),
      (e) => finish(false, e instanceof Error ? e : new Error(String(e))),
    );
  });
}

/**
 * Bounded wait that OBSERVES the original promise.
 *
 * Returns the raced result plus a `late` promise that settles with the
 * original value/error only when the deadline won the race. The caller must
 * always attach a handler to `late` (typically to stop the captured track):
 * that is what makes a timeout different from cancellation — the work keeps
 * running, and its eventual result gets released instead of leaking.
 *
 * Exactly one side observes the value: if `p` settles before the deadline,
 * `result` carries it and `late` reports `{ late: false }`; if the deadline
 * fired first, `result` rejects with the label error and `late` hands over
 * the real outcome.
 */
export function deadline<T>(
  p: Promise<T>,
  ms: number,
  label = "timeout",
): {
  result: Promise<T>;
  late: Promise<{ late: false } | { late: true; value?: T; error?: unknown }>;
} {
  let timedOut = false;
  let timer: number | undefined;
  const result = new Promise<T>((resolve, reject) => {
    timer = window.setTimeout(() => {
      timedOut = true;
      reject(new Error(label));
    }, ms);
    p.then(
      (v) => {
        if (timedOut) return;
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (timedOut) return;
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });
  const late = p.then(
    (v) => (timedOut ? { late: true as const, value: v } : { late: false as const }),
    (e) => (timedOut ? { late: true as const, error: e } : { late: false as const }),
  );
  void result.catch(() => {}); // the caller handles rejection via `result`
  return { result, late };
}

/**
 * Stop one locally captured resource. Accepts the SDK wrappers
 * (LocalTrack has stop()) and raw browser tracks. Never throws; stopping an
 * already-stopped track is a no-op.
 */
export function safeStopTrack(track: { stop?: () => void } | null | undefined): void {
  if (!track || typeof track.stop !== "function") return;
  try {
    track.stop();
  } catch {
    /* idempotent */
  }
}

/**
 * Disconnect a room without letting a synchronous throw OR a rejected
 * promise escape as an unhandled rejection. `stopTracks` keeps LiveKit from
 * stopping local tracks a second time (the caller already released what it
 * owns); the default (true) is what hangup wants.
 */
export function safeDisconnect(room: { disconnect?: (stopTracks?: boolean) => Promise<void> | void } | null | undefined, stopTracks?: boolean): void {
  if (!room || typeof room.disconnect !== "function") return;
  try {
    const r = room.disconnect(stopTracks);
    if (r && typeof (r as Promise<void>).catch === "function") {
      (r as Promise<void>).catch(() => {});
    }
  } catch {
    /* disposal must never throw into the caller */
  }
}

/**
 * Result of a media-connect attempt:
 * - true: connected, media publishing.
 * - "retryable": transient failure (timeout, dead link) — retry in background.
 * - "unauthorized" / "livekit_not_configured": permanent — give up.
 * - "cancelled": the operation's owner was disposed (hangup, new call) or a
 *   newer attempt superseded it — intentionally cancelled work is never
 *   retried and never reported as an error.
 */
export type ConnectResult = true | "retryable" | "unauthorized" | "livekit_not_configured" | "cancelled";

/**
 * Classify a thrown error from the token action into a terminal result.
 * Everything else is an ordinary connectivity failure.
 */
export function classifyConnectError(e: unknown): "unauthorized" | "livekit_not_configured" | "retryable" {
  const msg = e instanceof Error ? e.message : "";
  if (msg === "livekit_not_configured") return "livekit_not_configured";
  if (msg === "unauthorized") return "unauthorized";
  return "retryable";
}
