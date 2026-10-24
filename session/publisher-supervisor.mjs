import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
let child,closing=false;
const tokenSocket=process.env.BROWSER_TOKEN_SOCKET ?? '/auth/token.sock';
function sessionAvailable(){return new Promise(resolve=>{const req=request({socketPath:tokenSocket,path:'/token',method:'POST'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode===200));});req.setTimeout(1500,()=>req.destroy());req.on('error',()=>resolve(false));req.end();});}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{closing=true;child?.kill('SIGTERM');});
while(!closing) {
  if(!await sessionAvailable()){await sleep(1000);continue;}
  child=spawn(process.execPath,['session-publisher.mjs'],{stdio:'inherit'});
  await new Promise(resolve=>{child.once('exit',(code,signal)=>{console.log(JSON.stringify({kind:'publisher-exit',at:Date.now(),pid:child.pid,code,signal,closing}));resolve();});child.once('error',()=>{console.log(JSON.stringify({kind:'publisher-spawn-error',at:Date.now(),pid:child.pid,closing}));resolve();});});
  if(!closing) await sleep(1000);
}
