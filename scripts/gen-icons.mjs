// Regenerates the PWA/app icons for Garma from the brand SVGs
// (public/icons/icon.svg — rounded tile; public/icons/icon-flat.svg —
// full-bleed square used for maskable/apple icons).
//
// Uses sharp-cli through bunx (fetched into the bun cache on first run, not
// installed into the project):
//   node scripts/gen-icons.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = join(ROOT, "public", "icons");
mkdirSync(ICONS, { recursive: true });

const JOBS = [
  ["icon.svg", "icon-512.png", 512],
  ["icon.svg", "icon-192.png", 192],
  ["icon-flat.svg", "icon-maskable.png", 512],
  ["icon-flat.svg", "apple-touch-icon.png", 180],
];

for (const [src, out, size] of JOBS) {
  const r = spawnSync(
    "bunx",
    [
      "--yes",
      "sharp-cli",
      "-i",
      join(ICONS, src),
      "-o",
      join(ICONS, out),
      "resize",
      String(size),
      String(size),
    ],
    { stdio: "inherit", cwd: ROOT },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log(`wrote ${out} (${size}x${size})`);
}
