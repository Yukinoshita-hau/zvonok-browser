import {createServer, request} from 'node:http';

// No WebSocket parsing: after membership admission, bounded TCP backpressure carries LiveKit signaling.
export function signalingGate(registry, verify, origins = ['http://127.0.0.1:48031','http://localhost:48031']) {
  const connections=new Map();
  const allowed=identity=>registry.alive() && registry.current.identities?.includes(identity);
  async function identity(req) {
    const url=new URL(req.url,'http://local');
    if(!['/rtc','/rtc/validate','/rtc/v1','/rtc/v1/validate'].includes(url.pathname) || req.method!=='GET')throw Error('DENIED');
    if(req.headers.origin && !origins.includes(req.headers.origin))throw Error('DENIED');
    const claims=await verify(url.searchParams.get('access_token')??'');
    if(!allowed(claims.sub) || claims.video?.room!==registry.current.room || claims.video?.canPublish!==false || claims.video?.canSubscribe!==true || claims.video?.canPublishData!==false)throw Error('DENIED');
    return claims.sub;
  }
  const server=createServer((req,res)=>{
    void identity(req).then(id=>{
      if(!allowed(id))throw Error('DENIED');
      const upstream=request({hostname:'livekit',port:7880,path:req.url,method:'GET',headers:{host:'livekit:7880'}},r=>{
        if(!allowed(id)){r.destroy();res.writeHead(403).end();return;}
        res.writeHead(r.statusCode??502,{'content-type':r.headers['content-type']??'text/plain',...(req.headers.origin?{'access-control-allow-origin':req.headers.origin}: {})});r.pipe(res);
      });
      upstream.setTimeout(3000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
      res.on('close',()=>upstream.destroy());upstream.end();
    }).catch(()=>res.writeHead(403).end());
  });
  server.on('upgrade',(req,socket,head)=>{
    socket.on('error',()=>{});
    void identity(req).then(id=>{
      if(!allowed(id) || connections.size>=8)throw Error('DENIED');
      const pair={id,socket,upstream:undefined};connections.set(socket,pair);
      const close=()=>{connections.delete(socket);socket.destroy();pair.upstream?.destroy();};
      socket.on('error',close);socket.on('close',close);
      const upstream=request({hostname:'livekit',port:7880,path:req.url,headers:{host:'livekit:7880',upgrade:'websocket',connection:'Upgrade','sec-websocket-key':req.headers['sec-websocket-key'],'sec-websocket-version':'13'}});
      upstream.setTimeout(5000,()=>upstream.destroy());
      upstream.on('upgrade',(response,remote,remoteHead)=>{
        upstream.setTimeout(0);pair.upstream=remote;
        if(!allowed(id)){close();return;}
        const headers=Object.entries(response.headers).map(([k,v])=>`${k}: ${v}`).join('\r\n');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
        if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);
        remote.on('error',close);remote.on('close',close);socket.pipe(remote);remote.pipe(socket);
      });
      upstream.on('response',r=>{r.resume();close();});upstream.on('error',close);upstream.end();
    }).catch(()=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  });
  server.maxConnections=16;server.headersTimeout=3000;server.requestTimeout=5000;
  return {server,sweep(){for(const c of connections.values())if(!allowed(c.id)){c.socket.destroy();c.upstream?.destroy();}}};
}
