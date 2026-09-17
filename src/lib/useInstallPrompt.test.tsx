import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useInstallPrompt} from './useInstallPrompt';
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(r=>{resolve=r;});return{promise,resolve};};
function offer(prompt=vi.fn().mockResolvedValue(undefined),choice=Promise.resolve({outcome:'accepted'})){
 const event=new Event('beforeinstallprompt',{cancelable:true});Object.assign(event,{prompt,userChoice:choice});act(()=>window.dispatchEvent(event));return prompt;
}
beforeEach(()=>{vi.useFakeTimers();sessionStorage.clear();vi.stubGlobal('matchMedia',vi.fn(()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})));});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();});
it('consumes the install event once even when the button is double-clicked before rerender',async()=>{
 const choice=deferred();const {result}=renderHook(()=>useInstallPrompt());const prompt=offer(undefined,choice.promise);
 act(()=>{result.current.promptInstall();result.current.promptInstall();});expect(prompt).toHaveBeenCalledOnce();
 await act(async()=>{choice.resolve({outcome:'accepted'});});expect(result.current.visible).toBe(false);
});
it('handles synchronous prompt failure without claiming the app was installed',async()=>{
 const {result}=renderHook(()=>useInstallPrompt());offer(vi.fn(()=>{throw new Error('InvalidStateError');}));
 await act(async()=>{result.current.promptInstall();});expect(result.current.visible).toBe(true);expect(result.current.canPromptNative).toBe(false);
 expect(result.current.error).toBeTruthy();
});
it('handles a rejected prompt promise and offers manual installation guidance',async()=>{
 const {result}=renderHook(()=>useInstallPrompt());offer(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
 await act(async()=>{result.current.promptInstall();});expect(result.current.error).toBeTruthy();
});
it('bounds a stalled native prompt and ignores its late acceptance',async()=>{
 const choice=deferred();const {result}=renderHook(()=>useInstallPrompt());offer(undefined,choice.promise);
 act(()=>result.current.promptInstall());await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
 expect(result.current.error).toBeTruthy();await act(async()=>{choice.resolve({outcome:'accepted'});});expect(result.current.visible).toBe(true);
});
it('does not store a late dismissal after the component unmounts',async()=>{
 const choice=deferred();const view=renderHook(()=>useInstallPrompt());offer(undefined,choice.promise);act(()=>view.result.current.promptInstall());view.unmount();
 await act(async()=>{choice.resolve({outcome:'dismissed'});});expect(sessionStorage.getItem('garma.install.dismissed')).toBeNull();
});
it('does not crash an otherwise usable browser without matchMedia',()=>{
 vi.stubGlobal('matchMedia',undefined);const {result}=renderHook(()=>useInstallPrompt());expect(result.current.visible).toBe(false);
});
it('an actual appinstalled event wins over a stalled prompt timeout',async()=>{
 const {result}=renderHook(()=>useInstallPrompt());offer(undefined,new Promise(()=>{}));act(()=>result.current.promptInstall());act(()=>window.dispatchEvent(new Event('appinstalled')));
 await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});expect(result.current.visible).toBe(false);expect(result.current.error).toBeNull();
});
