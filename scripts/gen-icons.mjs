// Generates the PWA/app icons for Garma using zero dependencies.
// Draws a warm ember "heart" mark on a rounded dark square, reproduces the
// brand gradient, then writes out PNGs. Run with: node scripts/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(OUT, { recursive: true });

// ---- tiny PNG encoder (RGBA, 8-bit) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- drawing helpers ----
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)),
  Math.round(lerp(c1[1], c2[1], t)),
  Math.round(lerp(c1[2], c2[2], t)),
];

// classic implicitly-defined heart: (x^2+y^2-1)^3 - x^2*y^3 <= 0
function inHeart(u, v) {
  const a = u * u + v * v - 1;
  return a * a * a - u * u * v * v * v <= 0;
}

const BG_TOP = [61, 43, 30]; // #3d2b1e
const BG_BOTTOM = [26, 19, 13]; // #1a130d
const EMBER_TOP = [255, 226, 158]; // #ffe29e
const EMBER_BOTTOM = [230, 122, 46]; // #e67a2e

function render(size, { maskable = false } = {}) {
  const S = 4;
  const rgba = Buffer.alloc(size * size * 4);
  const radius = maskable ? 0 : Math.max(10, size * 0.22);
  const bgHalf = size / 2 - (maskable ? 0 : 2); // heart half extents
  const heartHalfW = size * (maskable ? 0.27 : 0.3);
  const heartHalfH = size * (maskable ? 0.34 : 0.36);
  const hcx = size / 2;
  const hcy = size * (maskable ? 0.5 : 0.54);

  const inRounded = (px, py) => {
    if (radius === 0) return true;
    const dx = Math.abs(px - size / 2);
    const dy = Math.abs(py - size / 2);
    const ex = dx + radius - size / 2;
    const ey = dy + radius - size / 2;
    if (ex <= 0 || ey <= 0) return true;
    return ex * ex + ey * ey <= radius * radius;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
      const yT = y / (size - 1);
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = x + (sx + 0.5) / S;
          const py = y + (sy + 0.5) / S;
          if (!maskable && !inRounded(px, py)) continue;
          const bg = mix(BG_TOP, BG_BOTTOM, yT);
          const u = (px - hcx) / heartHalfW;
          const v = (py - hcy) / heartHalfH;
          let color = bg;
          if (inHeart(u, v)) {
            // lighter toward the top of the heart
            const eT = clamp(1 - (py - (hcy - heartHalfH)) / (heartHalfH * 2), 0, 1);
            color = mix(EMBER_BOTTOM, EMBER_TOP, eT);
          }
          rSum += color[0];
          gSum += color[1];
          bSum += color[2];
          aSum += 255;
        }
      }
      const n = S * S;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(rSum / n);
      rgba[i + 1] = Math.round(gSum / n);
      rgba[i + 2] = Math.round(bSum / n);
      rgba[i + 3] = Math.round(aSum / n);
    }
  }
  return rgba;
}

function save(name, size, opts) {
  writeFileSync(join(OUT, name), encodePng(size, render(size, opts)));
  console.log(`wrote ${name} (${size}x${size})`);
}

save("icon-192.png", 192);
save("icon-512.png", 512);
save("apple-touch-icon.png", 180);
save("icon-maskable.png", 512, { maskable: true });