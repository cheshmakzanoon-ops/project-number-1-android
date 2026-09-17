import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
const mock=vi.hoisted(()=>({feed:[] as any[],mine:[] as any[],mutate:vi.fn(),upload:vi.fn(),put:vi.fn(),compress:vi.fn(),owner:[] as any[]}));
vi.mock("convex/react",()=>({useMutation:(fn:any)=>getFunctionName(fn).endsWith(":uploadUrl") ? mock.upload : mock.mutate}));
vi.mock("../lib/media",()=>({compressImage:(b:Blob)=>mock.compress(b),putStorageFile:(...args:unknown[])=>mock.put(...args)}));
vi.mock("../lib/softQuery",()=>({useSoftQuery:(fn:any)=>({data:getFunctionName(fn).endsWith(":feed")?mock.feed:getFunctionName(fn).endsWith(":forOwner")?mock.owner:mock.mine,unavailable:false})}));
import { StatusStrip } from "./StatusStrip";
import type { Id } from "../convex/_generated/dataModel";
beforeEach(()=>{vi.useFakeTimers();mock.feed=[];mock.mine=[];mock.mutate.mockReset().mockResolvedValue(null);mock.upload.mockReset().mockResolvedValue("https://upload");mock.put.mockReset().mockResolvedValue("storage-photo");mock.compress.mockReset().mockImplementation(b=>Promise.resolve(b));mock.owner=[];});
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

it("failed text posts stay in the composer and reuse their idempotency key on retry",async()=>{
  mock.mutate.mockRejectedValueOnce(new Error("network"));
  render(<StatusStrip token="token" meId={"me" as Id<"users">} meName="Me" />);
  fireEvent.click(screen.getByRole("button",{name:"وضعیت جدید"}));
  fireEvent.change(screen.getByPlaceholderText("حال و روزت را بنویس…"),{target:{value:"Still here"}});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));});
  expect(screen.getByRole("alert").textContent).toContain("دوباره");
  expect((screen.getByPlaceholderText("حال و روزت را بنویس…") as HTMLTextAreaElement).value).toBe("Still here");
  const id=mock.mutate.mock.calls[0][0].clientPostId;
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));});
  expect(mock.mutate.mock.calls[1][0].clientPostId).toBe(id);
  expect(screen.queryByPlaceholderText("حال و روزت را بنویس…")).toBeNull();
});
it("deduplicates double taps and cannot close a pending composer",async()=>{
  let done!:(value:null)=>void;mock.mutate.mockImplementation(()=>new Promise(r=>{done=r;}));
  render(<StatusStrip token="token" meId={"me" as Id<"users">} meName="Me" />);
  fireEvent.click(screen.getByRole("button",{name:"وضعیت جدید"}));
  fireEvent.change(screen.getByPlaceholderText("حال و روزت را بنویس…"),{target:{value:"Once"}});
  fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));
  fireEvent.click(screen.getByRole("button",{name:"بستن"}));
  expect(mock.mutate).toHaveBeenCalledTimes(1);expect(screen.getByPlaceholderText("حال و روزت را بنویس…")).toBeTruthy();
  await act(async()=>{done(null);});
});
it("retries a failed photo status without uploading the bytes a second time",async()=>{
  mock.mutate.mockRejectedValueOnce(new Error("reply lost"));
  Object.defineProperty(URL,"createObjectURL",{configurable:true,value:vi.fn(()=>"blob:preview")});
  Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:vi.fn()});
  const {container}=render(<StatusStrip token="token" meId={"me" as Id<"users">} meName="Me" />);
  fireEvent.click(screen.getByRole("button",{name:"وضعیت جدید"}));
  fireEvent.change(container.querySelector('input[type="file"]')!,{target:{files:[new File(["photo"],"photo.jpg",{type:"image/jpeg"})]}});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));});
  expect(mock.put).toHaveBeenCalledTimes(1);expect(mock.put.mock.calls[0][2]).toBe("token");
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));});
  expect(mock.put).toHaveBeenCalledTimes(1);expect(mock.mutate.mock.calls[1][0]).toEqual(mock.mutate.mock.calls[0][0]);
});
it("does not pretend a failed status deletion succeeded",async()=>{
  const story={_id:"story",ownerId:"me",ownerName:"Me",ownerColor:"#777",kind:"text",body:"Existing",createdAt:Date.now(),expiresAt:Date.now()+60000,viewers:[]};
  mock.mine=[story];mock.owner=[story];mock.mutate.mockRejectedValue(new Error("offline"));
  render(<StatusStrip token="token" meId={"me" as Id<"users">} meName="Me" />);
  fireEvent.click(screen.getByRole("button",{name:"وضعیت Me"}));
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"حذف وضعیت"}));});
  expect(screen.getByRole("alert").textContent).toContain("حذف انجام نشد");expect(screen.getByText("Existing")).toBeTruthy();
});
