import { afterEach, beforeEach, expect, it, vi } from "vitest";
beforeEach(()=>{vi.resetModules();localStorage.clear();sessionStorage.clear();history.replaceState(null,"","/");});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();history.replaceState(null,"","/");});
it("makes a cryptographically random persistent 256-bit device token",async()=>{
  const {getDeviceToken,deviceTokenPersists}=await import("./token");
  const token=getDeviceToken();expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(getDeviceToken()).toBe(token);expect(deviceTokenPersists()).toBe(true);
});
it("restores an existing token without silently changing account",async()=>{
  localStorage.setItem("garma.device.token","b".repeat(64));
  const {getDeviceToken}=await import("./token");expect(getDeviceToken()).toBe("b".repeat(64));
});
it("reports restricted persistence rather than registering an unrecoverable transient account",async()=>{
  vi.stubGlobal("localStorage",{getItem:()=>{throw new Error("denied");},setItem:()=>{throw new Error("denied");}});
  const {getDeviceToken,deviceTokenPersists}=await import("./token");
  expect(getDeviceToken()).toMatch(/^[a-f0-9]{64}$/);expect(deviceTokenPersists()).toBe(false);
});
it("strips an invitation fragment while preserving pending call commands",async()=>{
  const code="a".repeat(43);history.replaceState(null,"",`/?call=123&callAction=decline#invite=${code}&other=keep`);
  const {getFamilyInvite}=await import("./token");expect(getFamilyInvite()).toBe(code);
  expect(location.hash).toBe("#other=keep");expect(location.search).toBe("?call=123&callAction=decline");
  expect(getFamilyInvite()).toBe(code);
});
it("survives StrictMode/reload and removes an invitation after enrollment",async()=>{
  history.replaceState(null,"","/#invite="+"b".repeat(43));
  expect((await import("./token")).getFamilyInvite()).toBe("b".repeat(43));
  vi.resetModules();const token=await import("./token");expect(token.getFamilyInvite()).toBe("b".repeat(43));
  token.clearFamilyInvite();expect(token.getFamilyInvite()).toBe("");expect(sessionStorage.getItem("garma.pending-invite")).toBeNull();
});
it("does not mistake a query-string credential for a supported invite fragment",async()=>{
  history.replaceState(null,"","/?invite="+"c".repeat(43));
  expect((await import("./token")).getFamilyInvite()).toBe("");
});
it("discards malformed invitation fragments",async()=>{
  history.replaceState(null,"","/#invite=abc");expect((await import("./token")).getFamilyInvite()).toBe("");expect(location.hash).toBe("");
});
it("keeps the family's short permanent code from the fragment",async()=>{
  history.replaceState(null,"","/#invite=2258432");
  expect((await import("./token")).getFamilyInvite()).toBe("2258432");
  expect(location.hash).toBe("");
});
