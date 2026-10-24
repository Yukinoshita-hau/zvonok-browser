// Run inside the capture container; never prints credentials or Xauthority cookies.
import assert from 'node:assert/strict';
import {readFile,readdir,stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {request} from 'node:http';
assert.equal(process.getuid(),1000);
const rows=[];
for(const path of ['/auth/token.sock','/control/worker.sock','/var/run/docker.sock','/secrets/livekit.yaml']){
 await assert.rejects(stat(path));rows.push({check:'absent '+path,result:'PASS'});
}
const profiles=(await readdir('/tmp')).filter(x=>x.startsWith('capture-profile-'));assert.equal(profiles.length,1);
const authority='/tmp/'+profiles[0]+'/Xauthority';
const display=execFileSync('xdpyinfo',['-display',':91'],{env:{...process.env,XAUTHORITY:authority},encoding:'utf8'});assert.match(display,/1281x721 pixels/);
assert.throws(()=>execFileSync('xdpyinfo',['-display',':91'],{env:{...process.env,XAUTHORITY:'/tmp/nonexistent-cookie'},stdio:'pipe'}));
for(const path of ['/proc/net/tcp','/proc/net/tcp6'])assert(!(await readFile(path,'utf8')).split('\n').some(l=>l.trim().split(/\s+/)[1]?.endsWith(':17CB')&&l.trim().split(/\s+/)[3]==='0A'));
rows.push({check:'private X11: correct cookie opens; missing cookie denied; no TCP6091 listener',result:'PASS'});
assert.equal((await stat('/tmp/capture-input-key')).mode&0o777,0o600);assert.equal((await stat('/tmp/capture-input.sock')).mode&0o777,0o600);
const key=(await readFile('/tmp/capture-input-key','utf8')).trim();
async function call(body,auth=key){return new Promise((resolve,reject)=>{const req=request({socketPath:'/tmp/capture-input.sock',path:'/input',method:'POST',headers:{authorization:'Bearer '+auth,'content-length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end(body)})}
assert.equal(await call('{"action":"click"}','wrong'),403);
for(const body of ['{"action":"evaluate"}','{"action":"click","code":"1"}','{"action":"shell"}','x'.repeat(129)])assert.equal(await call(body),400);
rows.push({check:'input auth/schema/size negatives and mode0600',result:'PASS'});
console.table(rows);
