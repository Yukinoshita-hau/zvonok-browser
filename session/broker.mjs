import { signalingGate } from './signaling-gate.mjs';
import { publisherGrant } from './grants.mjs';
import { mediaProfiles } from './media-profiles.mjs';
import { createServer } from 'node:http';
import { mkdir, chmod, unlink, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function validBinding(b) {
  return b && Object.keys(b).sort().join(',') === 'epoch,expiresAt,ownerId,profile,sessionId' &&
    /^[0-9a-f-]{36}$/.test(b.sessionId) && /^[0-9a-f-]{36}$/.test(b.epoch) && b.ownerId === 'local-owner' &&
    Object.hasOwn(mediaProfiles, b.profile) &&
    Number.isFinite(Date.parse(b.expiresAt)) && Date.parse(b.expiresAt)>Date.now() && Date.parse(b.expiresAt)<=Date.now()+1200000;
}
export class Registry {
  current;
  constructor(removeRoom, persist = async()=>{}) { this.removeRoom=removeRoom;this.persist=persist; }
  matches(b) { return !!this.current && b.sessionId===this.current.sessionId && b.epoch===this.current.epoch; }
  alive() { return this.current && Date.now()-this.current.lease<4000 && Date.now()<Date.parse(this.current.expiresAt); }
  state() { return this.current?.published && Date.now()-this.current.published<3000 ? 'streaming' : 'media_reconnecting'; }
  async bind(b) {
    if(!validBinding(b) || this.current) throw Error('BIND_REJECTED');
    this.current={...b,room:`browser-${b.epoch}`,publisher:`publisher-${b.epoch}`,lease:Date.now(),published:0,identities:[]};
    await this.persist(this.current);
  }
  async revoke(b) {
    if(!this.matches(b)) { if(!this.current) return; throw Error('BINDING_MISMATCH'); }
    this.current.lease=0;
    await this.removeRoom(this.current.room);
    await this.persist(null);this.current=undefined;
  }
}
async function main() {
  const { AccessToken, TrackSource, RoomServiceClient, TokenVerifier } = await import('livekit-server-sdk');
  const secret=(await readFile('/secrets/livekit.yaml','utf8')).match(/  spike: (\w+)/)?.[1];
  if(!secret) throw Error('Missing local media credentials');
  const rooms=new RoomServiceClient('http://livekit:7880','spike',secret,{requestTimeout:1.5});
  const remove=async room=>{try{await rooms.deleteRoom(room);}catch(e){if(e.status!==404 && e.code!=='not_found')throw e;}};
  await mkdir('/binding',{recursive:true});await chmod('/binding',0o700);
  const journal='/binding/current.json';
  try { const old=JSON.parse(await readFile(journal,'utf8'));if(old)await remove(old.room); } catch(e) { if(e.code!=='ENOENT')throw e; }
  const registry=new Registry(remove,b=>writeFile(journal,JSON.stringify(b),{mode:0o600}));
  const verifier=new TokenVerifier('spike',secret);
  const coreOrigin=process.env.BROWSER_CORE_ORIGIN;
  if(coreOrigin && !/^http:\/\/(127\.0\.0\.1|localhost):[0-9]{2,5}$/.test(coreOrigin))throw Error('Local Core origin required');
  const gate=signalingGate(registry,token=>verifier.verify(token),coreOrigin?[coreOrigin]:undefined);
  gate.server.listen(3002,'0.0.0.0');
  let tail=Promise.resolve(), pending=0;
  function serial(fn) {
    if(pending>=8) return Promise.reject(Error('BUSY'));
    pending++;const result=tail.then(fn);tail=result.catch(()=>{}).finally(()=>pending--);return result;
  }
  async function jwt(publisher, identity) {
    const b=registry.current;
    if(!registry.alive()) throw Error('NO_SESSION');
    if(!publisher && !b.identities.includes(identity))throw Error('VIEWER_REJECTED');
    const t=new AccessToken('spike',secret,{identity:publisher?b.publisher:identity,ttl:publisher?'5m':'30s'});
    t.addGrant(publisherGrant(publisher,b.room,TrackSource));
    return {token:await t.toJwt(),url:process.env.BROWSER_SIGNALING_URL ?? 'ws://127.0.0.1:48033',room:b.room,epoch:b.epoch,sessionId:b.sessionId,publisher:b.publisher,profile:b.profile};
  }
  function serve(kind) {
    const server=createServer((req,res)=>{
      const chunks=[];let bytes=0;
      req.on('data',p=>{bytes+=p.length;if(bytes>1024)req.destroy();else chunks.push(p);});
      req.on('error',()=>{});
      req.on('end',()=>void serial(async()=>{
        if(req.method!=='POST' || req.headers['transfer-encoding']) throw Error('BAD_REQUEST');
        const b=bytes?JSON.parse(Buffer.concat(chunks).toString()):{};
        let data={state:registry.state()};
        if(kind==='binding') {
          if(req.url==='/bind') await registry.bind(b);
          else if(req.url==='/lease' && Object.keys(b).sort().join(',')==='epoch,sessionId' && registry.matches(b) && registry.alive()) {registry.current.lease=Date.now();data={state:registry.state()};}
          else if(req.url==='/members' && Object.keys(b).sort().join(',')==='epoch,identities,sessionId' && registry.matches(b) && registry.alive() && Array.isArray(b.identities) && b.identities.length<=2 && new Set(b.identities).size===b.identities.length && b.identities.every(id=>typeof id==='string' && id.startsWith(`viewer-${b.epoch}-`) && id.length<140)) {
            const previous=registry.current.identities;registry.current.identities=b.identities;gate.sweep();
            for(const identity of previous.filter(id=>!b.identities.includes(id)))try{await rooms.removeParticipant(registry.current.room,identity);}catch(e){if(e.status!==404 && e.code!=='not_found')throw e;}
          }
          else if(req.url==='/viewer' && Object.keys(b).sort().join(',')==='epoch,identity,sessionId' && registry.matches(b)) data=await jwt(false,b.identity);
          else if(req.url==='/revoke' && Object.keys(b).sort().join(',')==='epoch,sessionId') {const closing=registry.revoke(b);gate.sweep();await closing;}
          else throw Error('BINDING_REJECTED');
        } else if(kind==='publisher') {
          if(req.url==='/token' && bytes===0) data=await jwt(true);
          else if(req.url==='/published' && Object.keys(b).sort().join(',')==='epoch,sessionId' && registry.matches(b) && registry.alive()) registry.current.published=Date.now();
          else throw Error('PUBLISHER_REJECTED');
        } else {
          throw Error('VIEWER_REJECTED'); // Viewer grants use Worker-validated membership on private binding IPC.
        }
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(data));
      }).catch(e=>{const reason=['BIND_REJECTED','BINDING_REJECTED','VIEWER_REJECTED','PUBLISHER_REJECTED','NO_SESSION'].includes(e.message)?e.message:'REQUEST_REJECTED';if(kind!=='publisher')console.log(JSON.stringify({kind:'binding-rejected',surface:kind,reason}));if(!res.headersSent)res.writeHead(409).end();}));
    });
    server.maxConnections=4;server.requestTimeout=3000;server.headersTimeout=3000;server.timeout=3000;
    return server;
  }
  await mkdir('/auth',{recursive:true});await chmod('/auth',0o700);
  const binding=serve('binding'),publisher=serve('publisher');
  const bindingSocket=process.env.BROWSER_BINDING_SOCKET ?? '/binding/broker.sock', tokenSocket=process.env.BROWSER_TOKEN_SOCKET ?? '/auth/token.sock';
  for(const path of [bindingSocket,tokenSocket]) await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
  binding.listen(bindingSocket,()=>chmod(bindingSocket,0o600));
  publisher.listen(tokenSocket,()=>chmod(tokenSocket,0o600));
  const timer=setInterval(()=>void serial(async()=>{gate.sweep();if(registry.current && !registry.alive())await registry.revoke(registry.current);}).catch(()=>console.log(JSON.stringify({kind:'room-revoke-retry'}))),500);
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{
    clearInterval(timer);const deadline=setTimeout(()=>process.exit(1),8000);
    void serial(async()=>{if(registry.current)await registry.revoke(registry.current);}).finally(()=>{gate.sweep();gate.server.close();binding.close();publisher.close();clearTimeout(deadline);});
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
