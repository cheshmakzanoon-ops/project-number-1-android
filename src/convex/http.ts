import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { MAX_MEDIA_BYTES, allowedOrigin } from "./policy";
import type { Id } from "./_generated/dataModel";

/** Validate bytes, not just attacker-controlled MIME labels. No HTML/SVG uploads. */
export function mediaSignatureMatches(bytes: Uint8Array, mime: string): boolean {
  const ascii = (offset: number, value: string) => value.split("").every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (bytes.length < 12) return false;
  switch (mime) {
    case "image/jpeg": return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/png": return bytes[0] === 0x89 && ascii(1, "PNG\r\n\x1a\n");
    case "image/webp": return ascii(0, "RIFF") && ascii(8, "WEBP");
    case "audio/webm": return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    case "audio/mp4": return ascii(4, "ftyp");
    case "audio/ogg": return ascii(0, "OggS");
    case "audio/wav": return ascii(0, "RIFF") && ascii(8, "WAVE");
    default: return false;
  }
}

export { allowedOrigin } from "./policy";

/** Hard byte bound also applies when Content-Length is absent or dishonest. */
export async function readBoundedBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const size = request.headers.get("Content-Length");
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > MAX_MEDIA_BYTES)) throw new Error("file_too_large");
  if (!request.body) throw new Error("empty_file");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MEDIA_BYTES) { await reader.cancel(); throw new Error("file_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!total) throw new Error("empty_file");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

const upload = httpAction(async (ctx, request) => {
  const origin = request.headers.get("Origin");
  if (!allowedOrigin(origin)) return new Response("origin_not_allowed", { status: 403 });
  const headers = new Headers({ "Access-Control-Allow-Origin": origin!, "Vary": "Origin", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const respond = (value: object, status: number) => {
    const responseHeaders = new Headers(headers);
    responseHeaders.set("Content-Type", "application/json");
    return new Response(JSON.stringify(value), { status, headers: responseHeaders });
  };
  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers });
  }
  const token = request.headers.get("Authorization")?.match(/^Bearer ([!-~]{1,256})$/)?.[1];
  if (!token) return respond({ error: "unauthorized" }, 401);
  try { await ctx.runMutation(internal.uploads.authorize, { token }); }
  catch (error) { return respond({ error: /rate_limited/.test(String(error)) ? "rate_limited" : "unauthorized" }, /rate_limited/.test(String(error)) ? 429 : 401); }
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = await readBoundedBody(request); }
  catch (error) { return respond({ error: /file_too_large/.test(String(error)) ? "file_too_large" : "invalid_body" }, /file_too_large/.test(String(error)) ? 413 : 400); }
  const mime = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!mediaSignatureMatches(bytes, mime)) return respond({ error: "unsupported_media" }, 415);
  let storageId: Id<"_storage"> | undefined;
  try {
    storageId = await ctx.storage.store(new Blob([bytes], { type: mime }));
    await ctx.runMutation(internal.uploads.record, { token, storageId, mimeType: mime });
    return respond({ storageId }, 200);
  } catch {
    // No storage identifier was exposed to the client on this path.
    if (storageId) { try { await ctx.storage.delete(storageId); } catch { /* storage outage; do not log credentials */ } }
    return respond({ error: "upload_failed" }, 503);
  }
});
const http = httpRouter();
http.route({ path: "/media/upload", method: "POST", handler: upload });
http.route({ path: "/media/upload", method: "OPTIONS", handler: upload });
export default http;
