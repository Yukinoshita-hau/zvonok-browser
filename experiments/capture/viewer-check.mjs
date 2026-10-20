// Local acceptance drives fixed harness commands; no remote browser-control API.
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile), samples=[],actions=[],resources=[];
const token=(await readFile('.env','utf8')).split(/\r?\n/).find(x=>x.startsWith('DEV_TOKEN=')).slice(10).trim();
const name=process.env.CAPTURE_RUN??'720p15', seconds=Number(process.env.CAPTURE_SECONDS??65);
const compose=(...args)=>exec('docker',['--context','desktop-linux','compose','-f','compose.capture.yaml',...args],{maxBuffer:4*1024*1024});
const browser=await chromium.launch({channel:'chrome',headless:true});
const system=await browser.newBrowserCDPSession();
const page=await browser.newPage();let pngRequests=0;
page.on('request',r=>{if(new URL(r.url()).pathname.endsWith('/frame'))pngRequests++});
await mkdir('artifacts',{recursive:true});
try{
 assert.equal((await fetch('http://127.0.0.1:47932/media/token',{method:'POST'})).status,403);
 await page.goto('http://127.0.0.1:47932');await page.getByLabel('Dev token').fill(token);await page.getByRole('button',{name:'Подключиться к видео',exact:true}).click();
 await page.waitForFunction(()=>window.mediaMetrics?.framesDecoded>10,null,{timeout:45000});
 await page.evaluate(()=>{const v=document.querySelector('video'),c=document.createElement('canvas');c.width=1280;c.height=720;const ctx=c.getContext('2d',{willReadFrequently:true});function frame(){ctx.drawImage(v,0,0,1280,720);const p=ctx.getImageData(680,28,1,1).data;window.capturePixel={r:p[0],g:p[1],at:performance.now()};v.requestVideoFrameCallback(frame)}v.requestVideoFrameCallback(frame)});
 async function command(id,action,green){const start=performance.now();await compose('exec','-T','capture','sh','-c',`printf '%s' '${id}:${action}' > /tmp/capture-command`);const dispatchMs=performance.now()-start;if(green!==undefined)await page.waitForFunction(g=>g?window.capturePixel?.g>180&&window.capturePixel?.r<70:window.capturePixel?.r>180&&window.capturePixel?.g<70,green,{timeout:8000});actions.push({id,action,dispatchRoundTripMs:dispatchMs,inputToObservedPixelMs:green===undefined?null:performance.now()-start})}
 await command(Date.now(),'fixture');await page.waitForTimeout(1500);await page.screenshot({path:`artifacts/capture-${name}-before.png`,fullPage:true});
 await command(1,'click',true);await command(2,'type',false);await command(3,'scroll');await page.waitForTimeout(1000);await page.screenshot({path:`artifacts/capture-${name}-scroll.png`});
 await command(4,'fixture');await page.waitForTimeout(1000);for(let i=0;i<10;i++)await command(100+i,'click',i%2===0); 
 for(let i=0;i<seconds;i++){
  await page.waitForTimeout(1000);samples.push(await page.evaluate(()=>({at:Date.now(),...window.mediaMetrics,videoTime:document.querySelector('video').currentTime,pixel:window.capturePixel})));
  if(i%10===0){const {stdout}=await exec('docker',['--context','desktop-linux','stats','--no-stream','--format','{{json .}}',...['capture','publisher','livekit','viewer','proxy','guard'].map(s=>`zvonok-browser-capture-${s}-1`)]);const processes=await system.send('SystemInfo.getProcessInfo');const ids=processes.processInfo.map(p=>Number(p.id)).filter(Number.isSafeInteger);let ram;try{ram=(await exec('powershell',['-NoProfile','-Command',`Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,Threads | ConvertTo-Json -Depth 1`])).stdout}catch{}const processSnapshot=await compose('exec','-T','capture','ps','-eo','pid,ppid,comm,pcpu,rss,nlwp');resources.push({at:Date.now(),stats:stdout,viewerProcesses:processes.processInfo,viewerRam:ram,captureProcesses:processSnapshot.stdout});}
 }
 assert(samples.at(-1).framesDecoded-samples[0].framesDecoded>seconds*10);assert.equal(pngRequests,0);assert.equal(samples.at(-1).width,1280);assert.equal(samples.at(-1).height,720);
 await page.screenshot({path:`artifacts/capture-${name}.png`,fullPage:true});
 const decodedFps=(samples.at(-1).framesDecoded-samples[0].framesDecoded)*1000/(samples.at(-1).at-samples[0].at),target=Number(process.env.MEDIA_FPS??15);const profilePass=decodedFps>=target*0.95&&samples.every(s=>s.width===1280&&s.height===720);console.log(JSON.stringify({name,result:profilePass?'PASS':'FAIL',decodedFps,target,actions,first:samples[0],last:samples.at(-1)}));if(!profilePass)process.exitCode=1;
}catch(e){await page.screenshot({path:`artifacts/capture-${name}-failure.png`,fullPage:true});console.log(await page.locator('section').first().innerText());throw e;}finally{
 await writeFile(`artifacts/capture-${name}.json`,JSON.stringify({samples,actions,resources,pngRequests},null,2));await browser.close();
}
