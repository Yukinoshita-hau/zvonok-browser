const baseForLease='http://127.0.0.1:48031';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const token=(await readFile('.env','utf8')).split(/\r?\n/).find(s=>s.startsWith('DEV_TOKEN=')).slice(10).trim();
const out=`artifacts/session-reliability-${Date.now()}`;await mkdir(out);const rows=[];let session;
function compose(...args){return execFileSync('docker',['--context','desktop-linux','compose','-f','compose.session.yaml',...args],{encoding:'utf8',stdio:'pipe',timeout:60000});}
async function api(path,method='GET',body){let fenceHeaders={};
  if(method==='POST' && /\/(navigate|back|forward|reload|input)$/.test(path)) {
    const status=await fetch(baseForLease+'/api'+path.replace(/\/[^/]+$/,''),{headers:{authorization:`Bearer ${token}`}});
    const current=await status.json();if(current.collaboration)fenceHeaders={'x-control-epoch':current.collaboration.epoch,'x-control-generation':String(current.collaboration.generation)};
  }
  const r=await fetch('http://127.0.0.1:48031/api'+path,{method,headers:{...fenceHeaders,authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(22000)});return {http:r.status,data:r.status===204?null:await r.json()};}
async function check(name,fn){try{await fn();rows.push({name,result:'PASS'});}catch(e){rows.push({name,result:'FAIL',detail:e.message.slice(0,1000)});}console.table(rows.slice(-1));}
try {
 for(let i=0;i<50;i++){try{if((await api('/ready')).http===200)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 const r=await api('/sessions','POST',{});assert.equal(r.http,201);session=r.data;
 await check('allowed HTTPS example and form under capture',async()=>{
  for(const url of ['https://example.com/','https://www.selenium.dev/selenium/web/web-form.html']) {
    const r=await api(`/sessions/${session.sessionId}/navigate`,'POST',{url});assert.equal(r.http,200);assert.equal(r.data.status,'active');
  }
 });
 await check('restricted proxy network suite under active capture',async()=>{
  const heartbeat=setInterval(()=>void api(`/sessions/${session.sessionId}`).catch(()=>{}),3000);
  try {
    const child=execFile('docker',['--context','desktop-linux','compose','-f','compose.session.yaml','exec','-T','worker','node24','--input-type=module'],{encoding:'utf8',timeout:60000});
    child.stdin.end(await readFile('session/network-check.mjs'));
    await new Promise((resolve,reject)=>{let stdout='',stderr='';child.stdout.on('data',p=>stdout+=p);child.stderr.on('data',p=>stderr+=p);child.on('error',reject);child.on('close',code=>{void writeFile(`${out}/capture-network.log`,stdout+'\n'+stderr).then(()=>code===0?resolve(stdout):reject(Error(`Network suite exit ${code}`)));});});
  }finally{clearInterval(heartbeat);}
 });
 await check('restricted proxy outage fails closed, session survives, retry same session',async()=>{
  compose('stop','proxy');assert.equal((await api('/ready')).http,503);
  assert.equal((await api(`/sessions/${session.sessionId}/navigate`,'POST',{url:'https://example.com/'})).http,503);
  assert.equal((await api(`/sessions/${session.sessionId}`)).data.status,'active');
  compose('start','proxy');for(let i=0;i<30;i++){if((await api('/ready')).http===200)break;await new Promise(r=>setTimeout(r,200));}assert.equal((await api('/ready')).http,200);
  const r=await api(`/sessions/${session.sessionId}/navigate`,'POST',{url:'https://example.com/capture-fixture'});assert.equal(r.http,200);assert.equal(r.data.sessionId,session.sessionId);
 });
 await check('upstream reset and navigation timeout retain browser and recover',async()=>{
  for(const [path,code,classification] of [['capture-upstream-error','UPSTREAM_NAVIGATION_FAILED','upstream'],['capture-timeout','NAVIGATION_TIMEOUT','timeout']]) {
    const result=await api(`/sessions/${session.sessionId}/navigate`,'POST',{url:'https://example.com/'+path});
    assert.equal(result.http,502);assert.equal(result.data.error.code,code);
    const state=await api(`/sessions/${session.sessionId}`);assert.equal(state.data.status,'active');assert.equal(state.data.navigationError,classification);
    const recovered=await api(`/sessions/${session.sessionId}/navigate`,'POST',{url:'https://example.com/capture-fixture'});assert.equal(recovered.http,200);assert.equal(recovered.data.sessionId,session.sessionId);
  }
 });
}finally {
 try{compose('unpause','proxy');}catch{}compose('start','proxy');
 if(session)await api(`/sessions/${session.sessionId}`,'DELETE').catch(()=>{});
 await writeFile(`${out}/results.json`,JSON.stringify(rows,null,2));await writeFile(`${out}/worker.log`,compose('logs','--no-color','worker'));console.log(out);
}
if(rows.some(r=>r.result==='FAIL'))process.exitCode=1;
