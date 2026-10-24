import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,mkdir} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import assert from 'node:assert/strict';
const exec=promisify(execFile),rows=[];await mkdir('artifacts/gate-lifecycle-final',{recursive:true});
const docker=(...a)=>exec('docker',['--context','desktop-linux',...a],{timeout:90000,maxBuffer:8*1024*1024});
const compose=(...a)=>docker('compose','-f','compose.capture.yaml',...a);
const state=async name=>JSON.parse((await docker('inspect','--format','{{json .State}}',name)).stdout);
async function until(fn,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(500)}throw Error('lifecycle deadline')}
for(const scenario of ['delete','browser-crash','ffmpeg-crash','publisher-crash','idle','ttl'])for(let attempt=1;attempt<=3;attempt++){
 const name=`zvonok-browser-gate-${scenario}-${attempt}`,row={scenario,attempt,name,result:'FAIL',started:Date.now()};
 try{
  await compose('stop','capture','publisher');await compose('up','-d','--no-deps','--force-recreate','publisher');
  await compose('run','-d','--no-deps','--name',name,'-e',`CAPTURE_TTL_MS=${scenario==='ttl'?30000:1200000}`,'-e',`CAPTURE_IDLE_MS=${scenario==='idle'?25000:1200000}`,'capture');
  await until(async()=>{const logs=(await docker('logs',name)).stdout;return logs.includes('capture-ready')});
  await until(async()=>(await docker('logs',name)).stdout.includes('capture-stats'));
  if(scenario==='delete')await docker('exec',name,'sh','-c',"printf '%s' '999:delete' >/tmp/capture-command");
  if(scenario==='browser-crash')await docker('exec',name,'pkill','-9','-x','chrome');
  if(scenario==='ffmpeg-crash')await docker('exec',name,'pkill','-9','-x','ffmpeg');
  if(scenario==='publisher-crash'){
   await compose('kill','-s','SIGKILL','publisher');assert.equal((await state('zvonok-browser-capture-publisher-1')).Pid,0);
   await compose('up','-d','--no-deps','--force-recreate','publisher');
   await until(async()=>{const text=(await compose('logs','--no-color','publisher')).stdout;return /"received":[1-9]/.test(text)});
   await docker('stop',name);
  }
  await until(async()=>!(await state(name)).Running,40000);row.state=await state(name);assert.equal(row.state.Pid,0);
  await until(async()=>!(await state('zvonok-browser-capture-publisher-1')).Running);
  row.publisher=await state('zvonok-browser-capture-publisher-1');assert.equal(row.publisher.Pid,0);
  const logs=(await docker('logs',name)).stdout;
  if(scenario==='idle')assert(logs.includes('idle-expired'));
  if(scenario==='ttl')assert(logs.includes('ttl-expired'));
  if(['idle','ttl','delete'].includes(scenario))assert.equal(row.state.ExitCode,0);
  row.result='PASS';
 }catch(e){row.error=e.message;process.exitCode=1}
 finally{
  // Persist failure state and logs BEFORE cleanup, using a unique name per attempt.
  row.finished=Date.now();try{const publisherLogs=await compose('logs','--no-color','--timestamps','publisher');await writeFile(`artifacts/gate-lifecycle-final/${scenario}-${attempt}-publisher.log`,publisherLogs.stdout+publisherLogs.stderr)}catch(e){row.publisherEvidenceError=e.message}try{const logs=await docker('logs','--timestamps',name);await writeFile(`artifacts/gate-lifecycle-final/${scenario}-${attempt}.log`,logs.stdout+logs.stderr);row.state=await state(name)}catch(e){row.evidenceError=e.message}
  rows.push(row);await writeFile('artifacts/gate-lifecycle-final/results.json',JSON.stringify(rows,null,2));console.log(JSON.stringify(row));
  await docker('rm','-f',name).catch(()=>{});await compose('stop','publisher');
 }
}
