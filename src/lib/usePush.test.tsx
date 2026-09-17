import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {usePush} from './usePush';
const mock=vi.hoisted(()=>({key:vi.fn(),save:vi.fn(),remove:vi.fn()}));
vi.mock('convex/react',()=>({useAction:()=>mock.key,useMutation:(ref:any)=>String(ref).includes('remove')?mock.remove:mock.save}));
vi.mock('../convex/_generated/api',()=>({api:{push:{vapidPublicKey:'key'},pushSubs:{saveSubscription:'save',removeSubscription:'remove'}}}));
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return{promise,resolve};};
const keyBytes=new Uint8Array(65);keyBytes[0]=4;
const key=btoa(String.fromCharCode(...keyBytes));
let permission:NotificationPermission;
let manager:{getSubscription:ReturnType<typeof vi.fn>;subscribe:ReturnType<typeof vi.fn>};
function subscription(endpoint='https://fcm.googleapis.com/fcm/send/device'){
 return {endpoint,options:{applicationServerKey:keyBytes.buffer},unsubscribe:vi.fn().mockResolvedValue(true),toJSON:()=>({endpoint,keys:{p256dh:'key',auth:'auth'}})};
}
beforeEach(()=>{
 vi.useFakeTimers();vi.resetAllMocks();permission='granted';
 vi.stubGlobal('Notification',{get permission(){return permission;},requestPermission:vi.fn()});vi.stubGlobal('PushManager',function(){});
 manager={getSubscription:vi.fn().mockResolvedValue(null),subscribe:vi.fn().mockResolvedValue(subscription())};
 Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{ready:Promise.resolve({pushManager:manager}),addEventListener:vi.fn(),removeEventListener:vi.fn()}});
 mock.key.mockResolvedValue(key);mock.save.mockResolvedValue('id');mock.remove.mockResolvedValue(null);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
it('reports registered only after the server acknowledges the actual browser subscription',async()=>{
 const pending=deferred();mock.save.mockReturnValue(pending.promise);const {result}=renderHook(()=>usePush('token'));
 await act(async()=>{});expect(result.current.registered).toBe(false);
 await act(async()=>{pending.resolve('id');});expect(result.current.registered).toBe(true);
});
it('does not continue an old identity subscription after the token is revoked',async()=>{
 const pending=deferred();mock.key.mockReturnValue(pending.promise);
 const view=renderHook(({token})=>usePush(token),{initialProps:{token:'token' as string|null}});
 view.rerender({token:null});await act(async()=>{pending.resolve(key);});
 expect(manager.subscribe).not.toHaveBeenCalled();expect(mock.save).not.toHaveBeenCalled();expect(view.result.current.registered).toBe(false);
});
it('does not save a late browser subscription after its component unmounts',async()=>{
 const pending=deferred();manager.subscribe.mockReturnValue(pending.promise);const view=renderHook(()=>usePush('token'));
 await act(async()=>{});view.unmount();await act(async()=>{pending.resolve(subscription());});expect(mock.save).not.toHaveBeenCalled();
});
it('lets a new identity register after the obsolete attempt settles, without saving the old identity',async()=>{
 const pending=deferred();mock.key.mockReturnValueOnce(pending.promise);
 const view=renderHook(({token})=>usePush(token),{initialProps:{token:'old'}});view.rerender({token:'new'});
 await act(async()=>{pending.resolve(key);});expect(mock.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({token:'new'}));expect(view.result.current.registered).toBe(true);
});
it('rotates the browser-owned endpoint after a different-account conflict instead of transferring it',async()=>{
 const old=subscription(),fresh=subscription('https://fcm.googleapis.com/fcm/send/new-device');manager.getSubscription.mockResolvedValue(old);manager.subscribe.mockResolvedValue(fresh);
 mock.save.mockRejectedValueOnce(new Error('subscription_not_owned')).mockResolvedValueOnce('id');
 const {result}=renderHook(()=>usePush('new-user'));await act(async()=>{});
 expect(old.unsubscribe).toHaveBeenCalledOnce();expect(mock.save).toHaveBeenLastCalledWith(expect.objectContaining({token:'new-user',endpoint:fresh.endpoint}));expect(result.current.registered).toBe(true);
});
it('a rejected server save never claims background ringing is registered',async()=>{
 mock.save.mockRejectedValue(new Error('network'));const {result}=renderHook(()=>usePush('token'));await act(async()=>{});expect(result.current.registered).toBe(false);expect(result.current.error).toBeTruthy();
});
it('bounds a stalled push authorization request and supports retry',async()=>{
 mock.key.mockReturnValueOnce(new Promise(()=>{}));const {result}=renderHook(()=>usePush('token'));
 await act(async()=>{await vi.advanceTimersByTimeAsync(12000);});expect(result.current.subscribing).toBe(false);expect(result.current.error).toBeTruthy();
 await act(async()=>{await result.current.enable();});expect(result.current.registered).toBe(true);
});
it('coalesces and bounds a permission prompt, ignoring a late response',async()=>{
 permission='default';const pending=deferred();vi.mocked(Notification.requestPermission).mockReturnValue(pending.promise);
 const {result}=renderHook(()=>usePush('token'));
 await act(async()=>{void result.current.enable();void result.current.enable();await vi.advanceTimersByTimeAsync(60000);});
 expect(Notification.requestPermission).toHaveBeenCalledOnce();expect(result.current.error).toBeTruthy();
 await act(async()=>{pending.resolve('granted');});expect(manager.subscribe).not.toHaveBeenCalled();
});
it('a key rotation removes the prior owned server registration after browser unsubscription',async()=>{
 const old=subscription();old.options.applicationServerKey=new Uint8Array(65).buffer;manager.getSubscription.mockResolvedValue(old);
 renderHook(()=>usePush('token'));await act(async()=>{});
 expect(old.unsubscribe).toHaveBeenCalledOnce();expect(mock.remove).toHaveBeenCalledWith({token:'token',endpoint:old.endpoint});
});
