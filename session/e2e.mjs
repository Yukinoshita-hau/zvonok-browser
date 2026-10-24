const baseForLease='http://127.0.0.1:48031';
import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const token=(await readFile('.env','utf8')).split(/\r?\n/).find(s=>s.startsWith('DEV_TOKEN=')).slice(10).trim();
const out=`artifacts/session-${process.env.SESSION_RUN??new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:false});
const base='http://127.0.0.1:48031';
const headers={Authorization:`Bearer ${token}`};
async function api(path,method='GET',body) {
  let fenceHeaders={};
  if(method==='POST' && /\/(navigate|back|forward|reload|input)$/.test(path)) {
    const status=await fetch(baseForLease+'/api'+path.replace(/\/[^/]+$/,''),{headers:{authorization:`Bearer ${token}`}});
    const current=await status.json();if(current.collaboration)fenceHeaders={'x-control-epoch':current.collaboration.epoch,'x-control-generation':String(current.collaboration.generation)};
  }
  const r=await fetch(base+'/api'+path,{method,headers:{...fenceHeaders,...headers,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(22000)});
  if(!r.ok)throw Error(`${path}:HTTP${r.status}`);return r.status===204?undefined:r.json();
}
function compose(...args){return execFileSync('docker',['--context','desktop-linux','compose','-f','compose.session.yaml',...args],{encoding:'utf8',stdio:'pipe'});}
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1400,height:1100}});
const rows=[],samples=[],errors=[],resources=[],latencies=[];let png=0,id,oldPage;
page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/\/frame(?:\?|$)/.test(r.url()))png++;});
async function check(name,fn){try{await fn();rows.push({name,result:'PASS'});}catch(e){rows.push({name,result:'FAIL',detail:e.message.split('\n')[0]});console.table(rows.slice(-1));throw e;}}
async function screenshot(name){await page.screenshot({path:`${out}/${name}.png`,fullPage:true});}
async function metrics(){return page.evaluate(()=>window.sessionMediaMetrics);}
async function marker(target=page) {
  return target.evaluate(()=>{
    const v=document.querySelector('video');if(!v?.videoWidth)return null;
    const c=document.createElement('canvas');c.width=1280;c.height=720;const x=c.getContext('2d');x.drawImage(v,0,0,1280,720);
    const p=x.getImageData(0,0,1280,48).data;let action=0,ms=0;
    for(let i=0;i<16;i++)if(p[(28*1280+768+i*16)*4]>128)action+=2**i;
    for(let i=0;i<48;i++)if(p[(28*1280+22+i*12)*4]>128)ms+=2**i;
    return {action,ms};
  });
}
async function point(x,y) {
  const rect=await page.locator('video').boundingBox();const scale=Math.min(rect.width/1280,rect.height/720);
  return {x:rect.x+(rect.width-1280*scale)/2+x*scale,y:rect.y+(rect.height-720*scale)/2+y*scale};
}
async function click(x,y){const p=await point(x,y);await page.mouse.click(p.x,p.y);}
async function changed(before) {
  for(let i=0;i<80;i++){const m=await marker();if(m && m.action>before.action)return m;await page.waitForTimeout(100);}throw Error('Live pixels did not change');
}
try {
  await check('unauthorized create',async()=>assert.equal((await fetch(base+'/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401));
  await page.goto(base);await page.getByLabel('Dev token').fill(token);
  await check('React creates real BrowserSession',async()=>{
    const response=page.waitForResponse(r=>r.url()===base+'/api/sessions' && r.request().method()==='POST');
    await page.getByRole('button',{name:'Создать браузер',exact:true}).click();const s=await(await response).json();assert.equal(s.status,'active');assert(s.browserReady);id=s.sessionId;assert(s.media.epoch);await screenshot('01-session-created');
  });
  await check('viewer grant bound to session and epoch',async()=>{
    const auth=await api(`/sessions/${id}/media`,'POST');
    const claims=JSON.parse(Buffer.from(auth.token.split('.')[1],'base64url'));
    assert.equal(claims.video.room,auth.room);assert.equal(claims.video.canPublish,false);assert.equal(claims.video.canSubscribe,true);assert.equal(claims.video.canPublishData,false);assert.equal(claims.video.roomAdmin,undefined);
  });
  await check('actual live decoded frames',async()=>{await page.waitForFunction(()=>window.sessionMediaMetrics?.framesDecoded>10,null,{timeout:45000});});
  await check('URL navigation to real Chromium fixture',async()=>{
    await page.getByLabel('HTTPS адрес').fill('https://example.com/capture-fixture');await page.getByRole('button',{name:'Перейти',exact:true}).click();
    for(let i=0;i<100;i++){const m=await marker();if(m && Math.abs(Date.now()-m.ms)<5000)break;if(i===99)throw Error('Fixture not visible in video');await page.waitForTimeout(100);}
    await screenshot('02-live-website');
  });
  await check('coordinate click and typed pixels',async()=>{
    await click(170,244);const before=await marker();await page.keyboard.type('Slice 2B.2',{delay:120});await changed(before);await page.waitForTimeout(800);await screenshot('03-text-typed');
  });
  await check('Backspace Tab Enter',async()=>{const before=await marker();await page.keyboard.press('Backspace');await changed(before);await page.keyboard.press('Tab');await page.keyboard.press('Enter');});
  await check('wheel changes real live pixels',async()=>{const before=await marker();const p=await point(1000,600);await page.mouse.move(p.x,p.y);await page.mouse.wheel(0,500);await changed(before);await screenshot('04-scrolled');});
  await check('back forward reload on same BrowserSession',async()=>{
    await api(`/sessions/${id}/navigate`,'POST',{url:'https://example.com/capture-fixture#second'});
    await api(`/sessions/${id}/back`,'POST',{});await api(`/sessions/${id}/forward`,'POST',{});await api(`/sessions/${id}/reload`,'POST',{});
    assert.equal((await api(`/sessions/${id}`)).sessionId,id);
  });
  await check('narrow viewport letterbox rejects clicks',async()=>{
    await page.setViewportSize({width:390,height:900});await page.waitForTimeout(500);
    const before=await marker();const rect=await page.locator('video').boundingBox();await page.mouse.click(rect.x+5,rect.y+5);await page.waitForTimeout(300);assert.equal((await marker()).action,before.action);
    await page.setViewportSize({width:1400,height:1100});
  });
  await check('input-to-observed-pixel upper bound',async()=>{
    await api(`/sessions/${id}/reload`,'POST',{});await api(`/sessions/${id}/input`,'POST',{type:'wheel',x:1000,y:500,deltaX:0,deltaY:-2000});await page.waitForTimeout(800);
    for(let i=0;i<20;i++) {
      const before=await marker(),started=performance.now();await click(430,244);await changed(before);latencies.push(performance.now()-started);
    }
  });
  await check('720p steady decoded video' ,async()=>{
    await page.waitForTimeout(2000);
    for(let i=0;i<Number(process.env.SESSION_SECONDS??35);i++){await page.waitForTimeout(1000);samples.push(await metrics());if(process.env.SESSION_RESOURCES!=='0' && i%10===0)resources.push({at:Date.now(),docker:compose('stats','--no-stream','--format','{{json .}}'),pressure:compose('exec','-T','worker','sh','-c','cat /proc/pressure/memory; cat /proc/meminfo | head -n 3')});}
    const first=samples[0],last=samples.at(-1),fps=(last.framesDecoded-first.framesDecoded)*1000/(last.at-first.at);
    rows.push({name:'decoded FPS',result:fps>=(process.env.MEDIA_FPS==='30'?28:14.25)?'PASS':'FAIL',fps,seconds:(last.at-first.at)/1000});
    assert(samples.every(s=>s.width===1280 && s.height===720 && s.fresh),'resolution/freeze');
  });
  await check('publisher restart preserves BrowserSession',async()=>{
    const before=await marker();assert(before);compose('restart','publisher');await screenshot('05-media-reconnect');
    for(let i=0;i<150;i++){await page.waitForTimeout(200);const m=await marker();if(m?.ms>before.ms+1000 && Math.abs(Date.now()-m.ms)<2000)break;if(i===149)throw Error('Publisher did not recover');}
    assert.equal((await api(`/sessions/${id}`)).status,'active');
  });
  await check('viewer reconnect without new Chromium',async()=>{const before=await metrics();await page.getByRole('button',{name:'Переподключить видео'}).click();await page.waitForTimeout(2000);await page.waitForFunction(()=>window.sessionMediaMetrics?.fresh,null,{timeout:30000});assert.equal((await api(`/sessions/${id}`)).sessionId,id);});
  await check('independent old viewer subscribes A',async()=>{
    const invite=await api('/sessions/'+id+'/invite','POST',{});
    oldPage=await browser.newPage();await oldPage.goto(base);
    await oldPage.getByLabel('Приглашение',{exact:true}).fill(invite.sessionId+'.'+invite.epoch+'.'+invite.invite);
    await oldPage.getByRole('button',{name:'Присоединиться',exact:true}).click();
    await oldPage.waitForFunction(()=>window.sessionMediaMetrics?.framesDecoded>10,null,{timeout:30000});
  });
  await check('DELETE stops publication and removes video',async()=>{
    await page.getByRole('button',{name:'Завершить',exact:true}).click();await page.waitForSelector('[data-testid=session-ended]');assert.equal(await page.locator('video').count(),0);await screenshot('06-session-ended');
    assert.equal((await fetch(base+`/api/sessions/${id}/media`,{method:'POST',headers})).status,409);
    const processes=compose('exec','-T','worker','ps','-eo','comm');assert(!/^(chrome|chromium|Xvfb|ffmpeg|pulseaudio)$/m.test(processes));
  });
  await check('old viewer cannot receive B',async()=>{
    await oldPage.waitForTimeout(2500);
    assert.equal(await oldPage.locator('video').count(),0);
    const oldId=id;
    const response=page.waitForResponse(r=>r.url()===base+'/api/sessions' && r.request().method()==='POST');
    await page.getByRole('button',{name:'Создать браузер',exact:true}).click();const next=await(await response).json();id=next.sessionId;assert.notEqual(id,oldId);
    await page.waitForFunction(()=>window.sessionMediaMetrics?.fresh,null,{timeout:30000});
    await api(`/sessions/${id}/navigate`,'POST',{url:'https://example.com/capture-fixture'});await page.waitForTimeout(2500);
    assert.equal(await oldPage.locator('video').count(),0);
    assert.equal((await fetch(base+`/api/sessions/${oldId}/media`,{method:'POST',headers})).status,404);
  });
} catch(e) {rows.push({name:'campaign',result:'FAIL',detail:e.message});await screenshot('failure').catch(()=>{});}
finally {
  if(id)await api(`/sessions/${id}`,'DELETE').catch(()=>{});
  await writeFile(`${out}/results.json`,JSON.stringify({rows,samples,resources,latencies,pngRequests:png,pageErrors:errors},null,2));
  try {await writeFile(`${out}/worker.log`,compose('logs','--no-color','worker'));await writeFile(`${out}/publisher.log`,compose('logs','--no-color','publisher'));}finally{await browser.close();}console.table(rows);console.log(out);
}
if(rows.some(r=>r.result==='FAIL') || errors.length || png)process.exitCode=1;
