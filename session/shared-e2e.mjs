import {chromium} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const owner=(await readFile('.env','utf8')).split(/\r?\n/).find(s=>s.startsWith('DEV_TOKEN=')).slice(10).trim();
const out=`artifacts/slice3-shared-${Date.now()}`;await mkdir(out);
const base='http://127.0.0.1:48031',rows=[],samples=[],errors=[];
const browser=await chromium.launch({channel:'chrome',headless:true});
const contextA=await browser.newContext({viewport:{width:1400,height:1100}}),contextB=await browser.newContext({viewport:{width:1400,height:1100}});
const a=await contextA.newPage(),b=await contextB.newPage();
let session,guest,oldAuth,invite,heartbeat,joined=false,png=0;
for(const p of [a,b]){p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.url().endsWith('/frame'))png++;});}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function compose(...args){return execFileSync('docker',['--context','desktop-linux','compose','-f','compose.session.yaml',...args],{encoding:'utf8',stdio:'pipe',timeout:60000});}
async function raw(token,path,method='GET',body,lease,extra={}) {
  const c=lease?.collaboration??lease;
  const r=await fetch(base+'/api'+path,{method,headers:{authorization:`Bearer ${token}`,...(c?{'x-control-epoch':c.epoch,'x-control-generation':String(c.generation)}:{}),...(body===undefined?{}:{'content-type':'application/json'}),...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(22000)});
  return {status:r.status,data:r.status===204?null:await r.json()};
}
async function api(token,path,method='GET',body,lease) {const r=await raw(token,path,method,body,lease);assert(r.status<300,`${method} ${path}: ${r.status} ${JSON.stringify(r.data)}`);return r.data;}
const path=suffix=>`/sessions/${session.sessionId}${suffix}`;
const state=token=>api(token,path(''));
async function control(token,op) {return api(token,path('/control/'+op),'POST',{},await state(token));}
async function input(token,body,lease) {return api(token,path('/input'),'POST',body,lease??await state(token));}
async function check(name,fn){try{await fn();rows.push({name,result:'PASS'});}catch(e){rows.push({name,result:'FAIL',detail:e.message.slice(0,1800)});throw e;}finally{console.table(rows.slice(-1));}}
async function until(fn,ms=30000) {const start=Date.now();while(Date.now()-start<ms){try{if(await fn())return;}catch{}await sleep(200);}throw Error('Condition timed out');}
const metrics=p=>p.evaluate(()=>window.sessionMediaMetrics);
async function marker(p) {return p.evaluate(()=>{
  const v=document.querySelector('video');if(!v?.videoWidth)return null;
  const c=document.createElement('canvas');c.width=1280;c.height=48;const x=c.getContext('2d');x.drawImage(v,0,0,1280,720);
  const d=x.getImageData(0,0,1280,48).data;let action=0,ms=0,textLength=0;
  for(let i=0;i<16;i++)if(d[(28*1280+768+i*16)*4]>128)action+=2**i;
  for(let i=0;i<48;i++)if(d[(28*1280+22+i*12)*4]>128)ms+=2**i;
  for(let i=0;i<8;i++)if(d[(28*1280+1032+i*16)*4]>128)textLength+=2**i;
  return {action,ms,textLength};
});}
async function click(p,x,y) {const r=await p.locator('video').boundingBox(),{width,height}=session.media,scale=Math.min(r.width/width,r.height/height);await p.mouse.click(r.x+(r.width-width*scale)/2+x*scale,r.y+(r.height-height*scale)/2+y*scale);}
async function gateDenied(auth) {const r=await fetch('http://127.0.0.1:48033/rtc/validate?access_token='+encodeURIComponent(auth.token));assert.equal(r.status,403);}
async function cleanProcesses(){
  assert(!/^(chrome|chromium|Xvfb|ffmpeg|pulseaudio)$/m.test(compose('exec','-T','worker','ps','-eo','comm')));
  assert.equal(compose('exec','-T','worker','sh','-c','find /tmp -maxdepth 1 -name "session-profile-*"').trim(),'');
  const count=compose('exec','-T','broker','node','--input-type=module','-e',`import{readFile}from'node:fs/promises';import{RoomServiceClient}from'livekit-server-sdk';const secret=(await readFile('/secrets/livekit.yaml','utf8')).match(/  spike: (\\w+)/)[1];console.log((await new RoomServiceClient('http://livekit:7880','spike',secret).listRooms()).length);`);
  assert.equal(count.trim(),'0','LiveKit room cleanup');
}
try {
  await until(async()=>(await fetch(base+'/api/ready')).ok);
  await check('A creates one real BrowserSession; B accepts invite with independent identity',async()=>{
    await a.goto(base);await a.getByLabel('Dev token',{exact:true}).fill(owner);
    const created=a.waitForResponse(r=>r.url()===base+'/api/sessions' && r.request().method()==='POST');await a.getByRole('button',{name:'Создать браузер',exact:true}).click();
    session=await(await created).json();assert.equal(session.status,'active');
    await a.getByRole('button',{name:'Пригласить B',exact:true}).click();
    invite=await a.getByLabel('Приглашение для B (60 секунд, один вход)',{exact:true}).inputValue();assert(invite);
    await b.goto(base);assert.equal(await b.getByLabel('Dev token',{exact:true}).inputValue(),'');
    await b.getByLabel('Приглашение',{exact:true}).fill(invite);
    const accepted=b.waitForResponse(r=>r.url().endsWith('/accept'));await b.getByRole('button',{name:'Присоединиться',exact:true}).click();
    const auth=await(await accepted).json();guest=auth.token;assert.notEqual(guest,owner);assert.notEqual(auth.identity,'local-owner');joined=true;
    assert.equal(auth.session.collaboration.role,'guest');assert.equal(auth.session.media.epoch,session.media.epoch);
    const local=await b.evaluate(()=>JSON.parse(sessionStorage.getItem('shared-browser')));assert.equal(local.token,guest);
  });
  await check('membership, role spoofing, invite replay, unauthorized join/control/DELETE',async()=>{
    const [id,epoch,capability]=invite.split('.');
    assert.equal((await raw('',`/sessions/${id}/accept`,'POST',{epoch,invite:capability})).status,403);
    for(const [suffix,method,body] of [['','DELETE'],['/invite','POST',{}],['/control/grant','POST',{}]])assert.equal((await raw(guest,path(suffix),method,body,await state(guest))).status,403);
    assert.equal((await raw(guest,'/sessions','POST',{})).status,403);
    assert.equal((await raw(guest,'/sessions/'+crypto.randomUUID())).status,404);
    assert.equal((await raw('x'.repeat(43),path(''),'GET',undefined,undefined,{'x-browser-owner':'1',cookie:'owner=1'})).status,403);
    assert.equal((await raw(guest,path('/navigate'),'POST',{url:'https://example.com/'},await state(guest))).status,403);
    const mediaA=await api(owner,path('/media'),'POST'),mediaB=await api(guest,path('/media'),'POST');oldAuth=mediaB;
    const claims=x=>JSON.parse(Buffer.from(x.token.split('.')[1],'base64url'));
    assert.notEqual(claims(mediaA).sub,claims(mediaB).sub);assert.equal(mediaA.room,mediaB.room);
    for(const m of [mediaA,mediaB]){const c=claims(m);assert.equal(c.video.canPublish,false);assert.equal(c.video.canPublishData,false);assert.equal(c.video.canSubscribe,true);assert.equal(c.video.roomAdmin,undefined);}
    await sleep(1100);
    const burst=await Promise.all(Array.from({length:32},()=>raw(guest,path(''))));assert(burst.some(r=>r.status===429));
    const ownerState=await state(owner);assert.equal((await raw(owner,path('/control/revoke'),'POST',{},ownerState)).status,200);
  });
  await check('both clients decode same advancing real Chromium clock, one publication/process tree',async()=>{
    await api(owner,path('/navigate'),'POST',{url:'https://example.com/capture-fixture'},await state(owner));
    await until(async()=>{const ma=await marker(a),mb=await marker(b);return ma && mb && Math.abs(Date.now()-ma.ms)<3000 && Math.abs(ma.ms-mb.ms)<2000;},45000);
    for(const p of [a,b])await until(async()=>(await metrics(p))?.framesDecoded>10);
    const ps=compose('exec','-T','worker','ps','-eo','args');
    assert.equal(ps.split('\n').filter(l=>l.startsWith('Xvfb ')).length,1);assert.equal(ps.split('\n').filter(l=>l.startsWith('ffmpeg ')).length,2);
    assert.equal(ps.split('\n').filter(l=>/\/chrome .*--user-data-dir=/.test(l) && !l.includes('--type=')).length,1);
    const publications=await a.evaluate(()=>window.sessionMediaMetrics.publications);assert.equal(publications,1);
  });
  await check('owner controls; guest UI sends no Chromium input before lease',async()=>{
    assert.equal(await b.getByRole('button',{name:'Перейти',exact:true}).isDisabled(),true);
    const before=await marker(a);await click(b,170,244);await b.keyboard.type('blocked');await sleep(500);assert.equal((await marker(a)).action,before.action);
    assert.equal((await raw(guest,path('/input'),'POST',{type:'text',text:'blocked'},await state(guest))).status,403);
    await click(a,170,244);await a.keyboard.type('A');await until(async()=>(await marker(b))?.textLength===1);
  });
  await check('request/decline/re-request/grant; B types and scrolls; A observes actual pixels',async()=>{
    await b.getByRole('button',{name:'Запросить управление',exact:true}).click();await a.getByRole('button',{name:'Отказать',exact:true}).click();await until(async()=>(await state(guest)).collaboration.result==='declined');
    await until(async()=>await b.getByRole('button',{name:'Запросить управление',exact:true}).isEnabled());await b.getByRole('button',{name:'Запросить управление',exact:true}).click();
    await a.getByRole('button',{name:'Передать управление',exact:true}).click();await until(async()=>await b.getByRole('button',{name:'Перейти',exact:true}).isEnabled());
    await click(b,170,244);await b.keyboard.type('Shared',{delay:100});await until(async()=>(await marker(a))?.textLength===7 && (await marker(b))?.textLength===7);
    assert.equal(await a.getByRole('button',{name:'Перейти',exact:true}).isDisabled(),true);
    const before=await marker(a);await input(guest,{type:'wheel',x:1000,y:600,deltaX:0,deltaY:400});await until(async()=>(await marker(a))?.action>before.action);
    await a.screenshot({path:out+'/owner-watching.png',fullPage:true});await b.screenshot({path:out+'/guest-controlling.png',fullPage:true});
  });
  await check('concurrent queued B input/revoke is fenced before execution; A input denied while B controls',async()=>{
    const lease=await state(guest);
    const navigation=raw(guest,path('/navigate'),'POST',{url:'https://example.com/capture-timeout'},lease);
    await sleep(500);const queued=Array.from({length:16},()=>0).map(()=>raw(guest,path('/input'),'POST',{type:'text',text:'LATE'},lease));await sleep(150);
    assert.equal((await raw(owner,path('/input'),'POST',{type:'text',text:'A'},lease)).status,403);
    const revoked=control(owner,'revoke');await navigation;const results=await Promise.all(queued);await revoked;
    assert(results.every(r=>[403,429].includes(r.status)),JSON.stringify(results.map(r=>r.status)));assert(results.some(r=>r.status===429),'bounded queue must reject overload');
    assert.equal((await raw(guest,path('/input'),'POST',{type:'text',text:'old'},lease)).status,403);
    assert.equal((await raw(owner,path('/control/grant'),'POST',{},lease)).status,403);
    assert.equal((await state(owner)).collaboration.controller,'local-owner');
  });
  await check('guest reconnect obtains authoritative viewing state; stale media hidden and recovers',async()=>{
    await b.reload();await until(async()=>(await metrics(b))?.fresh);
    assert.equal(await b.getByRole('button',{name:'Перейти',exact:true}).isDisabled(),true);
    const before=await marker(b);await b.getByRole('button',{name:'Переподключить видео',exact:true}).click();await until(async()=>(await marker(b))?.ms>before.ms+1000);
  });
  await check('lease expiry returns owner; old heartbeat/replayed commands cannot restore B',async()=>{
    await control(guest,'request');const lease=await control(owner,'grant');
    await contextB.setOffline(true);await sleep(16500);
    assert.equal((await state(owner)).collaboration.controller,'local-owner');await contextB.setOffline(false);
    assert.equal((await raw(guest,path('/input'),'POST',{type:'text',text:'expired'},lease)).status,403);
    await until(async()=>(await metrics(b))?.fresh);
  });
  await check('owner reconnect within 30s preserves epoch; guest never becomes owner',async()=>{
    await contextA.setOffline(true);await sleep(4000);assert.equal((await state(guest)).status,'active');await contextA.setOffline(false);
    await a.reload();await until(async()=>(await metrics(a))?.fresh);
    assert.equal((await state(owner)).media.epoch,session.media.epoch);assert.equal((await state(guest)).collaboration.role,'guest');
  });
  await check(`limited two-viewer ${session.media.profile} decoded FPS, delivery and publisher CPU/RAM`,async()=>{
    for(let i=0;i<26;i++){await sleep(1000);samples.push({a:await metrics(a),b:await metrics(b)});}
    for(const key of ['a','b']){const first=samples[0][key],last=samples.at(-1)[key],fps=(last.framesDecoded-first.framesDecoded)*1000/(last.at-first.at);rows.push({name:`${key} decoded FPS`,result:fps>=session.media.fps*.95?'PASS':'FAIL',fps,targetFps:session.media.fps,seconds:(last.at-first.at)/1000});assert(fps>=session.media.fps*.95);assert(samples.every(s=>s[key]?.width===session.media.width && s[key]?.height===session.media.height && s[key]?.fresh));assert(last.bytesReceived>first.bytesReceived);assert.equal(last.publications,1);}
    await writeFile(out+'/resources.jsonl',compose('stats','--no-stream','--format','{{json .}}'));
  });
  await check('expired viewer JWT rejected by signaling gate while membership remains',async()=>{await gateDenied(oldAuth);});
  await check('publisher restart reconnects both viewers without second BrowserSession',async()=>{
    const ma=await marker(a),mb=await marker(b);compose('restart','publisher');
    await until(async()=>{const x=await marker(a),y=await marker(b);return x?.ms>ma.ms+1000 && y?.ms>mb.ms+1000 && Math.abs(Date.now()-x.ms)<3000;},45000);
    assert.equal((await state(owner)).sessionId,session.sessionId);
  });
  await check('guest access revoke disconnects live video, rejects API and unexpired cached LiveKit token',async()=>{
    oldAuth=await api(guest,path('/media'),'POST');await api(owner,path('/guest'),'DELETE');joined=false;
    await until(async()=>await b.locator('video').count()===0);assert.equal((await raw(guest,path('/media'),'POST')).status,403);
    assert.equal((await raw(guest,path(''))).status,403);await gateDenied(oldAuth);
  });
  await check('revoked invite rejected; fresh guest may leave but never DELETE owner session',async()=>{
    const revoked=await api(owner,path('/invite'),'POST',{});await api(owner,path('/invite'),'DELETE');
    assert.equal((await raw('',path('/accept'),'POST',{invite:revoked.invite,epoch:revoked.epoch})).status,403);
    const fresh=await api(owner,path('/invite'),'POST',{}),auth=await api('',path('/accept'),'POST',{invite:fresh.invite,epoch:fresh.epoch});guest=auth.token;
    await api(guest,path('/leave'),'POST',{});assert.equal((await state(owner)).status,'active');assert.equal((await raw(guest,path(''))).status,403);
  });
  await check('owner End immediately cleans room/processes/profiles; old guest isolated from next epoch',async()=>{
    const old=session;await a.getByRole('button',{name:'Завершить',exact:true}).click();await until(async()=>await a.locator('video').count()===0);await cleanProcesses();await gateDenied(oldAuth);
    session=await api(owner,'/sessions','POST',{});assert.notEqual(session.media.epoch,old.media.epoch);
    assert.equal((await raw(guest,path(''))).status,403);assert.equal((await raw(owner,`/sessions/${old.sessionId}`)).status,404);await gateDenied(oldAuth);
    const delayed=raw(owner,path('/navigate'),'POST',{url:'https://example.com/capture-timeout'},await state(owner));await sleep(500);
    await api(owner,path(''),'DELETE');assert((await delayed).status>=400);await cleanProcesses();
    session=await api(owner,'/sessions','POST',{});
    const invite=await api(owner,path('/invite'),'POST',{}),auth=await api('',path('/accept'),'POST',{invite:invite.invite,epoch:invite.epoch});
    await sleep(31500);assert.equal((await state(owner)).status,'closed');
    const terminal=await raw(auth.token,path(''));assert.equal(terminal.status,403);assert.equal(terminal.data.error.code,'SESSION_ENDED');await cleanProcesses();
  });
  assert.equal(errors.length,0,errors.join('\n'));assert.equal(png,0);
} catch(e) {console.error(e.message);process.exitCode=1;}
finally {
  clearInterval(heartbeat);if(session)await raw(owner,path(''),'DELETE').catch(()=>{});
  await browser.close();await writeFile(out+'/results.json',JSON.stringify({rows,samples,errors,pngRequests:png},null,2));console.log(out);
}
if(rows.some(row=>row.result==='FAIL'))process.exitCode=1;
