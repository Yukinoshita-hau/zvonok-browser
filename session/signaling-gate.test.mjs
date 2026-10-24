import {expect,it} from 'vitest';
import {signalingGate} from './signaling-gate.mjs';
it('signaling denies revoked/unknown/expired/cross-room/publishing claims and foreign Origin',async()=>{
  const registry={alive:()=>true,current:{room:'room',identities:['member']}};
  let claims={sub:'member',video:{room:'other',canPublish:false,canSubscribe:true,canPublishData:false}};
  const gate=signalingGate(registry,async token=>{if(token==='expired')throw Error('expired');return claims;});
  await new Promise(resolve=>gate.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${gate.server.address().port}`;
  try {
    for(const path of ['/','/rtc?access_token=expired','/rtc?access_token=wrong-room'])expect((await fetch(url+path)).status).toBe(403);
    claims.video.room='room';claims.video.canPublish=true;expect((await fetch(url+'/rtc')).status).toBe(403);
    claims.video.canPublish=false;claims.sub='revoked';expect((await fetch(url+'/rtc')).status).toBe(403);
    claims.sub='member';expect((await fetch(url+'/rtc',{headers:{Origin:'http://attacker.local'}})).status).toBe(403);
    registry.current.identities=[];expect((await fetch(url+'/rtc')).status).toBe(403);
  } finally {gate.server.closeAllConnections();await new Promise(resolve=>gate.server.close(resolve));}
});
it('Core origin is exact and still requires live membership', async()=>{
  const registry={alive:()=>true,current:{room:'room',identities:['member']}};
  const gate=signalingGate(registry,async()=>({sub:'member',video:{room:'room',canPublish:false,canSubscribe:true,canPublishData:false}}),['http://127.0.0.1:3018']);
  await new Promise(resolve=>gate.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${gate.server.address().port}/rtc`;
  try {
    for(const origin of ['http://127.0.0.1:48031','http://127.0.0.1:30180','http://attacker.local'])
      expect((await fetch(url,{headers:{Origin:origin}})).status).toBe(403);
    // A valid origin passes admission but this unit environment has no upstream LiveKit DNS.
    expect((await fetch(url,{headers:{Origin:'http://127.0.0.1:3018'}})).status).toBe(502);
    registry.current.identities=[];
    expect((await fetch(url,{headers:{Origin:'http://127.0.0.1:3018'}})).status).toBe(403);
  }finally{gate.server.closeAllConnections();await new Promise(resolve=>gate.server.close(resolve));}
});
