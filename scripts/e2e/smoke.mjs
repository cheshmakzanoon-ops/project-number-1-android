import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { observeBrowser } from './diagnostics.mjs';
const require=createRequire(resolve(process.env.E2E_TOOLS ?? '.', 'package.json'));
const {chromium}=require('playwright');
const ORIGIN='https://garma-ci.test';
const INVITE='garma-isolated-browser-test-invitation-2026';
const report={scope:'Production bundle and content-security policy with real isolated Convex HTTPS storage; synthetic voice recording; calls are verified separately with real LiveKit; no production deployment or physical phones.',commit:process.env.GITHUB_SHA,checks:[]};
mkdirSync('e2e-results',{recursive:true});
const hosts=['garma-ci.test','garma-ci-media.test','precise-ptarmigan-412.eu-west-1.convex.cloud','precise-ptarmigan-412.eu-west-1.convex.site'];
for(const host of hosts) assert.equal((await lookup(host)).address,'127.0.0.1','Refuse to contact non-loopback infrastructure');
const browser=await chromium.launch({headless:true,args:['--ignore-certificate-errors','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const pages=[];const contexts=[];const pageErrors=[];
const diagnostics=observeBrowser();
async function context() {
  const ctx=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:430,height:900},permissions:['camera','microphone','clipboard-read','clipboard-write'],reducedMotion:'reduce'});
  contexts.push(ctx);const page=await ctx.newPage();pages.push(page);
  diagnostics.attach(page,pages.length);
  page.on('pageerror',e=>pageErrors.push(e.message));
  // No account data or token-bearing request URLs are logged.
  page.setDefaultTimeout(20000);return page;
}
async function check(name,fn) {
  const started=Date.now();
  try {const evidence=await fn();report.checks.push({name,passed:true,durationMs:Date.now()-started,evidence});console.log('PASS: '+name);}
  catch(error) {report.checks.push({name,passed:false,durationMs:Date.now()-started,error:String(error).slice(0,4000)});throw error;}
  finally {writeFileSync('e2e-results/report.json',JSON.stringify(report,null,2));}
}
async function until(fn, description, ms=20000) {
  const start=Date.now();let last;
  while(Date.now()-start<ms){try{last=await fn();if(last)return last;}catch{}await new Promise(r=>setTimeout(r,150));}
  throw new Error('Timed out: '+description+'; last='+String(last));
}
async function register(page,name) {
  await page.goto(ORIGIN+'/#invite='+INVITE);
  await page.getByRole('textbox',{name:'نام نمایشی'}).fill(name);
  await page.getByRole('button',{name:'ورود به گرما',exact:true}).click();
  await page.getByRole('button',{name:'گفتگوی جدید',exact:true}).first().waitFor();
  assert.equal(new URL(page.url()).hash,'','Consumed invitation must leave the address bar');
}
async function openChat(page,name) {
  await page.getByRole('button',{name:'گفتگوی جدید',exact:true}).first().click();
  await page.getByText(name,{exact:true}).last().click();
  await page.getByPlaceholder('پیام خود را بنویسید…').waitFor();
}
async function send(page,text) {
  await page.getByPlaceholder('پیام خود را بنویسید…').fill(text);
  await page.getByRole('button',{name:'ارسال',exact:true}).click();
  await page.getByText(text,{exact:true}).first().waitFor();
}
const child=await context(),dad=await context();
try {
  await check('Invitation-only UI enrollment for two isolated devices',async()=>{await register(child,'CI Child');await register(dad,'CI Dad');});
  await check('Authenticated invitation copy preserves the invitation fragment',async()=>{
    await child.getByRole('button',{name:'گفتگوی جدید',exact:true}).first().click();
    await child.getByRole('button',{name:'کپی پیوند دعوت خانواده',exact:true}).click();
    await child.getByText('پیوند کپی شد — برای مامان و بابا بفرست',{exact:true}).waitFor();
    assert.equal(await child.evaluate(()=>navigator.clipboard.readText()),ORIGIN+'/#invite='+INVITE);
    await child.getByRole('button',{name:'بستن',exact:true}).last().click();
  });
  await check('Create the same DM from each device without duplicate conversations',async()=>{await openChat(child,'CI Dad');await openChat(dad,'CI Child');});
  await check('Two-way messages and displayed-message read receipts',async()=>{
    await send(child,'CI hello from child');await dad.getByText('CI hello from child',{exact:true}).waitFor();
    await send(dad,'CI hello from dad');await child.getByText('CI hello from dad',{exact:true}).waitFor();
    await child.getByTitle('خوانده شد',{exact:true}).first().waitFor();
  });
  await check('Reply and emoji reaction survive real backend serialization',async()=>{
    await dad.getByText('CI hello from child',{exact:true}).click();
    await dad.getByRole('button',{name:'پاسخ',exact:true}).click();
    await dad.getByPlaceholder(/پاسخ به/).fill('CI reply with quote');await dad.getByRole('button',{name:'ارسال',exact:true}).click();
    await child.getByText('CI reply with quote',{exact:true}).waitFor();
    await child.getByText('CI reply with quote',{exact:true}).click();await child.getByRole('button',{name:'👍',exact:true}).click();
    await dad.getByText('👍',{exact:true}).waitFor();
  });
  await check('Edit and delete own message update the other browser',async()=>{
    await child.getByText('CI hello from child',{exact:true}).first().click();await child.getByRole('button',{name:'ویرایش',exact:true}).click();
    await child.getByPlaceholder('ویرایش متن…').fill('CI edited text');await child.getByRole('button',{name:'ارسال',exact:true}).click();
    await dad.locator('[data-mid] p.whitespace-pre-wrap').filter({hasText:/^CI edited text$/}).waitFor();
    await child.locator('[data-mid] p.whitespace-pre-wrap').filter({hasText:/^CI edited text$/}).click();await child.getByRole('button',{name:'حذف',exact:true}).click();
    await dad.getByText('این پیام حذف شد',{exact:true}).waitFor();
  });
  await check('Owned image upload is rendered on the other device',async()=>{
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAwAAAAMCAIAAADZF8uwAAAAF0lEQVR4nGPUTdvDQAgwEVQxqmgAFAEAWIEBZ+DAdM0AAAAASUVORK5CYII=','base64');
    await child.locator('input[type=file]').first().setInputFiles({name:'test.png',mimeType:'image/png',buffer:png});
    await child.getByRole('button',{name:'ارسال عکس',exact:true}).click();
    await until(()=>dad.locator('[data-mid] img').evaluateAll(images=>images.some(i=>i.complete&&i.naturalWidth===12&&i.naturalHeight===12)),'recipient image pixels');
  });
  await check('Recorded voice note uploads and can be played by the recipient',async()=>{
    await child.getByRole('button',{name:'ضبط پیام صوتی',exact:true}).click();
    await child.getByRole('button',{name:'ارسال پیام صوتی',exact:true}).waitFor();
    await new Promise(r=>setTimeout(r,1600));await child.getByRole('button',{name:'ارسال پیام صوتی',exact:true}).click();
    await dad.locator('audio').last().waitFor({state:'attached'});
    const duration=await dad.locator('audio').last().evaluate(async a=>{await a.play();await new Promise(r=>setTimeout(r,400));const time=a.currentTime;a.pause();return time;});
    assert.ok(duration>0,'actual media playback time must advance');return {playbackSeconds:duration};
  });
  await check('Offline outgoing text remains visible and reaches its peer after reconnect',async()=>{
    await child.context().setOffline(true);await send(child,'CI queued offline');
    assert.equal(await dad.getByText('CI queued offline',{exact:true}).count(),0);
    await child.context().setOffline(false);await dad.getByText('CI queued offline',{exact:true}).waitFor({timeout:45000});
  });
  await check('The production service worker precaches all compiled assets',async()=>{
    const cached=await child.evaluate(async()=>{await navigator.serviceWorker.ready;const keys=await caches.keys();const name=keys.filter(k=>k.startsWith('garma-shell-')).at(-1);const cache=await caches.open(name);return (await cache.keys()).map(k=>new URL(k.url).pathname);});
    const version=JSON.parse(readFileSync('dist/version.json','utf8'));
    assert.equal(cached.filter(p=>p.startsWith('/assets/')).length,version.assets);return {compiledAssets:version.assets};
  });
  await check('An offline reload renders the saved identity and compiled app shell',async()=>{
    await child.context().setOffline(true);await child.reload({waitUntil:'domcontentloaded'});
    await child.getByRole('button',{name:'گفتگوی جدید',exact:true}).first().waitFor();
    assert.equal(await child.getByRole('button',{name:'ورود به گرما',exact:true}).count(),0);
    await child.context().setOffline(false);
  });
  await check('No uncaught page errors',async()=>{assert.deepEqual(pageErrors,[]);});
  await child.screenshot({path:'e2e-results/child.png',fullPage:true});await dad.screenshot({path:'e2e-results/dad.png',fullPage:true});
} catch(error) {
  console.error(String(error).slice(0,4000));process.exitCode=1;
  for(let i=0;i<pages.length;i++){await pages[i].screenshot({path:`e2e-results/failure-${i}.png`,fullPage:true}).catch(()=>{});writeFileSync(`e2e-results/page-${i}.txt`,(await pages[i].locator('body').innerText().catch(()=>'')));}
} finally {
  report.finishedAt=new Date().toISOString();report.pageErrors=pageErrors;
  writeFileSync('e2e-results/report.json',JSON.stringify(report,null,2));
  diagnostics.save('e2e-results/diagnostics.json');
  for(const ctx of contexts) await ctx.close();await browser.close();
}
