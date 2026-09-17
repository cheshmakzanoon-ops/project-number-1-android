import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
const mock=vi.hoisted(()=>({feed:[] as any[],mine:[] as any[],mutate:vi.fn()}));
vi.mock("convex/react",()=>({useMutation:()=>mock.mutate}));
vi.mock("../lib/softQuery",()=>({useSoftQuery:(fn:any)=>({data:getFunctionName(fn).endsWith(":feed")?mock.feed:mock.mine,unavailable:false})}));
import { StatusStrip } from "./StatusStrip";
import type { Id } from "../convex/_generated/dataModel";
beforeEach(()=>{vi.useFakeTimers();mock.feed=[];mock.mine=[];mock.mutate.mockResolvedValue(null);});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
it("expires a stale story ring without requiring a new backend query response",async()=>{
  mock.feed=[{_id:"story",ownerId:"dad",ownerName:"Dad",ownerColor:"#777",kind:"text",body:"hello",
    createdAt:Date.now()-1000,expiresAt:Date.now()+1000,viewers:[]}];
  render(<StatusStrip token="token" meId={"me" as Id<"users">} meName="Me" />);
  expect(screen.getAllByText("Dad").length).toBeGreaterThan(0);
  await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});
  expect(screen.queryByText("Dad")).toBeNull();
});
it("revokes the preview URL when a photo composer is closed",()=>{
  const revoke=vi.fn();
  Object.defineProperty(URL,"createObjectURL",{configurable:true,value:vi.fn(()=>"blob:photo-preview")});
  Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:revoke});
  const {container}=render(<StatusStrip token="token" meId={"me" as Id<"users">} meName="Me" />);
  fireEvent.click(screen.getByRole("button",{name:"وضعیت جدید"}));
  fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[new File(["photo"],"photo.jpg",{type:"image/jpeg"})]}});
  fireEvent.click(screen.getByRole("button",{name:"بستن"}));
  expect(revoke).toHaveBeenCalledWith("blob:photo-preview");
});
