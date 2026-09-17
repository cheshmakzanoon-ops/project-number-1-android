import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { mediaRecorderSupported, startRecording, type VoiceRecording } from "./media";

type Phase = "idle" | "recording" | "stopping" | "sending" | "retry";
type Owner = { mounted: boolean; epoch: number; blocked: boolean; busy: boolean;
  handle: ReturnType<typeof startRecording> | null; pending: VoiceRecording | null;
  phase: Phase; milliseconds: number; note: string | null };

/** A conversation owns its recorder and every late result; a call takes priority. */
export function useVoiceComposer({ scope, blocked, busy, onSend, onError }: {
  scope: string; blocked: boolean; busy: boolean;
  onSend: (recording: VoiceRecording) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const [, redraw] = useState(0);
  const owner = useMemo<Owner>(() => ({ mounted: false, epoch: 0, blocked, busy,
    handle: null, pending: null, phase: "idle", milliseconds: 0, note: null }), [scope]);
  owner.blocked = blocked; owner.busy = busy;
  const callbacks = useRef({ onSend, onError });
  callbacks.current = { onSend, onError };
  const paint = useCallback(() => { if (owner.mounted) redraw(value => value + 1); }, [owner]);
  const current = useCallback((epoch: number) => owner.mounted && owner.epoch === epoch, [owner]);
  const clear = useCallback(() => {
    owner.epoch++;
    owner.handle?.cancel(); owner.handle = null;
    owner.pending = null; owner.phase = "idle"; owner.milliseconds = 0; owner.note = null;
    paint();
  }, [owner, paint]);

  // Stop synchronously before a call asks for the microphone. Only the final
  // encoded blob is awaited, and it stays a draft until an explicit later Send.
  const suspend = useCallback((note = "ضبط برای تماس متوقف شد؛ پس از تماس می‌توانی آن را ارسال کنی.") => {
    if (!owner.mounted || !owner.handle || owner.phase === "stopping") return;
    const handle = owner.handle;
    const epoch = ++owner.epoch;
    owner.phase = "stopping"; owner.note = note; paint();
    void handle.stop().then(recording => {
      if (!current(epoch)) return;
      owner.handle = null; owner.pending = recording;
      owner.milliseconds = recording.durationMs; owner.phase = "retry"; paint();
    }, () => {
      if (!current(epoch)) return;
      owner.handle = null; owner.phase = "idle"; owner.milliseconds = 0; owner.note = null; paint();
    });
  }, [current, owner, paint]);

  const start = useCallback(() => {
    if (!owner.mounted || owner.blocked || owner.busy || owner.phase !== "idle" || !mediaRecorderSupported()) return;
    const epoch = ++owner.epoch;
    owner.milliseconds = 0; owner.note = null; owner.phase = "recording";
    try {
      owner.handle = startRecording({
        onTick: milliseconds => {
          if (!current(epoch)) return;
          owner.milliseconds = milliseconds; paint();
          if (milliseconds >= 290_000) suspend("ضبط به پایان رسید؛ برای فرستادن دکمهٔ ارسال را بزن.");
        },
        onError: message => {
          if (!current(epoch)) return;
          owner.handle = null; owner.phase = "idle"; owner.milliseconds = 0; paint();
          callbacks.current.onError(message);
        },
      });
      paint();
    } catch {
      owner.handle = null; owner.phase = "idle"; paint();
      callbacks.current.onError("ضبط صدا ممکن نیست — میکروفون را بررسی کن");
    }
  }, [current, owner, paint, suspend]);

  const finish = useCallback(async () => {
    if (!owner.mounted || owner.blocked || owner.busy || !["recording", "retry"].includes(owner.phase)) return;
    const handle = owner.handle;
    if (!handle && !owner.pending) return;
    const send = callbacks.current.onSend;
    const epoch = ++owner.epoch;
    owner.phase = "sending"; owner.note = null; paint();
    try {
      const recording = owner.pending ?? await handle!.stop();
      if (!current(epoch)) return;
      owner.handle = null; owner.pending = recording; owner.milliseconds = recording.durationMs;
      if (owner.blocked) { owner.phase = "retry"; paint(); return; }
      if (recording.durationMs < 900) {
        clear(); callbacks.current.onError("ضبط خیلی کوتاه بود — دوباره امتحان کن"); return;
      }
      const sent = await send(recording);
      if (!current(epoch)) return;
      if (sent) clear();
      else { owner.phase = "retry"; paint(); }
    } catch {
      if (!current(epoch)) return;
      owner.handle = null;
      owner.phase = owner.pending ? "retry" : "idle";
      paint(); callbacks.current.onError("ارسال یا ضبط کامل نشد — دوباره تلاش کن");
    }
  }, [clear, current, owner, paint]);

  useLayoutEffect(() => {
    owner.mounted = true;
    const hide = () => { if (document.visibilityState === "hidden") suspend("ضبط متوقف شد؛ فایل ضبط‌شده برای ارسال نگه داشته شده است."); };
    document.addEventListener("visibilitychange", hide);
    return () => {
      owner.mounted = false; owner.epoch++;
      owner.handle?.cancel(); owner.handle = null;
      document.removeEventListener("visibilitychange", hide);
    };
  }, [owner, suspend]);
  useLayoutEffect(() => { if (blocked) suspend(); }, [blocked, suspend]);

  return { phase: owner.phase, milliseconds: owner.milliseconds, note: owner.note,
    start, cancel: clear, finish, suspend };
}
