import {afterAll,beforeAll,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({app:undefined as any,binding:vi.fn(),leaseResolve:undefined as any,membersReject:undefined as any,deferLease:false,deferMembers:false}));
vi.mock('fastify',async original=>{
  const actual=await original<any>();
  return {default:(options:any)=>{const app=actual.default(options);h.app=app;app.listen=vi.fn().mockResolvedValue('');return app;}};
});
vi.mock('node:fs/promises',()=>({chmod:async()=>{},unlink:async()=>{},readFile:async()=> 'firewall-v1'}));
vi.mock('node:child_process',()=>({execFileSync:()=> '1\n'}));
vi.mock('./diagnostics.js',()=>({progress:()=>{}}));
vi.mock('./surface.js',()=>({live:true,binding:(...args:any[])=>h.binding(...args),Surface:class {
  profile='/test';env={};async start(){}startCapture(){}async stopCapture(){}async changeMedia(){}async close(){}
}}));
vi.mock('playwright',()=>({chromium:{launchPersistentContext:async()=>{
  const page={goto:async()=>{},bringToFront:async()=>{},locator:()=>({innerText:async()=> 'Layer 1 Sandbox Namespace\nSeccomp-BPF sandbox Yes'}),evaluate:async()=>({width:1920,height:1080,dpr:1,x:0,y:0}),url:()=> 'https://example.com/',on(){},setDefaultTimeout(){},setDefaultNavigationTimeout(){}};
  return {browser:()=>({on(){},async close(){}}),pages:()=>[page],route:async()=>{},routeWebSocket:async()=>{},on(){},newCDPSession:async()=>({send:async()=>({windowId:1}),detach:async()=>{}})};
}}}));
const owner={'x-browser-owner':'1'};
const listeners=new Map<string,Function[]>();
beforeAll(async()=>{
  vi.useFakeTimers({toFake:['Date','performance','setInterval','clearInterval']});
  vi.stubEnv('BROWSER_INTEGRATION','1');vi.stubEnv('BROWSER_FIXTURE','0');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true}));
  for(const signal of ['SIGTERM','SIGINT'] as const)listeners.set(signal,process.listeners(signal));
  h.binding.mockImplementation((route:string)=>{
    if(route==='/lease' && h.deferLease){h.deferLease=false;return new Promise(resolve=>{h.leaseResolve=resolve;});}
    if(route==='/members' && h.deferMembers){h.deferMembers=false;return new Promise((_,reject)=>{h.membersReject=reject;});}
    return Promise.resolve({state:'streaming'});
  });
  await import('./index.js');
});
afterAll(async()=>{
  await h.app.close();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllEnvs();vi.unstubAllGlobals();
  for(const signal of ['SIGTERM','SIGINT'] as const)for(const listener of process.listeners(signal))if(!listeners.get(signal)!.includes(listener))process.removeListener(signal,listener);
});
async function create(){const r=await h.app.inject({method:'POST',url:'/sessions',headers:owner,payload:{}});expect(r.statusCode).toBe(201);return r.json();}
async function close(id:string){const r=await h.app.inject({method:'DELETE',url:`/sessions/${id}`,headers:owner});expect(r.statusCode).toBe(204);}
async function state(id:string){return (await h.app.inject({method:'GET',url:`/sessions/${id}`,headers:owner})).json();}

it('normal End and repeated cleanup leave one closed session and one close operation',async()=>{
  const a=await create();await close(a.sessionId);await close(a.sessionId);
  const ended=await state(a.sessionId);expect(ended.status).toBe('closed');expect(ended.browserReady).toBe(false);
});

it('uses the API-provided session ID to make a lost create response recoverable',async()=>{
  const id='7a419524-6ee7-43ad-839c-b800f781f97c';
  const r=await h.app.inject({method:'POST',url:'/sessions',headers:{...owner,'x-browser-session-id':id},payload:{}});
  expect(r.statusCode).toBe(201);expect(r.json().sessionId).toBe(id);await close(id);
});

it('idle TTL expires without user actions even while the Core watchdog keeps its integration lease alive',async()=>{
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  const a=await create();
  for(let i=0;i<60;i++){
    await vi.advanceTimersByTimeAsync(5000);
    await h.app.inject({method:'GET',url:`/sessions/${a.sessionId}`,headers:{...owner,'x-browser-watchdog':'1'}});
  }
  expect((await state(a.sessionId)).status).toBe('expired');
  expect(log.mock.calls.map(c=>JSON.parse(c[0])).find(e=>e.kind==='session-cleanup'&&e.sessionId===a.sessionId)).toMatchObject({status:'expired',reason:'idle-ttl',mediaState:'streaming'});
  log.mockRestore();
});

it('authorized viewing survives six idle minutes, then a lost Core lease still cleans up',async()=>{
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  const a=await create();
  for(let i=0;i<72;i++) {
    const current=await state(a.sessionId);
    const r=await h.app.inject({method:'POST',url:`/sessions/${a.sessionId}/heartbeat`,payload:{},headers:{...owner,'x-control-epoch':current.collaboration.epoch,'x-control-generation':String(current.collaboration.generation)}});
    expect(r.statusCode).toBe(200);
    await h.app.inject({method:'GET',url:`/sessions/${a.sessionId}`,headers:{...owner,'x-browser-watchdog':'1'}});
    await vi.advanceTimersByTimeAsync(5000);
  }
  expect((await state(a.sessionId)).status).toBe('active');
  await vi.advanceTimersByTimeAsync(7000);
  expect((await state(a.sessionId)).status).toBe('closed');
  expect(log.mock.calls.map(c=>JSON.parse(c[0])).find(e=>e.kind==='session-cleanup'&&e.sessionId===a.sessionId)).toMatchObject({reason:'integration-lease-expired'});
  log.mockRestore();
});

it('standalone sessions retain the owner-presence grace lifecycle',async()=>{
  vi.stubEnv('BROWSER_INTEGRATION','0');const a=await create();await vi.advanceTimersByTimeAsync(31000);
  expect((await state(a.sessionId)).status).toBe('closed');vi.stubEnv('BROWSER_INTEGRATION','1');
});

it('viewer leave removes only viewer membership and does not end BrowserSession',async()=>{
  const a=await create();
  const invite=(await h.app.inject({method:'POST',url:`/sessions/${a.sessionId}/invite`,headers:owner,payload:{}})).json();
  const accepted=(await h.app.inject({method:'POST',url:`/sessions/${a.sessionId}/accept`,payload:{invite:invite.invite,epoch:invite.epoch}})).json();
  const left=await h.app.inject({method:'POST',url:`/sessions/${a.sessionId}/leave`,headers:{'x-browser-guest':accepted.token},payload:{}});
  expect(left.statusCode).toBe(200);expect((await state(a.sessionId)).status).toBe('active');
  await close(a.sessionId);
});

it('a successful old binding response cannot restore streaming after terminal cleanup',async()=>{
  const a=await create();h.deferLease=true;
  await vi.advanceTimersByTimeAsync(1000);expect(h.leaseResolve).toBeTypeOf('function');
  await close(a.sessionId);h.leaseResolve({state:'streaming'});
  await new Promise(resolve=>setImmediate(resolve));
  const ended=await state(a.sessionId);expect(ended.status).toBe('closed');expect(ended.media.state).toBe('closed');
});
it('a failed old membership IPC cannot clean up a newly created BrowserSession',async()=>{
  const a=await create();
  const invitation=(await h.app.inject({method:'POST',url:`/sessions/${a.sessionId}/invite`,headers:owner,payload:{}})).json();
  h.deferMembers=true;
  const pending=h.app.inject({method:'POST',url:`/sessions/${a.sessionId}/accept`,payload:{invite:invitation.invite,epoch:invitation.epoch}}).then((r:any)=>r);
  for(let i=0;i<20 && !h.membersReject;i++)await new Promise(resolve=>setImmediate(resolve));
  expect(h.membersReject).toBeTypeOf('function');
  await close(a.sessionId);const next=await create();await vi.advanceTimersByTimeAsync(1000);
  h.membersReject(Error('BINDING_TIMEOUT'));expect((await pending).statusCode).toBe(503);
  const active=await state(next.sessionId);expect(active.status).toBe('active');expect(active.browserReady).toBe(true);expect(active.media.state).toBe('streaming');
  await close(next.sessionId);
});
it.each(['1080p60','720p15'])('switches to %s without replacing the Chromium BrowserSession',async profile=>{
  const before=await create();let stateBefore=await state(before.sessionId);
  if(profile==='720p15') {
    const first=await h.app.inject({method:'POST',url:`/sessions/${before.sessionId}/quality`,headers:{...owner,'x-control-epoch':stateBefore.collaboration.epoch,'x-control-generation':String(stateBefore.collaboration.generation)},payload:{profile:'720p30'}});
    expect(first.statusCode).toBe(200);stateBefore=first.json();
  }
  const headers={...owner,'x-control-epoch':stateBefore.collaboration.epoch,'x-control-generation':String(stateBefore.collaboration.generation)};
  const changed=await h.app.inject({method:'POST',url:`/sessions/${before.sessionId}/quality`,headers,payload:{profile}});
  expect(changed.statusCode).toBe(200);
  expect(changed.json().sessionId).toBe(before.sessionId);
  expect(changed.json().media).toMatchObject(profile==='1080p60'?{profile,width:1920,height:1080,fps:60,state:'starting'}:{profile,width:1280,height:720,fps:15,state:'starting'});
  expect(changed.json().media.epoch).not.toBe(stateBefore.media.epoch);
  expect(h.binding).toHaveBeenCalledWith('/revoke',{sessionId:before.sessionId,epoch:stateBefore.media.epoch});
  await close(before.sessionId);
});
