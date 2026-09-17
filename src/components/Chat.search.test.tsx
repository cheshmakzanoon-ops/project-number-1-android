import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
const state = vi.hoisted(() => ({ latest: [] as any[], around: [] as any[], hits: [] as any[], empty: [], mutate: vi.fn() }));
vi.mock("convex/react", () => ({ useMutation: () => state.mutate }));
vi.mock("../lib/softQuery", () => ({ useSoftQuery: (fn: any, args: any) => {
  const name = getFunctionName(fn);
  const data = name === "messages:list" ? state.latest : name === "messages:listAround" ? state.around :
    name === "messages:search" ? state.hits : name === "conversations:conversation" ? { members: [], canAccess: true } : state.empty;
  return { data: args === "skip" ? undefined : data, unavailable: false };
} }));
import { Chat } from "./Chat";
const props = { token: "a".repeat(64), meId: "me" as Id<"users">, meColor: "#777", meName: "Me",
  conversationId: "chat" as Id<"conversations">, kind: "dm" as const, name: "Dad", color: "#777",
  onBack: () => {}, onCallVideo: () => {}, onCallAudio: () => {} };
const row = (id: string, body: string) => ({ _id: id, senderId: "dad", isMine: false, body,
  kind: "text", createdAt: Date.now(), reactions: [], reply: null });
beforeEach(() => {
  localStorage.clear(); state.mutate.mockReset().mockResolvedValue(null);
  state.latest = [row("recent", "Recent family message")];
  state.around = [row("older", "Older family message")];
  state.hits = [];
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
});
afterEach(cleanup);
async function search(body: string, id: string) {
  state.hits = [{ _id: id, body, kind: "text", createdAt: Date.now(), senderName: "Dad", senderColor: "#777" }];
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "جستجو در گفتگو" })));
  fireEvent.change(screen.getByPlaceholderText("جستجو در گفتگو…"), { target: { value: body } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: new RegExp(body) })));
}
it("scrolls to a recent search result without inventing a separate history window", async () => {
  const view = render(<Chat {...props} />);
  await search("Recent family message", "recent");
  expect(screen.queryByPlaceholderText("جستجو در گفتگو…")).toBeNull();
  expect(screen.queryByRole("button", { name: /نمایش اطراف پیام/ })).toBeNull();
  expect(view.container.querySelector('[data-mid="recent"]')?.classList.contains("animate-flash")).toBe(true);
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
});
it("opens an older result and returns to the latest messages without marking history as newly read", async () => {
  const view = render(<Chat {...props} />);
  await search("Older family message", "older");
  expect(view.container.querySelector('[data-mid="older"]')).not.toBeNull();
  expect(view.container.querySelector('[data-mid="recent"]')).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /نمایش اطراف پیام/ })));
  expect(view.container.querySelector('[data-mid="recent"]')).not.toBeNull();
  expect(view.container.querySelector('[data-mid="older"]')).toBeNull();
  expect(state.mutate.mock.calls.some(([args]) => args.throughId === "older")).toBe(false);
});
