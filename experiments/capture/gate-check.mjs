import {chromium} from 'playwright';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const exec=promisify(execFile),name=process.env.GATE_RUN??'15-1',seconds=Number(process.env.GATE_SECONDS??95),target=Number(process.env.MEDIA_FPS??15);
const compose=(...a)=>exec('docker',['--context','desktop-linux','compose','-f','compose.capture.yaml',...a],{maxBuffer:16*1024*1024});
const token=(await readFile('.env','utf8')).split(/\r?\n/).find(x=>x.startsWith('DEV_TOKEN=')).slice(10).trim();
const browser=await chromium.launch({channel:'chrome',headless:true});
let bridge;const result={name,target,samples:[],actions:[],resources:[],oldDispatch:[]};
try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:47932');await page.getByLabel('Dev token').fill(token);await page.getByRole('button',{name:'Подключиться к видео',exact:true}).click();
 await page.waitForFunction(()=>window.mediaMetrics?.framesDecoded>30,null,{timeout:60000});
 await page.evaluate(()=>{
  const video=document.querySelector('video'),canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d',{willReadFrequently:true});window.gatePixel={};
  function frame(now){ctx.drawImage(video,0,0,1280,720);let count=0;for(let i=0;i<16;i++){const p=ctx.getImageData(768+i*16,28,1,1).data;if(p[0]>128)count|=1<<i}
   window.gatePixel={count,at:now,edges:[[0,360],[1279,360],[640,0],[640,719],[0,0],[1279,0],[0,719],[1279,719]].map(([x,y])=>[...ctx.getImageData(x,y,1,1).data])};video.requestVideoFrameCallback(frame)
  }video.requestVideoFrameCallback(frame);
 });await page.waitForTimeout(3000);
 const started=performance.now();let nextResource=0,resourceJob;
 while(performance.now()-started<seconds*1000){
  result.samples.push({at:Date.now(),mono:performance.now(),...await page.evaluate(()=>({...window.mediaMetrics,pixel:window.gatePixel}))});
  if(performance.now()-started>=nextResource&&!resourceJob){nextResource+=10000;resourceJob=(async()=>{
   const stats=await exec('docker',['--context','desktop-linux','stats','--no-stream','--format','{{json .}}','zvonok-browser-capture-capture-1','zvonok-browser-capture-publisher-1','zvonok-browser-capture-livekit-1']);
   const cgroups={};for(const service of ['capture','publisher'])cgroups[service]=(await compose('exec','-T',service,'sh','-c','cat /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.events /proc/pressure/cpu /proc/pressure/memory')).stdout;
   result.resources.push({at:Date.now(),stats:stats.stdout,cgroups});
  })().catch(e=>{result.resourceError=e.message}).finally(()=>resourceJob=undefined)}
  await page.waitForTimeout(1000);
 }
 if(resourceJob)await resourceJob;
 bridge=spawn('docker',['--context','desktop-linux','compose','-f','compose.capture.yaml','exec','-T','capture','node24','experiments/capture/input-bridge.mjs'],{stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:bridge.stdout})[Symbol.asyncIterator]();let bridgeError='';bridge.stderr.on('data',p=>bridgeError+=p);
 assert.equal(JSON.parse((await lines.next()).value).ready,true);
 for(let i=0;i<Number(process.env.GATE_ACTIONS??60);i++){
  const clockStart=performance.now(),browserClock=await page.evaluate(()=>performance.now()),clockEnd=performance.now();
  const action=['click','type','scroll'][i%3],old=await page.evaluate(()=>window.gatePixel.count),start=performance.now();
  bridge.stdin.write(JSON.stringify({action})+'\n');const response=await Promise.race([lines.next(),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('bridge timeout '+bridgeError)),5000);t.unref()})]);
  const ack=performance.now();assert.equal(JSON.parse(response.value).status,204);
  await page.waitForFunction(c=>window.gatePixel.count!==c,old,{timeout:5000});
  const pixel=await page.evaluate(()=>window.gatePixel);result.actions.push({action,sendMs:start,ackMs:ack,observedMs:performance.now(),inputToPixelMs:performance.now()-start,transportAckMs:ack-start,callbackMs:pixel.at,callbackLatencyLowerMs:pixel.at+clockStart-browserClock-start,callbackLatencyUpperMs:pixel.at+clockEnd-browserClock-start,clockBracketWidthMs:clockEnd-clockStart});
 }
 for(let i=0;i<5;i++){const start=performance.now();await compose('exec','-T','capture','sh','-c',`printf '%s' '${Date.now()}:click' > /tmp/capture-command`);result.oldDispatch.push(performance.now()-start);await page.waitForTimeout(200)}
 const first=result.samples[0],last=result.samples.at(-1);result.duration=(last.mono-first.mono)/1000;result.decodedFps=(last.framesDecoded-first.framesDecoded)/result.duration;
 result.dimensions=[...new Set(result.samples.map(s=>`${s.width}x${s.height}`))];result.result=result.decodedFps>=target*.95&&result.dimensions.length===1&&result.dimensions[0]==='1280x720'?'PASS':'FAIL';
 await page.screenshot({path:`artifacts/gate-${name}.png`});console.log(JSON.stringify({name,result:result.result,decodedFps:result.decodedFps,duration:result.duration,dimensions:result.dimensions,actions:result.actions.length}));
}catch(e){result.error=e.stack;process.exitCode=1;console.error(e.message)}finally{
 bridge?.stdin.end();bridge?.kill();await browser.close();result.logs=(await compose('logs','--no-color','--timestamps','capture','publisher')).stdout;await writeFile(`artifacts/gate-${name}.json`,JSON.stringify(result,null,2));
}
