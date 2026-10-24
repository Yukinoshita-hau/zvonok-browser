import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const token=(await readFile('.env','utf8')).split(/\r?\n/).find(s=>s.startsWith('DEV_TOKEN=')).slice(10).trim();
const out=`artifacts/session-security-${Date.now()}`;await mkdir(out);const rows=[];
function compose(...args){return execFileSync('docker',['--context','desktop-linux','compose','-f','compose.session.yaml',...args],{encoding:'utf8',stdio:'pipe',timeout:60000});}
function node(service,source){return execFileSync('docker',['--context','desktop-linux','compose','-f','compose.session.yaml','exec','-T',service,service==='worker'?'node24':'node','--input-type=module'],{input:source,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:60000});}
const headers={authorization:`Bearer ${token}`};
async function api(path,method='GET',body){return fetch('http://127.0.0.1:48031/api'+path,{method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});}
async function check(name,fn){try{await fn();rows.push({name,result:'PASS'});}catch(e){rows.push({name,result:'FAIL',detail:(e.stderr?.toString()??e.message).slice(0,3000)});}}
let session;
try {
 for(let i=0;i<50;i++){try{const r=await api('/ready');if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,200));}
 const r=await api('/sessions','POST',{});assert.equal(r.status,201);session=await r.json();headers['x-control-epoch']=session.collaboration.epoch;headers['x-control-generation']=String(session.collaboration.generation);
 await check('real session sandbox asserted',async()=>assert.match(compose('logs','--no-color','worker'),new RegExp('session-sandbox-pass.*'+session.sessionId)));
 await check('guard IPv4 IPv6 default deny and proxy-only',async()=>{const policy=compose('exec','-T','guard','sh','-c','iptables -S OUTPUT;ip6tables -S OUTPUT');assert.match(policy,/-P OUTPUT DROP/);assert.match(policy,/-A OUTPUT -d 172.30.87.2\/32 -p tcp -m tcp --dport 3128 -j ACCEPT/);assert.equal(policy.match(/-A OUTPUT/g).length,1);});
 await check('private Xauthority rejects unauthenticated X11',async()=>{let denied=false;try{compose('exec','-T','worker','env','DISPLAY=:91','XAUTHORITY=/tmp/nonexistent-cookie','xdpyinfo');}catch{denied=true;}assert(denied);});
 await check('no browser media secrets and no publisher control/binding mounts',async()=>{
   const mounts=service=>JSON.parse(execFileSync('docker',['--context','desktop-linux','inspect',compose('ps','-q',service).trim(),'--format','{{json .Mounts}}'],{encoding:'utf8'})).map(m=>m.Destination);
   assert(!mounts('publisher').some(d=>['/control','/binding','/secrets'].includes(d)));
   assert(!mounts('worker').some(d=>['/auth','/secrets','/var/run/docker.sock'].includes(d)));
   assert(!compose('exec','-T','worker','ps','-eo','args').includes('--no-sandbox'));
 });
 await check('browser cannot reach actual LiveKit IPs or X11 TCP',async()=>{
   const networks=JSON.parse(execFileSync('docker',['--context','desktop-linux','inspect',compose('ps','-q','livekit').trim(),'--format','{{json .NetworkSettings.Networks}}'],{encoding:'utf8'}));
   const hosts=Object.values(networks).map(n=>n.IPAddress);
   const result=node('worker',`import net from 'node:net';const targets=${JSON.stringify(hosts.flatMap(h=>[[h,7880],[h,48034]]).concat([['127.0.0.1',6091]]))};for(const [host,port]of targets){const open=await new Promise(resolve=>{const s=net.connect({host,port});s.setTimeout(1000);s.on('connect',()=>{s.destroy();resolve(true)});s.on('error',()=>resolve(false));s.on('timeout',()=>{s.destroy();resolve(false)});});if(open)throw Error('reachable');}console.log('blocked',targets.length);`);assert.match(result,/blocked/);
 });
 await check('no arbitrary control actions or unsafe URL',async()=>{
   assert.equal((await api(`/sessions/${session.sessionId}/input`,'POST',{type:'eval',code:'1'})).status,400);
   assert.equal((await api(`/sessions/${session.sessionId}/navigate`,'POST',{url:'http://169.254.169.254/'})).status,400);
   assert.equal((await api('/sessions/'+crypto.randomUUID()+'/media','POST')).status,404);
 });
 await check('publisher JWT only active room camera/browser audio publication',async()=>{
   const claims=JSON.parse(node('publisher',`import {request}from'node:http';const b=await new Promise(resolve=>{const r=request({socketPath:'/auth/token.sock',method:'POST',path:'/token'},s=>{let b='';s.on('data',p=>b+=p);s.on('end',()=>resolve(JSON.parse(b)));});r.end();});console.log(JSON.stringify(JSON.parse(Buffer.from(b.token.split('.')[1],'base64url'))));`));
   assert.equal(claims.video.room,session.media.room);assert.equal(claims.sub,session.media.publisher);assert.equal(claims.video.canSubscribe,false);assert.equal(claims.video.canPublishData,false);assert.equal(claims.video.roomAdmin,undefined);assert.deepEqual(claims.video.canPublishSources,['camera','screen_share_audio']);
 });
 await check('signed viewer JWT cannot publish audio/video/data/admin',async()=>{
   const r=await api(`/sessions/${session.sessionId}/media`,'POST');assert.equal(r.status,200);const auth=await r.json();const claims=JSON.parse(Buffer.from(auth.token.split('.')[1],'base64url'));
   assert.equal(claims.video.canPublish,false);assert.equal(claims.video.canPublishData,false);assert.equal(claims.video.canSubscribe,true);assert.equal(claims.video.roomAdmin,undefined);assert.equal(claims.video.room,session.media.room);
 });
 await check('Pulse has one null sink/monitor, private cookie socket, no host audio mount',async()=>{
   const evidence=node('worker',`import{readdir,stat}from'node:fs/promises';import{execFileSync}from'node:child_process';const profile=(await readdir('/tmp')).find(p=>p.startsWith('session-profile-'));if(!profile)throw Error('profile');const dir='/tmp/'+profile+'/pulse';const env={...process.env,PULSE_SERVER:'unix:'+dir+'/native',PULSE_COOKIE:dir+'/cookie'};console.log(execFileSync('pactl',['list','short','sinks'],{env,encoding:'utf8'}));console.log(execFileSync('pactl',['list','short','sources'],{env,encoding:'utf8'}));console.log('socketMode',((await stat(dir+'/native')).mode&511).toString(8),'cookieMode',((await stat(dir+'/cookie')).mode&511).toString(8));`);
   assert.equal(evidence.split('\n').filter(s=>/module-null-sink/.test(s)).length,2);assert.match(evidence,/browser.monitor/);assert.match(evidence,/cookieMode 600/);
   const mounts=JSON.parse(execFileSync('docker',['--context','desktop-linux','inspect',compose('ps','-q','worker').trim(),'--format','{{json .Mounts}}'],{encoding:'utf8'}));assert(!mounts.some(m=>m.Destination.includes('/dev/snd') || m.Destination.includes('pulse')));
 });
 await check('bounded frame IPC rejects concurrent extra writer',async()=>{
   await new Promise(r=>setTimeout(r,1000));
   node('worker',`import {request}from'node:http';import assert from'node:assert/strict';const path=${JSON.stringify('/frames/'+session.media.epoch+'.sock')};const send=(method,body)=>new Promise((resolve,reject)=>{const r=request({agent:false,socketPath:path,path:'/frame',method,headers:{'content-length':body.length}},s=>{s.resume();s.on('end',()=>resolve(s.statusCode));});r.on('error',e=>['EPIPE','ECONNRESET'].includes(e.code)?resolve(400):reject(e));r.end(body);});assert.equal(await send('GET',Buffer.alloc(0)),400);const b=Buffer.alloc(1280*720*4+24);b.writeUInt32LE(1279);b.writeUInt32LE(720,4);b.writeDoubleLE(Date.now(),16);assert.equal(await send('POST',b),400);`);
 });
}finally {
 if(session)await api(`/sessions/${session.sessionId}`,'DELETE');
 await writeFile(`${out}/results.json`,JSON.stringify(rows,null,2));console.table(rows);console.log(out);
}
if(rows.some(r=>r.result==='FAIL'))process.exitCode=1;
