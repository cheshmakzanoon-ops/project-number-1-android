// Real isolated media acceptance, independent of attachment-hosting checks.
import assert from 'node:assert/strict';
import {groupCall} from './family-features.mjs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {lookup} from 'node:dns/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import {observeBrowser} from './diagnostics.mjs';
const require=createRequire(resolve(process.env.E2E_TOOLS ?? '.', 'package.json'));
const {chromium}=require('playwright');
const ORIGIN='https://garma-ci.test';
const INVITE='garma-isolated-browser-test-invitation-2026';
assert.equal(process.env.CONVEX_SELF_HOSTED_URL,'http://127.0.0.1:3210');
for(const host of ['garma-ci.test','garma-ci-media.test','precise-ptarmigan-412.eu-west-1.convex.cloud','precise-ptarmigan-412.eu-west-1.convex.site'])
  assert.equal((await lookup(host)).address,'127.0.0.1','Refuse non-loopback services');
mkdirSync('e2e-results',{recursive:true});
const report={scope:'Real application, Convex and LiveKit with synthetic Chromium capture; independent of attachment hosting, not physical-device or production-deployment acceptance.',commit:process.env.GITHUB_SHA,checks:[]};
const diagnostics=observeBrowser(),errors=[],contexts=[],pages=[];
const browser=await chromium.launch({headless:true,args:['--ignore-certificate-errors','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
async function device(name){
  const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:430,height:900},permissions:['camera','microphone'],reducedMotion:'reduce'});contexts.push(ctx);
  // Observe native peer connections for RTP evidence. Do not fake tracks,
  // SDP, transport state, receivers, getStats results or application callbacks.
  await ctx.addInitScript(()=>{const Native=window.RTCPeerConnection;window.__garmaPeers=[];window.RTCPeerConnection=class extends Native{constructor(...args){super(...args);window.__garmaPeers.push(this);}};});
  const page=await ctx.newPage();pages.push(page);diagnostics.attach(page,name);page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(25000);
  await page.goto(ORIGIN+'/#invite='+INVITE);await page.getByRole('textbox',{name:'نام نمایشی'}).fill(name);
  await page.getByRole('button',{name:'ورود به گرما',exact:true}).click();await page.getByRole('button',{name:'گفتگوی جدید',exact:true}).first().waitFor();return page;
}
async function until(fn,label,ms=30000){const start=Date.now();while(Date.now()-start<ms){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,200));}throw new Error('Timed out: '+label);}
async function check(name,fn){try{const evidence=await fn();report.checks.push({name,passed:true,evidence});console.log('PASS: '+name);}catch(e){report.checks.push({name,passed:false,error:String(e).slice(0,2000)});throw e;}finally{writeFileSync('e2e-results/calls.json',JSON.stringify(report,null,2));}}
async function chat(page,name){await page.getByRole('button',{name:'گفتگوی جدید',exact:true}).first().click();await page.getByText(name,{exact:true}).last().click();await page.getByPlaceholder('پیام خود را بنویسید…').waitFor();}
async function frames(page){return page.locator('video[data-call-video="remote-camera"]').evaluateAll(videos=>videos.map(v=>({width:v.videoWidth,height:v.videoHeight,frames:v.getVideoPlaybackQuality().totalVideoFrames,time:v.currentTime})));}
async function audio(page){return page.evaluate(async()=>{let packets=0,bytes=0;for(const peer of window.__garmaPeers){if(peer.connectionState==='closed')continue;for(const r of (await peer.getStats()).values())if(r.type==='inbound-rtp'&&(r.kind==='audio'||r.mediaType==='audio')){packets+=r.packetsReceived??0;bytes+=r.bytesReceived??0;}}return{packets,bytes};});}
async function media(page,video=true){return until(async()=>{const before={frames:await frames(page),audio:await audio(page)};await new Promise(r=>setTimeout(r,650));const after={frames:await frames(page),audio:await audio(page)};
  const sound=before.audio.packets>0&&after.audio.packets>before.audio.packets&&after.audio.bytes>before.audio.bytes;
  const motion=!video||before.frames.some((f,i)=>f.width>0&&f.height>0&&f.frames>0&&after.frames[i]?.frames>f.frames&&after.frames[i]?.time>f.time);
  return sound&&motion?{before,after}:false;},'decoded remote frames and advancing audio RTP',45000);}
async function backend(type,path,args){const r=await fetch('http://127.0.0.1:3210/api/'+type,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({path,args,format:'json'})});return r.json();}
const sessionKey='garma.device.token';let first,second,share;
try{
 await check('Two independent authenticated browsers prepare a real call',async()=>{first=await device('Media Caller');second=await device('Media Receiver');await chat(first,'Media Receiver');await chat(second,'Media Caller');});
 await check('Two-way video frames and audio RTP advance through the real media server',async()=>{await first.getByRole('button',{name:'تماس تصویری',exact:true}).click();await second.getByRole('button',{name:'پاسخ',exact:true}).click();return{caller:await media(first),receiver:await media(second)};});
 await check('Microphone mute/unmute and camera stop/restart recover actual media',async()=>{
  await first.getByRole('button',{name:'سکوت',exact:true}).click();await first.getByRole('button',{name:'صدا',exact:true}).click();
  await first.getByRole('button',{name:'خاموش',exact:true}).click();await first.getByRole('button',{name:'دوربین',exact:true}).click();return media(second);
 });
 await check('Native handoff is single-use, screen-only and live only during its call',async()=>{
  const token=await first.evaluate(key=>localStorage.getItem(key),sessionKey);
  const calls=await backend('query','calls:myCalls',{token});assert.equal(calls.status,'success');
  const call=calls.value.find(c=>c.status==='active');assert.ok(call);
  const issued=await backend('action','livekit:requestScreenShareHandoff',{token,callId:call.callId});assert.equal(issued.status,'success');
  const redeemed=await backend('action','livekit:redeemScreenShareHandoff',{code:issued.value.code});assert.equal(redeemed.status,'success');share=redeemed.value;
  const claims=JSON.parse(Buffer.from(share.token.split('.')[1],'base64url'));assert.equal(claims.video.canSubscribe,false);assert.equal(claims.video.canPublishData,false);
  assert.deepEqual([...claims.video.canPublishSources].sort(),['screen_share','screen_share_audio']);
  assert.ok(claims.sub.endsWith(':screen'));
  const replay=await backend('action','livekit:redeemScreenShareHandoff',{code:issued.value.code});assert.equal(replay.status,'error');
  assert.equal((await backend('query','screenShare:sessionState',{sessionId:share.sessionId})).value.live,true);
  return{singleUse:true,screenOnly:true,noSubscriptions:true};
 });
 await check('Wi-Fi style temporary signaling loss recovers media without redial',async()=>{
  await first.context().setOffline(true);await new Promise(r=>setTimeout(r,2000));await first.context().setOffline(false);return{caller:await media(first),receiver:await media(second)};
 });
 await check('Hangup ends both interfaces and revokes the native capture session',async()=>{
  await first.getByRole('button',{name:'پایان تماس',exact:true}).click();await second.getByRole('button',{name:'پایان تماس',exact:true}).waitFor({state:'hidden'});
  assert.equal((await backend('query','screenShare:sessionState',{sessionId:share.sessionId})).value.live,false);
  await until(async()=>first.evaluate(()=>window.__garmaPeers.every(p=>p.connectionState==='closed')),'caller peer connection cleanup');
 });
 await check('Audio-only redial carries real RTP without forcing a camera',async()=>{
  await second.getByRole('button',{name:'تماس صوتی',exact:true}).click();await first.getByRole('button',{name:'پاسخ',exact:true}).click();
  const evidence={caller:await media(second,false),receiver:await media(first,false)};
  assert.equal((await frames(first)).length,0);assert.equal((await frames(second)).length,0);
  await second.getByRole('button',{name:'پایان تماس',exact:true}).click();await first.getByRole('button',{name:'پایان تماس',exact:true}).waitFor({state:'hidden'});return evidence;
 });
 await check('Declining a new video call cleans up the caller and permits another call',async()=>{
  await first.getByRole('button',{name:'تماس تصویری',exact:true}).click();await second.getByRole('button',{name:'رد کردن',exact:true}).click();
  await first.getByRole('button',{name:'قطع کردن',exact:true}).waitFor({state:'hidden'});
  await first.getByRole('button',{name:'تماس تصویری',exact:true}).waitFor();
 });
 await groupCall({first,second,device,check,media,frames,until});
 await check('No uncaught browser errors',async()=>{assert.deepEqual(errors,[]);});
}catch(e){console.error(String(e).slice(0,2000));process.exitCode=1;
 for(let i=0;i<pages.length;i++){await pages[i].screenshot({path:`e2e-results/call-failure-${i}.png`,fullPage:true}).catch(()=>{});writeFileSync(`e2e-results/call-page-${i}.txt`,await pages[i].locator('body').innerText().catch(()=>''));}
}finally{report.finishedAt=new Date().toISOString();report.pageErrors=errors;writeFileSync('e2e-results/calls.json',JSON.stringify(report,null,2));diagnostics.save('e2e-results/call-diagnostics.json');for(const ctx of contexts)await ctx.close();await browser.close();}
