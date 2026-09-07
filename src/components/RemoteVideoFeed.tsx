import { useEffect, useRef, useState, type CSSProperties } from "react";
// Type-only import: the app shell must never load livekit-client eagerly —
// RemoteVideoTrack objects already exist (the caller got them from the loaded
// SDK module), this component only binds them to a <video> element.
import type { RemoteVideoTrack } from "livekit-client";

export type RemoteVideoSource = "camera" | "screen";

/** Playback state of the current visible binding. */
type PlayState = "waiting" | "playing" | "failed";
/** First-frame evidence kind: "rvfc" = requestVideoFrameCallback observed a
 *  presented frame, "fallback" = decoded-dimension/clock evidence, "none" =
 *  attached but no frame observed yet. */
type FrameEvidence = "none" | "rvfc" | "fallback";

interface PlaybackEvidence {
  play: PlayState;
  frame: FrameEvidence;
  /** A user click can retry playback (browser blocked the muted autoplay). */
  retryable: boolean;
  /** Sanitized diagnostic (error name/code only — never raw SDK objects,
   *  streams, tokens, SDP or identifiers). */
  diag: string | null;
}

const INITIAL_EVIDENCE: PlaybackEvidence = {
  play: "waiting",
  frame: "none",
  retryable: false,
  diag: null,
};

/** Extra diagnostics only when VITE_CALL_VIDEO_DEBUG=1; otherwise silent. */
const CALL_VIDEO_DEBUG = import.meta.env.VITE_CALL_VIDEO_DEBUG === "1";

function sanitizeDiagnostic(err: unknown): string | null {
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name) return `err:${name.slice(0, 60)}`;
  }
  return null;
}

function isNotAllowedPlayback(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const name = (err as { name?: unknown }).name;
    return name === "NotAllowedError";
  }
  return false;
}

/**
 * Owns exactly one SDK video-element binding for a remote participant's
 * camera or screen track.
 *
 * - While `visible`, it calls `RemoteVideoTrack.attach(element)` so the SDK's
 *   adaptive-stream observation and receiver start; while hidden it mounts
 *   nothing remote (reception pauses without touching mics or publications).
 * - Cleanup detaches only THIS element (never argumentless `detach()`, which
 *   would rip the same track off another visible element), and never stops
 *   tracks, unsubscribes, or disconnects.
 * - Playback evidence stays separate from `camOn`/`screenOn`/call phase: a
 *   fulfilled `play()` promise proves playback started, NOT that a decoded
 *   frame was presented — that is the first-frame marker's job.
 */
export function RemoteVideoFeed({
  track,
  source,
  visible,
  className,
  style,
}: {
  track: RemoteVideoTrack;
  source: RemoteVideoSource;
  /** Keep the component mounted while hidden, but attach no remote element. */
  visible: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Monotonic binding generation: every setup/cleanup bumps it so a late
  // play()/frame/statistics result from an old binding can never touch the
  // current one.
  const genRef = useRef(0);
  // The binding a click (playback retry) may act on — current visible one.
  const bindingRef = useRef<{
    gen: number;
    element: HTMLVideoElement;
    attached: boolean;
    visible: boolean;
  } | null>(null);
  const [evidence, setEvidence] = useState<PlaybackEvidence>(INITIAL_EVIDENCE);
  const evidenceRef = useRef(evidence);
  evidenceRef.current = evidence;

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    const capturedTrack = track;
    const gen = ++genRef.current;
    let active = true;
    // `owns`: this binding attempted (or completed) element attachment, so
    // disposal must detach even after a PARTIAL setup. `attached` additionally
    // means attach() itself succeeded (frame watch / playback / retry).
    let owns = false;
    let attached = false;
    let rafId: number | null = null;
    let fallbackTimer: number | null = null;
    let statsTimer: number | null = null;
    let statsPending = false;

    const isCurrent = () => active && genRef.current === gen;

    const setPlay = (
      play: PlayState,
      retryable: boolean,
      diag: string | null,
    ) => {
      if (!isCurrent()) return;
      setEvidence((prev) => ({ ...prev, play, retryable, diag }));
    };
    const setFrame = (frame: FrameEvidence) => {
      if (!isCurrent()) return;
      setEvidence((prev) => ({ ...prev, frame }));
    };
    const onElementError = () => {
      if (!isCurrent()) return;
      const code = element.error?.code;
      setPlay("failed", false, code != null ? `media:${code}` : "media:unknown");
    };
    const onPlaying = () => {
      if (!isCurrent()) return;
      setPlay("playing", false, null);
    };

    const startPlayback = () => {
      if (!isCurrent()) return;
      let p: unknown;
      try {
        p = element.play();
      } catch (err) {
        setPlay("failed", isNotAllowedPlayback(err), sanitizeDiagnostic(err));
        return;
      }
      if (p && typeof (p as PromiseLike<void>).then === "function") {
        (p as PromiseLike<void>).then(
          () => {
            // Playback STARTED — first-frame evidence is tracked separately.
            if (isCurrent()) setPlay("playing", false, null);
          },
          (err: unknown) => {
            if (!isCurrent()) return; // obsolete binding — never poison a new one
            if (isNotAllowedPlayback(err)) {
              setPlay("failed", true, sanitizeDiagnostic(err));
            } else {
              setPlay("failed", false, sanitizeDiagnostic(err));
            }
          },
        );
      }
      // Browsers without a play() promise cannot report rejection here; the
      // element's own events and frame evidence still cover the outcome.
    };

    /** Fallback first-frame evidence (no requestVideoFrameCallback): decoded
     *  dimensions plus an advancing clock — never `loadedmetadata` alone. */
    const scheduleFramePoll = () => {
      if (!isCurrent()) return;
      fallbackTimer = window.setTimeout(() => {
        fallbackTimer = null;
        if (!isCurrent()) return;
        if (element.videoWidth > 0 && element.currentTime > 0) {
          setFrame("fallback");
          return;
        }
        scheduleFramePoll();
      }, 250);
    };

    const registerFrameWatch = () => {
      const rvfc = (
        element as HTMLVideoElement & {
          requestVideoFrameCallback?: (
            cb: (now: number, metadata: unknown) => void,
          ) => number;
        }
      ).requestVideoFrameCallback;
      if (typeof rvfc === "function") {
        try {
          const cb = () => {
            if (!isCurrent()) return;
            setFrame("rvfc");
          };
          rafId = rvfc.call(element, cb) ?? null;
          return;
        } catch {
          // fall through to the labelled fallback poll
        }
      }
      scheduleFramePoll();
    };

    const startStatsSampling = () => {
      if (!CALL_VIDEO_DEBUG) return;
      // At most one in-flight getReceiverStats() at a time, once per second.
      const sample = () => {
        if (!isCurrent() || statsPending) return;
        statsPending = true;
        capturedTrack
          .getReceiverStats()
          .then((s) => {
            if (!isCurrent()) return; // ignore late results after disposal
            const ev = evidenceRef.current;
            // Selected numeric/status fields only — no identifiers.
            console.debug("[call-video] receiverStats", {
              binding: `v${gen}`,
              source,
              play: ev.play,
              frame: ev.frame,
              attachedElements: capturedTrack.attachedElements.length,
              bytesReceived: s?.bytesReceived,
              framesReceived: s?.framesReceived,
              framesDecoded: s?.framesDecoded,
              frameWidth: s?.frameWidth,
              frameHeight: s?.frameHeight,
            });
          })
          .catch(() => {
            /* sampling is best-effort; never reschedule on failure */
          })
          .finally(() => {
            statsPending = false;
          });
      };
      statsTimer = window.setInterval(sample, 1000);
      void sample();
    };

    const dispose = () => {
      if (!active) return;
      active = false;
      genRef.current += 1; // invalidate every late async continuation
      if (statsTimer !== null) window.clearInterval(statsTimer);
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
      const rvfCancel = (
        element as HTMLVideoElement & {
          cancelVideoFrameCallback?: (handle: number) => void;
        }
      ).cancelVideoFrameCallback;
      if (rafId !== null && typeof rvfCancel === "function") {
        try {
          rvfCancel.call(element, rafId);
        } catch {
          /* noop */
        }
      }
      try {
        element.removeEventListener("error", onElementError);
      } catch {
        /* noop */
      }
      try {
        element.removeEventListener("playing", onPlaying);
      } catch {
        /* noop */
      }
      if (bindingRef.current?.gen === gen) bindingRef.current = null;
      if (owns) {
        owns = false;
        // Element-only teardown. Never argumentless detach() and never stop
        // the track — another element may legitimately show the same track.
        try {
          capturedTrack.detach(element);
        } catch {
          /* noop */
        }
        // Clear a stale srcObject without touching a newer binding (React runs
        // this cleanup before the next effect's attach on the same element).
        try {
          if (element.srcObject !== null) element.srcObject = null;
        } catch {
          /* noop */
        }
      }
    };

    bindingRef.current = { gen, element, attached: false, visible };

    if (!visible) {
      // Hidden: keep the component mounted but register no remote element.
      // Mics, publications and local previews are unaffected.
      return () => {
        active = false;
        genRef.current += 1;
        if (bindingRef.current?.gen === gen) bindingRef.current = null;
      };
    }

    try {
      element.muted = true;
      element.defaultMuted = true;
      element.playsInline = true;
      element.autoplay = true;
    } catch {
      /* noop */
    }
    try {
      element.addEventListener("error", onElementError);
      element.addEventListener("playing", onPlaying);
    } catch {
      /* noop */
    }
    setEvidence(INITIAL_EVIDENCE); // fresh playback/frame state per binding
    owns = true; // even a failed attach must dispose cleanly afterwards
    try {
      // Exactly track.attach(element): the SDK needs THIS element to observe
      // and start adaptive reception.
      capturedTrack.attach(element);
      attached = true;
      bindingRef.current = { gen, element, attached: true, visible };
    } catch (err) {
      // Never throw into the call UI's error boundary; dispose() still runs
      // after a partial setup.
      setPlay("failed", false, sanitizeDiagnostic(err));
    }
    if (attached) {
      registerFrameWatch();
      startPlayback();
      startStatsSampling();
    }
    return dispose;
  }, [track, visible]);

  /** User-gesture retry for an autoplay-blocked playback (browser refused the
   *  programmatic play()). Requests no permissions, tokens or reconnects — it
   *  only retries THIS element's own playback. */
  const retryPlayback = () => {
    const b = bindingRef.current;
    if (!b || !b.visible || !b.attached || genRef.current !== b.gen) return;
    const element = b.element;
    const gen = b.gen;
    const isCurrent = () => genRef.current === gen;
    setEvidence((prev) => ({ ...prev, play: "waiting", retryable: false, diag: null }));
    let p: unknown;
    try {
      p = element.play();
    } catch (err) {
      if (isCurrent()) {
        setEvidence((prev) => ({
          ...prev,
          play: "failed",
          retryable: isNotAllowedPlayback(err),
          diag: sanitizeDiagnostic(err),
        }));
      }
      return;
    }
    if (p && typeof (p as PromiseLike<void>).then === "function") {
      (p as PromiseLike<void>).then(
        () => {
          if (!isCurrent()) return;
          setEvidence((prev) => ({ ...prev, play: "playing" }));
        },
        (err: unknown) => {
          if (!isCurrent()) return;
          setEvidence((prev) => ({
            ...prev,
            play: "failed",
            retryable: isNotAllowedPlayback(err),
            diag: sanitizeDiagnostic(err),
          }));
        },
      );
    }
  };

  return (
    <>
      <video
        ref={videoRef}
        data-call-video={source === "camera" ? "remote-camera" : "remote-screen"}
        data-call-video-play={evidence.play}
        data-call-video-frame={evidence.frame}
        autoPlay
        playsInline
        muted
        className={className}
        style={style}
        aria-label={source === "camera" ? "تصویر دوربین" : "اشتراک صفحه"}
      />
      {evidence.play === "failed" && evidence.retryable && (
        <button
          type="button"
          onClick={retryPlayback}
          aria-label="پخش تصویر"
          className="absolute inset-0 z-10 m-auto flex h-fit w-fit items-center gap-2 rounded-full border border-white/15 bg-[#140b05]/85 px-4 py-2 text-sm font-bold text-white shadow-2xl backdrop-blur transition hover:bg-[#3a250f]/90 active:scale-95"
        >
          پخش تصویر
        </button>
      )}
    </>
  );
}
