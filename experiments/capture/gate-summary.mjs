import {readdir,readFile,writeFile} from 'node:fs/promises';
const q=(a,p)=>{a=a.filter(Number.isFinite).sort((a,b)=>a-b);return a[Math.ceil(a.length*p)-1]??null};
const rows=[];
for(const file of (await readdir('artifacts')).filter(x=>/^gate-.*\.json$/.test(x))){
 const d=JSON.parse(await readFile('artifacts/'+file,'utf8')),s=d.samples;if(!s?.length)continue;
 const first=s[0],last=s.at(-1),duration=(last.mono-first.mono)/1000;
 const logs=(d.logs??'').split('\n').map(l=>{try{return JSON.parse(l.slice(l.indexOf('{')))}catch{return null}}).filter(x=>x&&x.at>=first.at&&x.at<=last.at);
 const capture=logs.filter(x=>x.kind==='capture-stats'),publisher=logs.filter(x=>x.kind==='publisher');
 const rate=(a,key)=>a.length>1?(a.at(-1)[key]-a[0][key])*1000/(a.at(-1).at-a[0].at):null;
 const delta=(a,key)=>a.length>1?a.at(-1)[key]-a[0][key]:null;
 const a=publisher[0]?.outbound?.[0],b=publisher.at(-1)?.outbound?.[0];
 const input=d.actions??[],resources={};
 for(const r of d.resources??[])for(const line of r.stats.split('\n').filter(Boolean)){const v=JSON.parse(line);(resources[v.Name]??=[]).push(v)}
 const container={};for(const [name,samples] of Object.entries(resources))container[name]={cpuMean:samples.reduce((a,b)=>a+parseFloat(b.CPUPerc),0)/samples.length,cpuMax:Math.max(...samples.map(x=>parseFloat(x.CPUPerc))),lastMemory:samples.at(-1).MemUsage};
 rows.push({name:d.name,error:d.error??null,resourceError:d.resourceError??null,duration,decodedFps:(last.framesDecoded-first.framesDecoded)/duration,capturedFps:rate(capture,'count'),submittedFps:rate(publisher,'submitted'),publishedFps:a&&b?(b.framesSent-a.framesSent)*1000/(publisher.at(-1).at-publisher[0].at):null,dimensions:[...new Set(s.map(x=>`${x.width}x${x.height}`))],decoderDrops:last.framesDropped-first.framesDropped,sourceReplacements:delta(capture,'replacements'),sourceFailures:delta(capture,'failed'),publisherReplacements:delta(publisher,'dropped'),gcMs:delta(capture,'gcMs'),eventLoopMaxMs:capture.at(-1)?.eventLoopMaxMs,qualityReasons:[...new Set(publisher.flatMap(x=>x.outbound?.map(o=>o.qualityLimitationReason)??[]))],timing:{ipcAckP50:q(logs.filter(x=>x.kind==='ipc').map(x=>x.ipcAckMs),.5),ipcAckP95:q(logs.filter(x=>x.kind==='ipc').map(x=>x.ipcAckMs),.95),captureToSubmitP50:q(logs.filter(x=>x.kind==='submit-stage').map(x=>x.captureToSubmitMs),.5),captureToSubmitP95:q(logs.filter(x=>x.kind==='submit-stage').map(x=>x.captureToSubmitMs),.95),frameCallP95:q(logs.filter(x=>x.kind==='submit-stage').map(x=>x.videoFrameAndCaptureCallMs),.95)},ttffMs:last.firstFrameMs,encodeMeanMs:a&&b?(b.totalEncodeTime-a.totalEncodeTime)*1000/(b.framesEncoded-a.framesEncoded):null,decodeMeanMs:(last.totalDecodeTime-first.totalDecodeTime)*1000/(last.framesDecoded-first.framesDecoded),input:{n:input.length,p50:q(input.map(x=>x.inputToPixelMs),.5),p95:q(input.map(x=>x.inputToPixelMs),.95),max:q(input.map(x=>x.inputToPixelMs),1),ackP50:q(input.map(x=>x.transportAckMs),.5),ackP95:q(input.map(x=>x.transportAckMs),.95)},oldDispatch:{n:d.oldDispatch?.length,p50:q(d.oldDispatch??[],.5),p95:q(d.oldDispatch??[],.95)},container,cgroupsFirst:d.resources?.[0]?.cgroups,cgroupsLast:d.resources?.at(-1)?.cgroups});
}
await writeFile('artifacts/gate-summary-final.json',JSON.stringify(rows,null,2));
console.table(rows.map(({name,decodedFps,capturedFps,submittedFps,publishedFps,error})=>({name,decodedFps,capturedFps,submittedFps,publishedFps,error})));
