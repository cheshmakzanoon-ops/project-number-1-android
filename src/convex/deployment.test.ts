// @vitest-environment node
import { createECDH } from "node:crypto";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import { configurationStatus } from "./deployment";
import { allowedOrigin, API_VERSION, configuredWebOrigins } from "./policy";
import schema from "./schema";
const modules = import.meta.glob(["./**/*.*s", "!./**/*.test.*s"]);
const ORIGIN = "https://family.example.test";
const INVITE = "test-invitation-that-must-not-appear-in-reports";
const pair = createECDH("prime256v1"); pair.generateKeys();
const PUBLIC = pair.getPublicKey().toString("base64url");
const PRIVATE = Buffer.from(pair.getPrivateKey().toString("hex").padStart(64, "0"), "hex").toString("base64url");
beforeEach(() => {
  vi.stubEnv("GARMA_FAMILY_INVITE_CODE", INVITE);
  vi.stubEnv("GARMA_ALLOWED_ORIGINS", ORIGIN);
  vi.stubEnv("CONVEX_SITE_URL", "https://family.convex.site");
  vi.stubEnv("LIVEKIT_URL", "wss://media.example.test");
  vi.stubEnv("LIVEKIT_API_KEY", "test-key"); vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
  vi.stubEnv("VAPID_PUBLIC_KEY", PUBLIC); vi.stubEnv("VAPID_PRIVATE_KEY", PRIVATE);
});
afterEach(() => vi.unstubAllEnvs());
describe("private family deployment configuration", () => {
  it("reports a fully configured release without returning any secrets or URLs", () => {
    const report = configurationStatus(ORIGIN);
    expect(report.ready).toBe(true); expect(report.apiVersion).toBe(API_VERSION);
    expect(Object.keys(report.checks)).toHaveLength(6);
    for (const secret of [INVITE, PRIVATE, PUBLIC, "test-key", "test-secret", ORIGIN, "wss://media"]) {
      expect(JSON.stringify(report)).not.toContain(secret);
    }
  });
  it.each(["GARMA_FAMILY_INVITE_CODE", "GARMA_ALLOWED_ORIGINS", "CONVEX_SITE_URL", "LIVEKIT_URL",
    "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"])("fails with missing %s", key => {
    vi.stubEnv(key, ""); expect(configurationStatus(ORIGIN).ready).toBe(false);
  });
  it("accepts a valid private scalar with leading zero bytes", () => {
    const small = Buffer.alloc(32); small[31] = 1;
    const other = createECDH("prime256v1"); other.setPrivateKey(small);
    vi.stubEnv("VAPID_PUBLIC_KEY", other.getPublicKey().toString("base64url"));
    vi.stubEnv("VAPID_PRIVATE_KEY", small.toString("base64url"));
    expect(configurationStatus(ORIGIN).checks.pushKeys).toBe(true);
  });
  it("rejects two valid push keys from different pairs", () => {
    const other = createECDH("prime256v1"); other.generateKeys();
    vi.stubEnv("VAPID_PUBLIC_KEY", other.getPublicKey().toString("base64url"));
    expect(configurationStatus(ORIGIN).checks.pushKeys).toBe(false);
  });
  it("rejects a length-correct but invalid private scalar without exposing errors", () => {
    vi.stubEnv("VAPID_PRIVATE_KEY", Buffer.alloc(32).toString("base64url"));
    expect(configurationStatus(ORIGIN).checks.pushKeys).toBe(false);
  });
  it.each(["garbage", "ws://media.example.test", "wss://user:password@media.example.test", "wss://media.example.test?secret=1"])("rejects invalid LiveKit URL %#", url => {
    vi.stubEnv("LIVEKIT_URL", url); expect(configurationStatus(ORIGIN).checks.livekit).toBe(false);
  });
  it("requires the actual frontend origin, not just any configured origin", () => {
    expect(configurationStatus("https://other.example.test").checks.frontendOrigin).toBe(false);
    expect(configurationStatus(ORIGIN + "/private/path").ready).toBe(false);
  });
  it.each(["*", "https://user:password@family.example.test", ORIGIN + "/path", ORIGIN + "?token=1",
    ORIGIN + "#fragment", ORIGIN + ",", ORIGIN + ",*"])("rejects malformed origin configuration %# at the upload boundary too", value => {
    vi.stubEnv("GARMA_ALLOWED_ORIGINS", value);
    expect(configurationStatus(ORIGIN).checks.allowedOrigins).toBe(false);
    expect(allowedOrigin(ORIGIN)).toBe(false);
  });
  it("supports exact multiple HTTPS origins and normalizes an optional root slash", () => {
    vi.stubEnv("GARMA_ALLOWED_ORIGINS", ORIGIN + "/, https://second.example.test, " + ORIGIN);
    expect(configuredWebOrigins()).toEqual([ORIGIN, "https://second.example.test"]);
    expect(configurationStatus(ORIGIN).ready).toBe(true);
    expect(allowedOrigin(ORIGIN + ".evil.test")).toBe(false);
  });
  it("keeps explicit loopback origins for local development but never approves them for release", () => {
    vi.stubEnv("GARMA_ALLOWED_ORIGINS", "http://localhost:5173");
    expect(allowedOrigin("http://localhost:5173")).toBe(true);
    expect(configurationStatus("http://localhost:5173").ready).toBe(false);
  });
  it("executes the public action without creating users, sessions, calls or scheduled work", async () => {
    const t = convexTest(schema, modules);
    const result = await t.action(api.deployment.readiness, { frontendOrigin: ORIGIN });
    expect(result.ready).toBe(true);
    await t.run(async ctx => {
      for (const table of ["users", "sessions", "calls", "uploads"] as const) expect(await ctx.db.query(table).collect()).toEqual([]);
      expect(await ctx.db.system.query("_scheduled_functions").collect()).toEqual([]);
    });
  });
});
