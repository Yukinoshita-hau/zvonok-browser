const baseForLease='http://127.0.0.1:48031';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const token=(await readFile('.env','utf8')).split(/\r?\n/).find(s=>s.startsWith('DEV_TOKEN=')).slice(10).trim();
const out=`artifacts/session-lifecycle-${Date.now()}`;await mkdir(out);
const rows=[];let session;
function compose(...args){return execFileSync('docker',['--context','desktop-linux','compose','-f','compose.session.yaml',...args],{encoding:'utf8',stdio:'pipe',timeout:60000});}
async function api(path,method='GET',body){let fenceHeaders={};
  if(method==='POST' && /\/(navigate|back|forward|reload|input)$/.test(path)) {
    const status=await fetch(baseForLease+'/api'+path.replace(/\/[^/]+$/,''),{headers:{authorization:`Bearer ${token}`}});
    const current=await status.json();if(current.collaboration)fenceHeaders={'x-control-epoch':current.collaboration.epoch,'x-control-generation':String(current.collaboration.generation)};
  }
  const r=await fetch('http://127.0.0.1:48031/api'+path,{method,headers:{...fenceHeaders,authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(22000)});if(!r.ok){const code=(await r.json().catch(()=>null))?.error?.code;throw Error(`${method} ${path}: HTTP${r.status}${typeof code==='string'?' '+code:''}`);}return r.status===204?null:r.json();}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function ready(){for(let i=0;i<50;i++){try{await api('/ready');return;}catch{await sleep(200);}}throw Error('Worker unavailable');}
async function create(){await ready();session=await api('/sessions','POST',{});assert.equal(session.status,'active');await api(`/sessions/${session.sessionId}/navigate`,'POST',{url:'https://example.com/capture-fixture'});return session;}
async function clean(status){for(let i=0;i<50;i++){const s=await api(`/sessions/${session.sessionId}`);if(s.status===status)break;if(i===49)throw Error(`terminal ${s.status}, expected ${status}`);await sleep(200);}
 const p=compose('exec','-T','worker','ps','-eo','comm');assert(!/^(chrome|chromium|Xvfb|ffmpeg|pulseaudio)$/m.test(p));
 const files=compose('exec','-T','worker','sh','-c','find /tmp -maxdepth 1 -name "session-profile-*"');assert.equal(files.trim(),'');
 const r=await fetch(`http://127.0.0.1:48031/api/sessions/${session.sessionId}/media`,{method:'POST',headers:{authorization:`Bearer ${token}`}});assert.equal(r.status,409);
}
async function check(name,fn){try{await fn();rows.push({name,result:'PASS'});}catch(e){rows.push({name,result:'FAIL',detail:e.message.split('\n')[0]});}console.table(rows.slice(-1));}
try {
 await check('DELETE',async()=>{await create();await api(`/sessions/${session.sessionId}`,'DELETE');await clean('closed');});
 await check('FFmpeg crash recovers same session then DELETE cleans audio/display/profile',async()=>{await create();const epoch=session.media.epoch;compose('exec','-T','worker','pkill','-KILL','ffmpeg');await sleep(5000);const s=await api(`/sessions/${session.sessionId}`);assert.equal(s.status,'active');assert.equal(s.media.epoch,epoch);assert.equal(s.media.state,'streaming');await api(`/sessions/${session.sessionId}`,'DELETE');await clean('closed');});
 await check('audio server crash fails closed and cleans entire source tree',async()=>{await create();compose('exec','-T','worker','pkill','-KILL','pulseaudio');await clean('crashed');});
 await check('Chromium renderer crash',async()=>{await create();execFileSync('docker',['--context','desktop-linux','compose','-f','compose.session.yaml','exec','-T','worker','node24','--input-type=module'],{input:await readFile('scripts/crash-renderer.mjs'),stdio:['pipe','pipe','pipe']});await clean('crashed');});
 await check('publisher SIGKILL recovers same session',async()=>{
  await create();await sleep(2000);
  execFileSync('docker',['--context','desktop-linux','compose','-f','compose.session.yaml','exec','-T','publisher','node','--input-type=module'],{input:`import{readdir,readFile}from'node:fs/promises';let killed=0;for(const pid of await readdir('/proc')){if(!/^\\d+$/.test(pid))continue;try{const cmd=await readFile('/proc/'+pid+'/cmdline','utf8');if(cmd.split('\\0').includes('session-publisher.mjs')){process.kill(Number(pid),'SIGKILL');killed++;}}catch{}}if(killed!==1)throw Error('publisher missing');`,stdio:['pipe','pipe','pipe']});
  await sleep(4000);const s=await api(`/sessions/${session.sessionId}`);assert.equal(s.status,'active');assert.equal(s.media.state,'streaming');await api(`/sessions/${session.sessionId}`,'DELETE');await clean('closed');
 });
 await check('worker graceful shutdown',async()=>{await create();compose('stop','-t','15','worker');const id=compose('ps','-a','-q','worker').trim();const state=execFileSync('docker',['--context','desktop-linux','inspect',id,'--format','{{.State.ExitCode}}'],{encoding:'utf8'}).trim();assert.equal(state,'0');compose('up','-d','--no-build','--no-deps','worker');await ready();});
 await check('idle TTL',async()=>{process.env.SESSION_IDLE_MS='5000';process.env.SESSION_TTL_MS='15000';compose('up','-d','--no-build','--no-deps','--force-recreate','worker');await create();await sleep(6000);await clean('expired');});
 await check('absolute TTL despite input',async()=>{await create();for(let i=0;i<20;i++){await sleep(800);try{await api(`/sessions/${session.sessionId}/input`,'POST',{type:'mouseMove',x:10,y:10});}catch{}}await clean('expired');});
}finally {
 delete process.env.SESSION_IDLE_MS;delete process.env.SESSION_TTL_MS;
 if(session)await api(`/sessions/${session.sessionId}`,'DELETE').catch(()=>{});
 // Capture the failed generation before force-recreate discards its container logs.
 for(const service of ['worker','broker','publisher'])await writeFile(`${out}/${service}.log`,compose('logs','--no-color',service));
 compose('up','-d','--no-build','--no-deps','--force-recreate','worker');
 await writeFile(`${out}/results.json`,JSON.stringify(rows,null,2));
 await writeFile(`${out}/worker-restored.log`,compose('logs','--no-color','worker'));
 console.log(out);
}
if(rows.some(r=>r.result==='FAIL'))process.exitCode=1;
