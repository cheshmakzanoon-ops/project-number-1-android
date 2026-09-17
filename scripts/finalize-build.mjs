import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function finalizeBuild(directory = "dist") {
  const root = resolve(directory);
  const assets = [];
  function visit(relative) {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = `${relative}/${name}`;
      if (statSync(join(root, path)).isDirectory()) visit(path);
      else if (!path.endsWith(".map")) assets.push("/" + path);
    }
  }
  visit("assets");
  const template = readFileSync(join(root, "sw.js"), "utf8");
  if (!template.includes('const PRECACHE_ASSETS = []; // build-injected')) throw new Error("Worker precache marker missing");
  if (!template.includes('const CACHE = "garma-shell-dev";')) throw new Error("Worker version marker missing");
  const staticAssets = ["/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png",
    "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/icon-maskable.png"];
  const hash = createHash("sha256").update(template).update(readFileSync(join(root, "index.html")));
  for (const asset of [...staticAssets, ...assets]) hash.update(asset).update(readFileSync(join(root, asset.slice(1))));
  const revision = hash.digest("hex").slice(0, 20);
  const worker = template.replace('const CACHE = "garma-shell-dev";', `const CACHE = "garma-shell-${revision}";`)
    .replace('const PRECACHE_ASSETS = []; // build-injected', `const PRECACHE_ASSETS = ${JSON.stringify(assets)}; // build-injected`);
  writeFileSync(join(root, "sw.js"), worker);
  writeFileSync(join(root, "version.json"), JSON.stringify({ revision, commit: process.env.GITHUB_SHA ?? null, assets: assets.length }) + "\n");
  console.log(`Offline shell ${revision}: ${assets.length} compiled assets precached`);
  return { revision, assets };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) finalizeBuild(process.argv[2]);
