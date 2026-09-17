/**
 * Client-side media helpers for گرما:
 * - images are downscaled + re-encoded to JPEG before upload (a 12MP photo
 *   becomes ~200–400KB instead of several MB),
 * - uploads go straight to Convex storage with the signed URL from
 *   `messages.uploadUrl`,
 * - voice notes are recorded with MediaRecorder (opus/webm where supported,
 *   the platform default otherwise — AAC/mp4 on Safari).
 */

export const MAX_IMAGE_DIM = 1600;
const JPEG_QUALITY = 0.82;

/** Downscale + re-encode an image file so uploads stay small and fast. */
export async function compressImage(file: Blob): Promise<Blob> {
  if (!file.size || file.size > 30 * 1024 * 1024) throw new Error("image_too_large_or_empty");
  const dataUrl = await readAsDataURL(file);
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no_canvas");
  ctx.fillStyle = "#1a1008";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("encode_failed"))),
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error ?? new Error("read_failed"));
    fr.onabort = () => reject(new Error("read_cancelled"));
    fr.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image_load_failed"));
    img.src = src;
  });
}

/** Create a local object URL from a picked file (revoked by the caller). */
export function objectUrlFor(blob: Blob): string {
  return URL.createObjectURL(blob);
}

/** Uploads use Convex's POST contract. The deadline also covers the response body. */
export const TRUSTED_UPLOAD_URL = "https://precise-ptarmigan-412.eu-west-1.convex.site/media/upload";
export async function putStorageFile(uploadUrl: string, blob: Blob, token: string): Promise<string> {
  if (uploadUrl !== TRUSTED_UPLOAD_URL || !token || token.length > 256) throw new Error("untrusted_upload_endpoint");
  if (!blob.size || blob.size > 10 * 1024 * 1024) throw new Error("file_too_large_or_empty");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream", Authorization: `Bearer ${token}` },
      credentials: "omit",
      redirect: "error",
      body: blob,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("upload_failed");
    const json: unknown = await res.json();
    const sid = (json as { storageId?: unknown } | null)?.storageId;
    if (typeof sid !== "string" || !sid.trim()) throw new Error("no_storage_id");
    return sid;
  } finally {
    clearTimeout(timeout);
  }
}

/** Format ms as m:ss with Persian digits, e.g. «۱:۰۴». */
export function formatDurationMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

export function mediaRecorderSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/** Pick the best supported audio mime type for recording. */
export function pickRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* noop */
    }
  }
  return "";
}

export interface VoiceRecording {
  blob: Blob;
  durationMs: number;
  mimeType: string;
}

/**
 * Permission requests can resolve after navigation. Cancellation owns every
 * eventual stream, not just the stream that existed when Cancel was pressed.
 */
export function startRecording(opts?: {
  onTick?: (ms: number) => void;
  onError?: (msg: string) => void;
}): {
  stop: () => Promise<VoiceRecording>;
  cancel: () => void;
} {
  let rec: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let settled = false;
  let stopping = false;
  let started = 0;
  let duration = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopDeadline: ReturnType<typeof setTimeout> | undefined;
  const chunks: Blob[] = [];
  let resolveStop!: (r: VoiceRecording) => void;
  let rejectStop!: (e: Error) => void;
  const result = new Promise<VoiceRecording>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });
  // A permission denial/cancel may occur before anyone calls stop(). Keep
  // the original promise rejected for its caller without an unhandled rejection.
  void result.catch(() => {});

  const release = () => {
    clearInterval(timer);
    clearTimeout(permissionDeadline);
    clearTimeout(stopDeadline);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };
  const fail = (error: Error, notify = true) => {
    if (settled) return;
    settled = true;
    if (rec) {
      rec.ondataavailable = rec.onstop = rec.onerror = null;
      try { if (rec.state !== "inactive") rec.stop(); } catch { /* already stopped */ }
    }
    release();
    rejectStop(error);
    if (notify) opts?.onError?.(error.name === "NotAllowedError" || error.name === "SecurityError"
      ? "دسترسی به میکروفون داده نشد"
      : "ضبط صدا متوقف شد؛ دسترسی میکروفون را بررسی و دوباره تلاش کن.");
  };
  const stop = (): Promise<VoiceRecording> => {
    if (settled || stopping) return result;
    stopping = true;
    if (!rec) {
      fail(new Error("recording_not_started"), false);
      return result;
    }
    duration = Math.max(0, Date.now() - started);
    clearInterval(timer);
    stopDeadline = setTimeout(() => fail(new Error("recorder_stop_timeout")), 5_000);
    try { if (rec.state !== "inactive") rec.stop(); } catch (e) { fail(e as Error); }
    // Stop gathering immediately, while the queued dataavailable/stop events
    // finish encoding. A call must not contend with this recorder for the mic.
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    return result;
  };
  const permissionDeadline = setTimeout(() => fail(new Error("microphone_timeout")), 30_000);
  void (async () => {
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (settled) {
      acquired.getTracks().forEach((track) => track.stop());
      return;
    }
    stream = acquired;
    clearTimeout(permissionDeadline);
    const mime = pickRecordingMime();
    rec = new MediaRecorder(acquired, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = (e) => { if (!settled && e.data.size) chunks.push(e.data); };
    rec.onerror = () => fail(new Error("recorder_error"));
    rec.onstop = () => {
      if (settled) return;
      duration = stopping ? duration : Math.max(0, Date.now() - started);
      const blob = new Blob(chunks, { type: rec?.mimeType || chunks[0]?.type || mime });
      if (!blob.size) { fail(new Error("empty_recording")); return; }
      settled = true;
      release();
      resolveStop({ blob, durationMs: duration, mimeType: blob.type });
    };
    rec.start(250);
    started = Date.now();
    timer = setInterval(() => opts?.onTick?.(Date.now() - started), 250);
  })().catch((e: unknown) => fail(e instanceof Error ? e : new Error("microphone_unavailable")));
  return { stop, cancel: () => fail(new Error("cancelled"), false) };
}
