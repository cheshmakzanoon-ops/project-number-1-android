// @vitest-environment node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("both Android packaging workflows supply the exact variables read by Gradle", () => {
  const build = readFileSync("android/app/build.gradle.kts", "utf8");
  const variables = [...build.matchAll(/providers\.environmentVariable\("(GARMA_ANDROID_[A-Z_]+)"\)/g)].map(match => match[1]);
  expect(variables).toHaveLength(4);
  for (const path of [".github/workflows/android.yml", ".github/workflows/family-apk.yml"]) {
    const workflow = readFileSync(path, "utf8");
    for (const variable of variables) expect(workflow).toMatch(new RegExp(`^\\s+${variable}:`, "m"));
  }
});
it("the persistent keystore and generated packages are excluded from source control", () => {
  const ignores = readFileSync(".gitignore", "utf8").split(/\r?\n/);
  for (const pattern of ["*.jks", "*.keystore", "*.p12", "*.pfx", "family-package/", "android/**/build/"]) {
    expect(ignores).toContain(pattern);
  }
});

it("legacy call verification refuses local execution without contacting a deployment", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-call-lifecycle.mjs"], {
    env: { ...process.env, CI: "false", RUNNER_TEMP: "" }, encoding: "utf8", timeout: 5000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("disposable Linux runner");
});
it("legacy call verification refuses production deployment credentials even in CI", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-call-lifecycle.mjs"], {
    env: { ...process.env, CI: "true", RUNNER_TEMP: "/tmp/test-only", CONVEX_URL: "https://do-not-contact.example" },
    encoding: "utf8", timeout: 5000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Refusing call verification|disposable Linux runner/);
});
