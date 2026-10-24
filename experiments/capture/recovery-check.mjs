import {chromium} from 'playwright';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFile,writeFile} from 'node:fs/promises';import assert from 'node:assert/strict';
const exec=promisify(execFile),rows=[];const compose=(...args)=>exec('docker',['--context','desktop-linux','compose','-f','compose.capture.yaml',...args],{timeout:60000,maxBuffer:4*1024*1024});
const dev=(await readFile('.env','utf8')).split(/\r?\n/).find(x=>x.startsWith('DEV_TOKEN=')).slice(10).trim();
async function claims(){const r=await fetch('http://127.0.0.1:47932/media/token',{method:'POST',headers:{Authorization:`Bearer ${dev}`}});assert.equal(r.status,200);const auth=await r.json();return JSON.parse(Buffer.from(auth.token.split('.')[1],'base64url'))}
const browser=await chromium.launch({channel:'chrome',headless:true});
async function viewer(){const p=await browser.newPage();await p.goto('http://127.0.0.1:47932');await p.getByLabel('Dev token').fill(dev);await p.getByRole('button',{name:'Подключиться к видео',exact:true}).click();await p.waitForFunction(()=>window.mediaMetrics?.generationMs>Date.now()-5000,null,{timeout:45000});return p}
try{
 const before=await claims();assert.equal(before.video.canPublish,false);assert.equal(before.video.canPublishData,false);assert.equal((await fetch('http://127.0.0.1:47932/media/token',{method:'POST',headers:{Authorization:'Bearer wrong'}})).status,403);
 const old=await viewer();
 await compose('restart','publisher');const stamp=await old.evaluate(()=>window.mediaMetrics.generationMs);await old.waitForFunction(ms=>window.mediaMetrics?.generationMs>ms,stamp,{timeout:45000});rows.push({name:'publisher restart resumes real pixels',result:'PASS'});
 await compose('stop','capture','publisher');await old.waitForTimeout(1500);const frozen=await old.evaluate(()=>window.mediaMetrics.framesDecoded);
 await compose('restart','broker');await compose('up','-d','--no-deps','--force-recreate','publisher','capture');
 const after=await claims();assert.notEqual(before.video.room,after.video.room);assert.match(after.video.room,/^slice-2b1-/);const fresh=await viewer();await fresh.waitForTimeout(4000);assert.equal(await old.evaluate(()=>window.mediaMetrics.framesDecoded),frozen);rows.push({name:'old epoch viewer cannot receive new epoch frames',result:'PASS',oldRoom:before.video.room,newRoom:after.video.room});
 rows.push({name:'wrong viewer authorization denied; JWT subscribe only',result:'PASS'});
}catch(e){rows.push({name:'recovery/epoch test',result:'FAIL',detail:e.message});process.exitCode=1}finally{await writeFile(`artifacts/capture-recovery-${process.env.GATE_CAMPAIGN??'gate'}.json`,JSON.stringify(rows,null,2));console.table(rows);await browser.close()}
