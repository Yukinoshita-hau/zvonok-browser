import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {createServer,createConnection, type Socket} from 'node:net';
import {once} from 'node:events';
const h=vi.hoisted(()=>({proxy:undefined as any,port:0,upstreamPort:0,sockets:[] as any[],deadlines:[] as any[],deferDns:false,resolveDns:undefined as any,connects:0,finishWithTail:false}));
vi.mock('node:http',async original=>{
  const actual=await original<any>();
  const factory=(handler:any)=>{
    const server=actual.createServer(handler),listen=server.listen.bind(server);
    server.listen=()=>listen(0,'127.0.0.1');h.proxy=server;
    server.on('connection',(socket:any)=>{h.sockets.push(socket);const set=socket.setTimeout.bind(socket);socket.setTimeout=(ms:number,cb:any)=>{if(ms===30000){h.deadlines.push({socket,cb,ms,side:'client'});return set(0);}return set(ms,cb);};});
    return server;
  };
  return {...actual,default:{...actual.default,createServer:factory}};
});
vi.mock('node:net',async original=>{
  const actual=await original<any>();
  const connect=(options:any)=>{
    expect(options).toEqual({host:'93.184.216.34',port:443});h.connects++;
    const socket=actual.createConnection({host:'127.0.0.1',port:h.upstreamPort}),set=socket.setTimeout.bind(socket);
    h.sockets.push(socket);socket.setTimeout=(ms:number,cb:any)=>{h.deadlines.push({socket,cb,ms,side:'remote'});return set(0);};return socket;
  };
  return {...actual,default:{...actual.default,connect}};
});
vi.mock('node:dns/promises',()=>({lookup:()=>h.deferDns?new Promise(resolve=>{h.resolveDns=resolve;}):Promise.resolve([{address:'93.184.216.34',family:4}])}));
let upstream:ReturnType<typeof createServer>;
const oldListeners=new Map<string,Function[]>();
beforeAll(async()=>{
  upstream=createServer({allowHalfOpen:true},socket=>{h.sockets.push(socket);socket.on('error',()=>{});socket.on('data',data=>socket.write(data));socket.on('end',()=>{if(h.finishWithTail)socket.end('tail');});});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');h.upstreamPort=(upstream.address() as any).port;
  for(const signal of ['SIGTERM','SIGINT'] as const)oldListeners.set(signal,process.listeners(signal));
  await import('./proxy.mjs');if(!h.proxy.listening)await once(h.proxy,'listening');h.port=h.proxy.address().port;
});
afterEach(async()=>{for(const socket of h.sockets)socket.destroy();h.sockets=[];h.deadlines=[];h.deferDns=false;h.resolveDns=undefined;h.finishWithTail=false;await new Promise(resolve=>setImmediate(resolve));});
afterAll(async()=>{
  await Promise.all([new Promise<void>(r=>h.proxy.close(r)),new Promise<void>(r=>upstream.close(()=>r()))]);
  for(const signal of ['SIGTERM','SIGINT'] as const)for(const listener of process.listeners(signal))if(!oldListeners.get(signal)!.includes(listener))process.removeListener(signal,listener);
});
async function client(){const socket=createConnection({host:'127.0.0.1',port:h.port});h.sockets.push(socket);socket.on('error',()=>{});await once(socket,'connect');socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');return socket;}
async function tunnel(){const socket=await client();const [response]=await once(socket,'data');expect(response.toString()).toContain('200 Connection Established');return socket;}
async function count(){return new Promise<number>((resolve,reject)=>h.proxy.getConnections((e:any,n:number)=>e?reject(e):resolve(n)));}
async function drained(){for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,5));if(await count()===0)return;}expect(await count()).toBe(0);}

it('remote idle timeout releases both sides across more than the 64-connection limit',async()=>{
  for(let i=0;i<70;i++){
    const socket=await tunnel();socket.destroy();
    const deadline=h.deadlines.filter(x=>x.side==='remote').at(-1);expect(deadline.ms).toBe(30000);deadline.cb();
    await drained();
  }
  expect(h.proxy.maxConnections).toBe(64);expect(await count()).toBe(0);
});
it('client EOF before DNS completes cannot create a late upstream tunnel',async()=>{
  h.deferDns=true;const before=h.connects,socket=await client();
  for(let i=0;i<20 && !h.resolveDns;i++)await new Promise(r=>setImmediate(r));
  expect(h.resolveDns).toBeTypeOf('function');socket.destroy();await new Promise(r=>setTimeout(r,10));
  h.resolveDns([{address:'93.184.216.34',family:4}]);await new Promise(r=>setTimeout(r,10));
  expect(h.connects).toBe(before);await drained();
});
it('orderly half-close flushes the full response instead of truncating buffered bytes',async()=>{
  h.finishWithTail=true;const socket=await tunnel(),chunks:Buffer[]=[];
  socket.on('data',data=>chunks.push(data));const ended=once(socket,'end');
  const payload=Buffer.alloc(128*1024,37);socket.end(payload);await ended;
  expect(Buffer.concat(chunks)).toEqual(Buffer.concat([payload,Buffer.from('tail')]));await drained();
});
