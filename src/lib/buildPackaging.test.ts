// @vitest-environment node
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
const roots:string[]=[];
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"garma-package-"));roots.push(dir);
  mkdirSync(join(dir,"assets/nested"),{recursive:true});mkdirSync(join(dir,"icons"));
  writeFileSync(join(dir,"index.html"),"<html>bundle</html>");
  writeFileSync(join(dir,"manifest.webmanifest"),"{}");
  writeFileSync(join(dir,"screen-share-help.html"),"<html>installation guide</html>");
  for(const icon of ["icon.svg","icon-192.png","icon-512.png","apple-touch-icon.png","icon-maskable.png"]) writeFileSync(join(dir,"icons",icon),"icon");
  writeFileSync(join(dir,"assets/index-hash.js"),"console.log('app')");
  writeFileSync(join(dir,"assets/nested/call-hash.js"),"console.log('call')");
  writeFileSync(join(dir,"assets/index-hash.css"),"body{}");
  writeFileSync(join(dir,"assets/index-hash.js.map"),"not for precache");
  return dir;
}
function pack(dir:string) {
  writeFileSync(join(dir,"sw.js"),readFileSync(resolve("public/sw.js")));
  execFileSync(process.execPath,[resolve("scripts/finalize-build.mjs"),dir]);
  return JSON.parse(readFileSync(join(dir,"version.json"),"utf8"));
}
afterEach(()=>{for(const dir of roots.splice(0)) rmSync(dir,{recursive:true,force:true});});
it("precaches every compiled runtime asset, including lazy nested chunks",()=>{
  const dir=fixture(), report=pack(dir), sw=readFileSync(join(dir,"sw.js"),"utf8");
  expect(report.assets).toBe(3);expect(sw).toContain('/assets/nested/call-hash.js');
  expect(sw).not.toContain('"/assets/index-hash.js.map"');expect(sw).toContain(`garma-shell-${report.revision}`);
});
it("assigns deterministic revisions to identical builds",()=>{
  const dir=fixture();expect(pack(dir).revision).toBe(pack(dir).revision);
});
it.each(["assets/nested/call-hash.js","index.html","icons/icon-192.png","manifest.webmanifest","screen-share-help.html"])("updates the shell revision when %s changes",file=>{
  const dir=fixture(),before=pack(dir).revision;writeFileSync(join(dir,file),"changed");expect(pack(dir).revision).not.toBe(before);
});
it("does not silently ship an unversioned worker if the template contract is missing",()=>{
  const dir=fixture();writeFileSync(join(dir,"sw.js"),"broken");
  expect(()=>execFileSync(process.execPath,[resolve("scripts/finalize-build.mjs"),dir],{stdio:"pipe"})).toThrow();
});
it("the production HTML has CSP, no inline script and permits accessibility zoom",()=>{
  const html=readFileSync("index.html","utf8");
  expect(html).toContain('http-equiv="Content-Security-Policy"');expect(html).not.toMatch(/onload\s*=/);
  expect(html).not.toContain("user-scalable=no");expect(html).not.toContain("maximum-scale=1");
});

it("ships a script-free Persian installation guide with no invented store or APK URL", () => {
  const html = readFileSync("public/screen-share-help.html", "utf8");
  expect(html).toContain('lang="fa" dir="rtl"');
  expect(html).toContain("com.garma.screenshare");
  expect(html).not.toContain("play.google.com");
  expect(html).not.toMatch(/<script\b|href=.*\.apk/i);
  expect(readFileSync("public/sw.js", "utf8")).toContain('"/screen-share-help.html"');
});
