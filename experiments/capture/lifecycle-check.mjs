// Destructive only to the dedicated zvonok-browser-capture experiment containers.
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';import {setTimeout as sleep} from 'node:timers/promises';
const exec=promisify(execFile),rows=[];
const docker=(...args)=>exec('docker',['--context','desktop-linux',...args],{maxBuffer:8*1024*1024,timeout:90000});
const compose=(...args)=>docker('compose','-f','compose.capture.yaml',...args);
const state=async service=>JSON.parse((await docker('inspect','--format','{{json .State}}',`zvonok-browser-capture-${service}-1`)).stdout);
async function wait(fn,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await sleep(500)}throw Error('Lifecycle timeout')}
async function start(){await compose('stop','capture','publisher');await compose('up','-d','--no-deps','--force-recreate','capture','publisher');await wait(async()=>{const {stdout}=await compose('logs','--no-color','capture');return stdout.includes('capture-ready')});await sleep(3000)}
async function check(name,fn){try{await fn();rows.push({name,result:'PASS'})}catch(e){rows.push({name,result:'FAIL',detail:e.message});process.exitCode=1}}
try{
 for(const process of ['ffmpeg','chrome'])await check(`${process} crash kills capture tree and unpublishes`,async()=>{await start();const old=(await compose('exec','-T','capture','sh','-c','find /tmp -maxdepth 1 -name "capture-profile-*"')).stdout.trim();await compose('exec','-T','capture','pkill','-9','-x',process);await wait(async()=>!(await state('capture')).Running);await wait(async()=>!(await state('publisher')).Running);assert.equal((await state('capture')).Pid,0);await start();const fresh=(await compose('exec','-T','capture','sh','-c','find /tmp -maxdepth 1 -name "capture-profile-*"')).stdout.trim();assert.notEqual(old,fresh);assert.equal(fresh.split('\n').length,1)});
 await check('local DELETE-equivalent clean shutdown',async()=>{await compose('exec','-T','capture','sh','-c',"printf '%s' '999:delete' >/tmp/capture-command");await wait(async()=>!(await state('capture')).Running);await wait(async()=>!(await state('publisher')).Running);assert.equal((await state('capture')).ExitCode,0);assert.equal((await state('capture')).Pid,0)});
 await check('absolute TTL removes private display/profile',async()=>{await compose('start','publisher');const {stdout}=await compose('run','--rm','--no-deps','-e','CAPTURE_TTL_MS=15000','capture');assert(stdout.includes('ttl-expired'));await wait(async()=>!(await state('publisher')).Running)});
}finally{await writeFile('artifacts/capture-lifecycle.json',JSON.stringify(rows,null,2));console.table(rows)}
