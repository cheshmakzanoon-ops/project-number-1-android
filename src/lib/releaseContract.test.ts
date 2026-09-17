// @vitest-environment node
import { readFileSync } from "node:fs";
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
