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

/**
 * PUT a blob to a Convex storage upload URL and return the storageId to store
 * on the message. Convex returns the id as JSON (`{storageId}`); older builds
 * sent it back in an `x-convex-storage-id` header — handle both.
 */
export async function putStorageFile(uploadUrl: string, blob: Blob): Promise<string> {
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!res.ok) throw new Error("upload_failed");
  const headerId = res.headers.get("x-convex-storage-id");
  if (headerId) return headerId;
  const json: unknown = await res.json().catch(() => null);
  const sid = (json as { storageId?: string } | null)?.storageId;
  if (!sid) throw new Error("no_storage_id");
  return sid;
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

/** Records until `stop()` is called; tracks elapsed ms. */
export function startRecording(opts?: {
  onTick?: (ms: number) => void;
  onError?: (msg: string) => void;
}): {
  stop: () => Promise<VoiceRecording>;
  cancel: () => void;
} {
  const mimeType = pickRecordingMime() || "audio/webm";
  let rec: MediaRecorder;
  let stream: MediaStream | null = null;
  let resolveStop: ((r: VoiceRecording) => void) | null = null;
  let rejectStop: ((e: Error) => void) | null = null;
  const chunks: BlobPart[] = [];
  const started = Date.now();
  let timer: number | null = null;

  const stopP = new Promise<VoiceRecording>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });

  const begin = async () => {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      stream?.getTracks().forEach((t) => t.stop());
      if (timer != null) window.clearInterval(timer);
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType });
      resolveStop?.({ blob, durationMs: Date.now() - started, mimeType: blob.type });
    };
    rec.onerror = () => {
      stream?.getTracks().forEach((t) => t.stop());
      if (timer != null) window.clearInterval(timer);
      rejectStop?.(new Error("recorder_error"));
    };
    rec.start(250);
    timer = window.setInterval(() => opts?.onTick?.(Date.now() - started), 250);
  };

  void begin().catch((e) => {
    rejectStop?.(e as Error);
    opts?.onError?.((e as Error).name === "NotAllowedError" || (e as Error).name === "SecurityError"
      ? "دسترسی به میکروفون داده نشد"
      : "میکروفون در دسترس نیست");
  });

  return {
    stop: async () => {
      if (rec && rec.state !== "inactive") rec.stop();
      return await stopP;
    },
    cancel: () => {
      if (rec && rec.state !== "inactive") {
        rec.ondataavailable = null;
        rec.onstop = null;
        try {
          rec.stop();
        } catch {
          /* noop */
        }
      }
      stream?.getTracks().forEach((t) => t.stop());
      if (timer != null) window.clearInterval(timer);
      rejectStop?.(new Error("cancelled"));
    },
  };
}
