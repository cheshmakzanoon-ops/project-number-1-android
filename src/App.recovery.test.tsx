import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  me: undefined as unknown,
  unavailable: false,
  heartbeat: vi.fn().mockResolvedValue(null),
  session: {callId: "call", kind: "video", phase: "active", peers: [], callerName: "Dad", callerColor: "#333"},
}));
vi.mock("convex/react", () => ({useMutation: () => mock.heartbeat}));
vi.mock("./lib/softQuery", () => ({useSoftQuery: () => ({data: mock.me, unavailable: mock.unavailable})}));
vi.mock("./lib/useCallkit", () => ({useCallkit: () => ({session: mock.session})}));
vi.mock("./lib/usePush", () => ({usePush: () => ({notifPerm: "unsupported", registered: false})}));
vi.mock("./components/CallOverlay", () => ({CallOverlay: () => <button>Hang up active call</button>}));
vi.mock("./components/Lobby", () => ({Lobby: () => <div>Family lobby</div>}));
vi.mock("./components/Chat", () => ({Chat: () => <div>Chat</div>}));
vi.mock("./components/InstallBanner", () => ({InstallBanner: () => null}));
import { App } from "./App";
const identity = {_id: "person", displayName:"Family", username:"family", themeColor:"#333", createdAt:1, lastSeenAt:1};
beforeEach(() => {
  mock.heartbeat.mockResolvedValue(null);
  localStorage.clear(); mock.me = identity; mock.unavailable = false; vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("keeps active call controls reachable during a backend query failure", () => {
  const page = render(<App />);
  expect(screen.getByText("Hang up active call")).toBeTruthy();
  mock.me = undefined; mock.unavailable = true; page.rerender(<App />);
  expect(screen.getByText("Hang up active call")).toBeTruthy();
  expect(screen.getByText("Family lobby")).toBeTruthy();
});
it("retains the last authenticated identity through a slow reconnect", async () => {
  const page = render(<App />);
  mock.me = undefined; page.rerender(<App />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(screen.getByText("Hang up active call")).toBeTruthy();
  expect(screen.getByText("Family lobby")).toBeTruthy();
});
it("does not retain authenticated lobby access after an explicit null identity", () => {
  const page=render(<App />);
  mock.me=null;page.rerender(<App />);
  expect(screen.queryByText("Family lobby")).toBeNull();
});
it("does not fabricate an authenticated lobby on a cold-start backend failure", () => {
  mock.me=undefined;mock.unavailable=true;
  render(<App />);
  expect(screen.queryByText("Family lobby")).toBeNull();
});
