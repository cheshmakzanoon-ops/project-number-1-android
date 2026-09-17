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
  expect(screen.getByRole("alert").textContent).toContain("حذف تأیید نشد");expect(screen.getByText("Existing")).toBeTruthy();
});

const deferred = () => {
  let resolve!:(value:any)=>void;
  const promise=new Promise<any>(r=>{resolve=r;});return {promise,resolve};
};
function composer() {
  const view=render(<StatusStrip token="token" meId={"me" as Id<"users">} meName="Me" />);
  fireEvent.click(screen.getByRole("button",{name:"وضعیت جدید"}));return view;
}
function image(container:HTMLElement) {
  Object.defineProperty(URL,"createObjectURL",{configurable:true,value:vi.fn(()=>"blob:preview")});
  Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:vi.fn()});
  fireEvent.change(container.querySelector('input[type=file]')!, {target:{files:[new File(["image"],"photo.jpg",{type:"image/jpeg"})]}});
}
it("bounds text posting, preserves the draft and ignores an old successful acknowledgement",async()=>{
  const old=deferred(); mock.mutate.mockReturnValueOnce(old.promise);
  composer();fireEvent.change(screen.getByPlaceholderText("حال و روزت را بنویس…"),{target:{value:"First"}});
  fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
  expect((screen.getByRole("button",{name:"ثبت وضعیت"}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByPlaceholderText("حال و روزت را بنویس…"),{target:{value:"New unsent draft"}});
  await act(async()=>{old.resolve(null);});
  expect((screen.getByPlaceholderText("حال و روزت را بنویس…") as HTMLTextAreaElement).value).toBe("New unsent draft");
});
it("does not authorize or publish a late image after the composer owner unmounts",async()=>{
  const late=deferred(); mock.compress.mockReturnValue(late.promise);
  const view=composer();image(view.container);fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));view.unmount();
  await act(async()=>{late.resolve(new Blob(["compressed"]));});
  expect(mock.upload).not.toHaveBeenCalled();expect(mock.put).not.toHaveBeenCalled();expect(mock.mutate).not.toHaveBeenCalled();
});
it("does not upload after delayed authorization completes for an unmounted owner",async()=>{
  const late=deferred(); mock.upload.mockReturnValue(late.promise);
  const view=composer();image(view.container);await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));});
  view.unmount();await act(async()=>{late.resolve("https://upload");});
  expect(mock.put).not.toHaveBeenCalled();expect(mock.mutate).not.toHaveBeenCalled();
});
it("does not publish after an upload completes for a revoked identity",async()=>{
  const late=deferred();mock.put.mockReturnValue(late.promise);
  const view=composer();image(view.container);await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));});
  view.rerender(<StatusStrip token="new-token" meId={"other" as Id<"users">} meName="Other" />);
  await act(async()=>{late.resolve("storage-photo");});expect(mock.mutate).not.toHaveBeenCalled();
  expect(screen.queryByRole("button",{name:"ثبت وضعیت"})).toBeNull();
});
it("a stalled image decoder does not trap the user in a busy composer",async()=>{
  mock.compress.mockReturnValue(new Promise(()=>{}));const view=composer();image(view.container);
  fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(20_000);});
  expect((screen.getByRole("button",{name:"بستن"}) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole("alert")).toBeTruthy();expect(mock.upload).not.toHaveBeenCalled();
});
it("a stalled upload authorization has a deadline and can be retried",async()=>{
  mock.upload.mockReturnValue(new Promise(()=>{}));const view=composer();image(view.container);
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));});
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
  expect((screen.getByRole("button",{name:"ثبت وضعیت"}) as HTMLButtonElement).disabled).toBe(false);
  expect(mock.put).not.toHaveBeenCalled();
});
it("allows photo captions to be corrected before upload and enforces the server's caption limit",async()=>{
  const view=composer();fireEvent.change(screen.getByPlaceholderText("حال و روزت را بنویس…"),{target:{value:"A".repeat(250)}});image(view.container);
  const caption=screen.getByPlaceholderText("توضیح عکس (اختیاری)…") as HTMLTextAreaElement;
  expect(caption.maxLength).toBe(200);expect(caption.value).toHaveLength(250);
  expect((screen.getByRole("button",{name:"ثبت وضعیت"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(caption,{target:{value:"Short caption"}});
  await act(async()=>{fireEvent.click(screen.getByRole("button",{name:"ثبت وضعیت"}));});
  expect(mock.mutate).toHaveBeenCalledWith(expect.objectContaining({kind:"image",body:"Short caption"}));
});
it("a hanging deletion becomes retryable without claiming that the server deleted the status",async()=>{
  const story={_id:"story",ownerId:"me",ownerName:"Me",ownerColor:"#777",kind:"text",body:"Existing",createdAt:Date.now(),expiresAt:Date.now()+60000,viewers:[]};
  mock.mine=[story];mock.owner=[story];mock.mutate.mockReturnValue(new Promise(()=>{}));
  render(<StatusStrip token="token" meId={"me" as Id<"users">} meName="Me" />);
  fireEvent.click(screen.getByRole("button",{name:"وضعیت Me"}));fireEvent.click(screen.getByRole("button",{name:"حذف وضعیت"}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_000);});
  expect((screen.getByRole("button",{name:"حذف وضعیت"}) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole("alert")).toBeTruthy();expect(screen.getByText("Existing")).toBeTruthy();
});
it("a deleted viewer's late completion cannot close a newly opened viewer",async()=>{
  const story={_id:"story",ownerId:"me",ownerName:"Me",ownerColor:"#777",kind:"text",body:"Existing",createdAt:Date.now(),expiresAt:Date.now()+60000,viewers:[]};
  const late=deferred();mock.mine=[story];mock.owner=[story];mock.mutate.mockReturnValue(late.promise);
  render(<StatusStrip token="token" meId={"me" as Id<"users">} meName="Me" />);
  fireEvent.click(screen.getByRole("button",{name:"وضعیت Me"}));fireEvent.click(screen.getByRole("button",{name:"حذف وضعیت"}));
  fireEvent.click(screen.getByRole("button",{name:"بستن"}));fireEvent.click(screen.getByRole("button",{name:"وضعیت Me"}));
  await act(async()=>{late.resolve(null);});expect(screen.getByText("Existing")).toBeTruthy();
});
it("does not advance or mark stories as seen while the document is hidden",async()=>{
  vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");
  const story={_id:"story",ownerId:"dad",ownerName:"Dad",ownerColor:"#777",kind:"text",body:"Background story",createdAt:Date.now(),expiresAt:Date.now()+60000,viewers:[]};
  mock.feed=[story];mock.owner=[story];
  render(<StatusStrip token="token" meId={"me" as Id<"users">} meName="Me" />);
  fireEvent.click(screen.getByRole("button",{name:"وضعیت Dad"}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(7000);});
  expect(screen.getByText("Background story")).toBeTruthy();expect(mock.mutate).not.toHaveBeenCalled();
  vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
  fireEvent(document,new Event("visibilitychange"));
  expect(mock.mutate).toHaveBeenCalledWith({token:"token",statusId:"story"});
});
