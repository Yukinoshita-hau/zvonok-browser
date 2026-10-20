// Local acceptance only: kill deep Chromium children (including renderers), never the main browser.
import {readdir,readFile} from 'node:fs/promises';
const processes=[];
for(const pid of await readdir('/proc')){
 if(!/^\d+$/.test(pid))continue;
 try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');const end=stat.lastIndexOf(')');processes.push({pid:Number(pid),name:stat.slice(stat.indexOf('(')+1,end),parent:Number(stat.slice(end+2).split(' ')[1])});}catch{}
}
const chrome=processes.filter(p=>p.name==='chrome'||p.name==='chrome-headless');
const ids=new Set(chrome.map(p=>p.pid));
let killed=0;
for(const p of chrome){const parent=chrome.find(c=>c.pid===p.parent);if(parent&&ids.has(parent.parent)&&!chrome.some(c=>c.parent===p.pid)){try{process.kill(p.pid,'SIGKILL');killed++;}catch{}}}
console.log('deep Chromium child processes killed',killed);if(!killed)process.exitCode=1;
