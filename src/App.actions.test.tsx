import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
const h = vi.hoisted(() => ({me: null as unknown, register:vi.fn(), dm:vi.fn(), group:vi.fn(),
  beat:vi.fn(), clearInvite:vi.fn(), kit:{session:null as unknown,busy:false,startCall:vi.fn()}, lobby:null as any}));
vi.mock("convex/react", () => ({useMutation:(ref:any) => {
  const name=getFunctionName(ref);return name === "users:register" ? h.register : name === "conversations:startDM" ? h.dm : name === "conversations:startGroup" ? h.group : h.beat;
}}));
vi.mock("./lib/token",()=>({getDeviceToken:()=>"test-token",deviceTokenPersists:()=>true,clearFamilyInvite:()=>h.clearInvite()}));
vi.mock("./lib/softQuery",()=>({useSoftQuery:()=>({data:h.me,unavailable:false})}));
vi.mock("./lib/useCallkit",()=>({useCallkit:()=>h.kit}));
vi.mock("./lib/usePush",()=>({usePush:()=>({notifPerm:"unsupported",registered:false})}));
vi.mock("./components/Signup",()=>({Signup:({onRegister,busy,error}:any)=><><button onClick={()=>onRegister("Parent","invite")} disabled={busy}>Register</button><p role="alert">{error}</p><span>{busy?"Busy":"Ready"}</span></>}));
vi.mock("./components/Lobby",()=>({Lobby:(props:any)=>{h.lobby=props;return <div>Lobby</div>;}}));
vi.mock("./components/Chat",()=>({Chat:({name,onBack}:any)=><><p>Chat:{name}</p><button onClick={onBack}>Back</button></>}));
vi.mock("./components/CallOverlay",()=>({CallOverlay:()=>null}));
vi.mock("./components/InstallBanner",()=>({InstallBanner:()=>null}));
import {App} from "./App";
const me={_id:"me",displayName:"Family",username:"family",themeColor:"#333",createdAt:1,lastSeenAt:1};
const a={_id:"a",displayName:"Alice",themeColor:"#333"};
const b={_id:"b",displayName:"Bob",themeColor:"#555"};
const later=<T,>()=>{let resolve!:(value:T)=>void;let reject!:(e:Error)=>void;const promise=new Promise<T>((ok,no)=>{resolve=ok;reject=no;});return{promise,resolve,reject};};
beforeEach(()=>{vi.useFakeTimers();localStorage.clear();h.me=me;h.kit.session=null;h.kit.busy=false;for(const f of [h.register,h.dm,h.group,h.beat,h.kit.startCall]) f.mockReset().mockResolvedValue(null);h.clearInvite.mockReset();});
afterEach(()=>{cleanup();vi.useRealTimers();});
it("bounds stalled registration and permits another explicit attempt",async()=>{
  h.me=null;h.register.mockReturnValue(new Promise(()=>{}));render(<App/>);
  fireEvent.click(screen.getByText("Register"));expect(screen.getByText("Busy")).toBeTruthy();
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);});
  expect(screen.getByText("Ready")).toBeTruthy();expect(screen.getByRole("alert").textContent).not.toBe("");
  fireEvent.click(screen.getByText("Register"));expect(h.register).toHaveBeenCalledTimes(2);
});
it("never clears the invitation from a timed-out registration's late response",async()=>{
  h.me=null;const first=later();h.register.mockReturnValue(first.promise);render(<App/>);fireEvent.click(screen.getByText("Register"));
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);first.resolve(null);});
  expect(h.clearInvite).not.toHaveBeenCalled();
});
it("clears the invite only after successful registration",async()=>{
  h.me=null;render(<App/>);await act(async()=>{fireEvent.click(screen.getByText("Register"));});expect(h.clearInvite).toHaveBeenCalledOnce();
});
it("a slow previous contact cannot replace a newer chosen conversation",async()=>{
  const first=later();h.dm.mockReturnValueOnce(first.promise).mockResolvedValueOnce("conv-b");render(<App/>);
  act(()=>{void h.lobby.onMessageContact(a);});await act(async()=>{await h.lobby.onMessageContact(b);});
  expect(screen.getByText("Chat:Bob")).toBeTruthy();await act(async()=>{first.resolve("conv-a");});
  expect(screen.getByText("Chat:Bob")).toBeTruthy();
});
it("manual conversation navigation invalidates a pending contact lookup",async()=>{
  const first=later();h.dm.mockReturnValue(first.promise);render(<App/>);
  act(()=>{void h.lobby.onMessageContact(a);h.lobby.onOpen("manual","dm","Manual","#333",[]);});
  await act(async()=>{first.resolve("conv-a");});expect(screen.getByText("Chat:Manual")).toBeTruthy();
});
it("changing lobby tabs prevents a delayed contact lookup from dialing",async()=>{
  const pending=later();h.dm.mockReturnValue(pending.promise);render(<App/>);
  act(()=>{void h.lobby.onVideoContact(a);h.lobby.onTab("status");});
  await act(async()=>{pending.resolve("conv-a");});expect(h.kit.startCall).not.toHaveBeenCalled();
});
it("a timed-out contact lookup never starts a surprise call when it later answers",async()=>{
  const pending=later();h.dm.mockReturnValue(pending.promise);render(<App/>);act(()=>{void h.lobby.onVideoContact(a);});
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);pending.resolve("conv-a");});expect(h.kit.startCall).not.toHaveBeenCalled();
});
it("revoked identity invalidates an in-flight conversation lookup",async()=>{
  const pending=later();h.dm.mockReturnValue(pending.promise);const view=render(<App/>);act(()=>{void h.lobby.onMessageContact(a);});
  h.me=null;view.rerender(<App/>);await act(async()=>{pending.resolve("conv-a");});
  expect(screen.queryByText("Chat:Alice")).toBeNull();expect(screen.getByText("Register")).toBeTruthy();
});
it("bounds group creation instead of opening the group long after a timeout",async()=>{
  const pending=later();h.group.mockReturnValue(pending.promise);render(<App/>);
  act(()=>{h.lobby.onGroupCreate([{userId:"a",displayName:"Alice",themeColor:"#333"},{userId:"b",displayName:"Bob",themeColor:"#444"}]);});
  await act(async()=>{await vi.advanceTimersByTimeAsync(15_001);pending.resolve("group");});
  expect(screen.getByText("Lobby")).toBeTruthy();expect(screen.getByText(/عملیات انجام نشد/)).toBeTruthy();
});
it("unmounted registration cannot clear another view's invitation",async()=>{
  h.me=null;const pending=later();h.register.mockReturnValue(pending.promise);const view=render(<App/>);fireEvent.click(screen.getByText("Register"));view.unmount();
  await act(async()=>{pending.resolve(null);});expect(h.clearInvite).not.toHaveBeenCalled();
});
