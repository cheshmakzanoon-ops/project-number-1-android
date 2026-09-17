import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
const mock = vi.hoisted(() => {
  Object.defineProperty(globalThis, "MediaRecorder", {configurable:true, value: class {}});
  Object.defineProperty(navigator, "mediaDevices", {configurable:true, value:{getUserMedia:()=>Promise.resolve(null)}});
  return { send:vi.fn(), edit:vi.fn(), remove:vi.fn(), authorize:vi.fn(), put:vi.fn(),
    start:vi.fn(), stop:vi.fn(), cancel:vi.fn(), misc:vi.fn(), messages:[] as any[], compress:vi.fn() };
});
vi.mock("convex/react", () => ({ useMutation: (fn:any) => ({"messages:send":mock.send,"messages:edit":mock.edit,
  "messages:remove":mock.remove,"messages:uploadUrl":mock.authorize}[getFunctionName(fn)] ?? mock.misc) }));
vi.mock("../lib/softQuery", () => ({useSoftQuery:(fn:any) => ({unavailable:false,
  data:getFunctionName(fn)==="messages:list" ? mock.messages : getFunctionName(fn)==="conversations:conversation" ? {members:[],canAccess:true} : []})}));
vi.mock("../lib/media", async importOriginal => ({ ...await importOriginal<typeof import("../lib/media")>(),
  startRecording:(...args:unknown[])=>mock.start(...args), putStorageFile:(...args:unknown[])=>mock.put(...args),
  compressImage:(file:File)=>mock.compress(file) }));
import { Chat } from "./Chat";
import type { Id } from "../convex/_generated/dataModel";
const props = { token:"a".repeat(64),meColor:"#777",meName:"Me",meId:"me" as Id<"users">,
  conversationId:"chat" as Id<"conversations">,kind:"dm" as const,name:"Dad",color:"#777",onBack:vi.fn(),
  onCallAudio:vi.fn(),onCallVideo:vi.fn() };
const recording=()=>({blob:new Blob(["voice"],{type:"audio/webm"}),durationMs:2100,mimeType:"audio/webm"});
beforeEach(()=>{
  vi.useFakeTimers(); localStorage.clear(); mock.messages=[];
  for(const fn of [mock.send,mock.edit,mock.remove,mock.authorize,mock.put,mock.start,mock.stop,mock.cancel,mock.misc,mock.compress]) fn.mockReset();
  mock.send.mockResolvedValue("message");mock.edit.mockResolvedValue(null);mock.remove.mockResolvedValue(null);
  mock.authorize.mockResolvedValue("https://upload");mock.put.mockResolvedValue("storage");mock.misc.mockResolvedValue(null);
  mock.stop.mockResolvedValue(recording());mock.start.mockReturnValue({stop:mock.stop,cancel:mock.cancel});
  mock.compress.mockImplementation((file:File)=>Promise.resolve(file));
  Object.defineProperty(Element.prototype,"scrollIntoView",{configurable:true,value:vi.fn()});
  Object.defineProperty(URL,"createObjectURL",{configurable:true,value:vi.fn(()=>"blob:photo")});
  Object.defineProperty(URL,"revokeObjectURL",{configurable:true,value:vi.fn()});
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
it("releases an active voice recorder before handing the microphone to a new call",async()=>{
  const order:string[]=[];mock.stop.mockImplementation(()=>{order.push("stop");return Promise.resolve(recording());});
  render(<Chat {...props} onCallVideo={()=>order.push("call")} />);
  fireEvent.click(screen.getByRole("button",{name:"ضبط پیام صوتی"}));
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"تماس تصویری"})));
  expect(order).toEqual(["stop","call"]);expect(mock.send).not.toHaveBeenCalled();
});
it("incoming calls stop the recorder and disable send until the call finishes",async()=>{
  const view=render(<Chat {...props} />);fireEvent.click(screen.getByRole("button",{name:"ضبط پیام صوتی"}));
  await act(async()=>view.rerender(<Chat {...props} callActive />));
  expect(mock.stop).toHaveBeenCalledOnce();expect(mock.send).not.toHaveBeenCalled();
  expect((screen.getByRole("button",{name:"ارسال پیام صوتی"}) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<Chat {...props} callActive={false} />);
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"ارسال پیام صوتی"})));
  expect(mock.send).toHaveBeenCalledOnce();expect(mock.cancel).not.toHaveBeenCalled();
});
it("a stalled upload authorization returns a voice draft for retry after its deadline",async()=>{
  mock.authorize.mockReturnValueOnce(new Promise(()=>{}));render(<Chat {...props} />);
  fireEvent.click(screen.getByRole("button",{name:"ضبط پیام صوتی"}));
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"ارسال پیام صوتی"})));
  await act(async()=>vi.advanceTimersByTimeAsync(15_000));
  expect(screen.getByRole("button",{name:"ارسال پیام صوتی"})).toBeTruthy();
  expect(mock.send).not.toHaveBeenCalled();
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"ارسال پیام صوتی"})));
  expect(mock.send).toHaveBeenCalledOnce();expect(mock.stop).toHaveBeenCalledOnce();
});
it("retries a voice send with the same client ID and already-owned upload receipt",async()=>{
  mock.send.mockRejectedValueOnce(new Error("offline"));render(<Chat {...props} />);
  fireEvent.click(screen.getByRole("button",{name:"ضبط پیام صوتی"}));
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"ارسال پیام صوتی"})));
  const attempt=mock.send.mock.calls[0][0];
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"ارسال پیام صوتی"})));
  expect(mock.send.mock.calls[1][0]).toEqual(attempt);expect(mock.put).toHaveBeenCalledOnce();
});
it("failed message deletion is reported rather than becoming an unhandled rejection",async()=>{
  mock.messages=[{_id:"message",senderId:"me",isMine:true,kind:"text",body:"Delete this",createdAt:Date.now(),delivery:"sent",reactions:[]}];
  mock.remove.mockRejectedValue(new Error("offline"));render(<Chat {...props} />);
  fireEvent.click(screen.getByText("Delete this"));
  await act(async()=>fireEvent.click(screen.getByRole("button",{name:"حذف"})));
  expect(screen.getByText("پیام حذف نشد؛ دوباره تلاش کن.")).toBeTruthy();
  expect(screen.getByText("Delete this")).toBeTruthy();
});
