import { SharedRoom, OWNER } from "./room.js";
import { progress } from './diagnostics.js';
import { resolveMediaProfile } from './mediaProfile.js';
import { Surface, binding, live } from "./surface.js";
import Fastify from "fastify";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { execFileSync } from 'node:child_process';
import { chmod, unlink, readFile } from "node:fs/promises";
import {
  Empty,
  Input,
  Navigate,
  allowedUrl,
  type BrowserSession,
  type InputAction,
} from "@browser/protocol";
const app = Fastify({
  logger: false,
  bodyLimit: 16384,
  ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  requestTimeout: 20000,
});
const requestStarts = new WeakMap<object, number>();
app.addHook('onRequest', async req => {
  if(process.env.BROWSER_TRACE!=='1')return;
  requestStarts.set(req,performance.now());
  console.log(JSON.stringify({kind:'worker-request',phase:'received',traceId:req.headers['x-request-id'],at:Date.now(),method:req.method,path:req.url}));
});
app.addHook('onResponse', async (req,reply) => {
  const start=requestStarts.get(req);if(start===undefined)return;
  console.log(JSON.stringify({kind:'worker-request',phase:'completed',traceId:req.headers['x-request-id'],at:Date.now(),elapsedMs:performance.now()-start,status:reply.statusCode}));
});
let browser: Browser | undefined,
  browserContext: BrowserContext | undefined,
  page: Page | undefined,
  session: BrowserSession | undefined,
  closing = false;
let surface: Surface | undefined;
let shared: SharedRoom | undefined;
let integrationLeaseUntil = 0;
let syncing = false;
let cleaning: Promise<void> | undefined;
let tail = Promise.resolve(),
  pending = 0;
const tabIds = new Map<Page, string>(), tabTitles = new Map<Page, string>();
const pageWindows = new Map<Page, string>();
const idleMs = Number(process.env.IDLE_MS ?? 300000),
  ttlMs = Number(process.env.TTL_MS ?? 1200000);
const defaultMediaProfile = resolveMediaProfile();
let mediaProfile = defaultMediaProfile;
const captureWidth = 1920, captureHeight = 1080;
function error(code: string, statusCode = 409) {
  return Object.assign(new Error(code), { statusCode, code });
}
async function guard() {
  try {
    if ((await readFile("/guard/ready", "utf8")).trim() !== "firewall-v1")
      throw new Error("Firewall unavailable");
    const r = await fetch(`${process.env.BROWSER_PROXY ?? "http://172.30.81.2:3128"}/guard-ready`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) throw new Error("Proxy unavailable");
  } catch {
    throw error("DEPENDENCIES_UNAVAILABLE", 503);
  }
}
async function cleanup(status: BrowserSession["status"], reason = 'operation-failure', expected = session) {
  if (!expected || expected !== session || !['creating','active','closing'].includes(expected.status)) return;
  if (cleaning) return cleaning;
  shared?.close();
  console.log(JSON.stringify({kind:'session-cleanup',at:Date.now(),pid:process.pid,status,previous:session?.status,sessionId:session?.sessionId,epoch:session?.media?.epoch,generation:shared?.generation,reason,integrationLeaseUntil,ownerSeen:shared?.ownerSeen,mediaState:session?.media?.state}));
  const b = browser;
  browser = undefined;
  browserContext = undefined;
  page = undefined;
  tabIds.clear(); tabTitles.clear();
  pageWindows.clear();
  const target = session;
  if (target) target.status = "closing";
  const job = (async () => {
    const deadline = setTimeout(() => process.exit(1), 10000);
    try {
      await surface?.stopCapture();
      if (target?.media) {
        await binding('/revoke', {sessionId:target.sessionId,epoch:target.media.epoch});
        target.media.state = 'closed';
      }
      if (b) await b.close();
      await surface?.close(); surface = undefined;
      if (target) target.browserReady = false;
      if (target) target.status = status;
    } catch {
      // A failed revoke must never allow a new session beside the old process tree.
      process.exit(1);
    } finally {
      clearTimeout(deadline);
      mediaProfile = defaultMediaProfile;
    }
  })();
  cleaning = job;
  try {
    await job;
  } finally {
    cleaning = undefined;
  }
}
function serial<T>(fn: () => Promise<T>): Promise<T> {
  if (closing || pending >= 16) return Promise.reject(error("QUEUE_FULL", 429));
  pending++;
  const result = tail.then(fn);
  tail = result
    .then(
      () => {},
      () => {},
    )
    .finally(() => {
      pending--;
    });
  return result;
}
function active(id: string) {
  if (!session || session.sessionId !== id) throw error("NOT_FOUND", 404);
  if (session.status !== "active" || !page) throw error("SESSION_NOT_ACTIVE");
  if (
    Date.now() >= Date.parse(session.expiresAt) ||
    Date.now() >= Date.parse(session.idleExpiresAt)
  )
    throw error("SESSION_EXPIRED");
  return page;
}
function touch() {
  if (session) {
    session.lastActivityAt = new Date().toISOString();
    session.idleExpiresAt = new Date(Date.now() + idleMs).toISOString();
    session.currentUrl = page?.url() ?? session.currentUrl;
  }
}
function pageClosed(p: Page) { return typeof p.isClosed === 'function' && p.isClosed(); }
function tabSnapshot() {
  return [...tabIds].filter(([p]) => !pageClosed(p)).map(([p, id]) => ({ id, url: p.url(), title: tabTitles.get(p) || (() => { try { return new URL(p.url()).hostname || 'Новая вкладка'; } catch { return 'Новая вкладка'; } })() }));
}
function trackPage(p: Page, activate: boolean) {
  if (tabIds.has(p)) { if (activate) page = p; return; }
  if (tabIds.size >= 10) { void p.close(); return; }
  tabIds.set(p, randomUUID());
  p.on('domcontentloaded', () => { void p.title().then(title => { if (!pageClosed(p)) tabTitles.set(p, title); }).catch(() => {}); });
  p.on('framenavigated', frame => {
    if (session?.status === 'active' && frame === p.mainFrame() && page === p) {
      session.currentUrl = p.url();
      session.tabs = tabSnapshot();
    }
  });
  p.on('close', () => {
    tabIds.delete(p); tabTitles.delete(p); pageWindows.delete(p);
    if (page === p) {
      const next = [...tabIds.keys()].filter(candidate => !pageClosed(candidate)).at(-1);
      page = next;
      if (session && next) { session.activeTabId = tabIds.get(next); session.currentUrl = next.url(); session.tabs = tabSnapshot(); }
    }
  });
  if (activate) page = p;
  if (session) { session.tabs = tabSnapshot(); session.activeTabId = tabIds.get(page!); }
}
async function foreground(p: Page) {
  const { width, height } = { width: captureWidth, height: captureHeight };
  await p.bringToFront();
  const cdp = await browserContext!.newCDPSession(p);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {windowId,bounds:{windowState:'normal',left:0,top:0,width,height}});
    await cdp.send('Browser.setWindowBounds', {windowId,bounds:{windowState:'fullscreen'}});
  } finally { await cdp.detach(); }
  // Xvfb has no window manager, so CDP target activation alone does not raise a sibling window.
  const windows = execFileSync('xdotool',['search','--onlyvisible','--class','chromium'],{env:surface!.env,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split(/\s+/).filter(Boolean);
  let window = pageWindows.get(p);
  if (!window && windows.length) {
    window = windows.reduce((latest,id)=>BigInt(id)>BigInt(latest)?id:latest);
    pageWindows.set(p,window);
  }
  if (window) {
    let raised = true;
    try {
      execFileSync('xdotool',['windowmove',window,'0','0'],{env:surface!.env,stdio:'ignore'});
      execFileSync('xdotool',['windowsize',window,String(width),String(height)],{env:surface!.env,stdio:'ignore'});
      execFileSync('xdotool',['windowraise',window],{env:surface!.env,stdio:'ignore'});
      execFileSync('xdotool',['windowfocus','--sync',window],{env:surface!.env,stdio:'ignore'});
    } catch { raised = false; }
    console.log(JSON.stringify({kind:'session-foreground',sessionId:session?.sessionId,pageId:tabIds.get(p),windows,selected:window,raised}));
  }
}
function dto(id=OWNER) {
  if (session) { session.tabs = tabSnapshot(); session.activeTabId = page ? tabIds.get(page) : undefined; }
  return {...session, ...(shared?{collaboration:shared.snapshot(id)}:{})};
}
app.setErrorHandler((value, _req, reply) => {
  const e = value as Error & {
    statusCode?: number;
    code?: string;
  };
  const status = e.statusCode ?? 500;
  reply
    .code(status)
    .send({
      error: {
        code:
          status === 400
            ? "INVALID_ACTION"
            : status >= 500
              ? (e.code ?? "BROWSER_FAILURE")
              : e.message,
        message: status >= 500 ? "Browser operation failed" : e.message,
      },
    });
});
// The private socket is reachable only by the trusted API, which overwrites identity headers.
app.addHook('preHandler', async req => {
  if(!live || !req.url.startsWith('/sessions'))return;
  if(req.url==='/sessions') {if(req.headers['x-browser-owner']!=='1')throw error('ACCESS_DENIED',403);return;}
  if(/^\/sessions\/[^/]+\/accept$/.test(req.url) && req.method==='POST')return;
  const id=req.url.split('/')[2];
  if(!session || session.sessionId!==id || !shared)throw error('NOT_FOUND',404);
  const member=shared.member(req.headers['x-browser-owner']==='1',String(req.headers['x-browser-guest']??''));
  if(member===OWNER && !shared.closed && req.headers['x-browser-watchdog']!=='1')shared.ownerSeen=Date.now();
  if(member===OWNER && process.env.BROWSER_INTEGRATION==='1' && req.headers['x-browser-watchdog']==='1')integrationLeaseUntil=Date.now()+6000;
});
function actor(req: {headers:Record<string,unknown>}) {
  return shared!.member(req.headers['x-browser-owner']==='1',String(req.headers['x-browser-guest']??''));
}
function fence(req: {headers:Record<string,unknown>}, id:string) {
  if(live)shared!.fence(id,req.headers['x-control-epoch'],req.headers['x-control-generation']);
}
async function members() {
  const target=session,room=shared;
  if(!target?.media || !room)return;
  try {await binding('/members',{sessionId:target.sessionId,epoch:room.epoch,identities:room.identities()});}
  catch {await cleanup('crashed','membership-sync-failed',target);throw error('MEMBERSHIP_SYNC_FAILED',503);}
}
app.post<{Params:{id:string}}>('/sessions/:id/media',async req=>{
  active(req.params.id);const id=actor(req);
  const result=await binding('/viewer',{sessionId:session!.sessionId,epoch:shared!.epoch,identity:shared!.viewer(id)});
  // Membership may change during broker IPC; never return authorization after revoke.
  if(actor(req)!==id)throw error('ACCESS_DENIED',403);
  return result;
});
app.post<{Params:{id:string}}>('/sessions/:id/invite', {schema:{body:Empty}},async req=>{
  active(req.params.id);return shared!.issue(actor(req));
});
app.post<{Params:{id:string};Body:{invite:string;epoch:string}}>('/sessions/:id/accept', {
  schema:{body:{type:'object',additionalProperties:false,required:['invite','epoch'],properties:{invite:{type:'string',minLength:43,maxLength:43},epoch:{type:'string',minLength:36,maxLength:36}}}},
},async req=>{
  active(req.params.id);if(!shared)throw error('ACCESS_DENIED',403);
  const auth=shared.accept(req.body.invite,req.body.epoch);await members();shared.member(false,auth.token);
  return {...auth,session:dto(auth.identity)};
});
app.post<{Params:{id:string}}>('/sessions/:id/heartbeat',{schema:{body:Empty}},async req=>{
  active(req.params.id);const id=actor(req);shared!.heartbeat(id,String(req.headers['x-control-epoch']??''),String(req.headers['x-control-generation']??''),process.env.BROWSER_INTEGRATION==='1' && req.headers['x-browser-renew-member']==='1');
  // An authorized viewer is active even while watching without mouse/keyboard input.
  if(req.headers['x-control-epoch']===shared!.epoch && req.headers['x-control-generation']===String(shared!.generation))touch();
  return dto(id);
});
app.post<{Params:{id:string;op:string}}>('/sessions/:id/control/:op',{schema:{body:Empty}},async req=>{
  active(req.params.id);const id=actor(req);
  if(req.headers['x-control-epoch']!==shared!.epoch || req.headers['x-control-generation']!==String(shared!.generation))throw error('STALE_CONTROL_LEASE',403);
  shared!.control(id,req.params.op);
  // Revoke fences queued work immediately; acknowledge after any already-running operation settles.
  await tail;return dto(id);
});
app.delete<{Params:{id:string}}>('/sessions/:id/invite',async req=>{
  active(req.params.id);shared!.owner(actor(req));shared!.invite=undefined;return dto();
});
app.delete<{Params:{id:string}}>('/sessions/:id/guest',async req=>{
  active(req.params.id);shared!.remove(actor(req),true);await members();await tail;return dto();
});
app.post<{Params:{id:string}}>('/sessions/:id/leave',{schema:{body:Empty}},async req=>{
  active(req.params.id);shared!.remove(actor(req));await members();await tail;return {status:'left'};
});
app.get("/ready", async () => {
  await guard();
  return { status: "ready" };
});
app.post("/sessions", { schema: { body: Empty } }, async (req, reply) => {
  const result = await serial(async () => {
    if (browser || surface || cleaning) throw error("SESSION_LIMIT");
    await guard();
    const requestedId=req.headers['x-browser-session-id'];
    if(typeof requestedId==='string' && !/^[0-9a-f-]{36}$/.test(requestedId))throw error('INVALID_SESSION_ID',400);
    const now = new Date().toISOString();
    session = {
      sessionId: typeof requestedId==='string' ? requestedId : randomUUID(),
      ownerId: "local-owner",
      status: "creating",
      createdAt: now,
      lastActivityAt: now,
      currentUrl: "about:blank",
      workerId: process.env.HOSTNAME ?? "worker",
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      idleExpiresAt: new Date(Date.now() + idleMs).toISOString(),
    };
    try {
      progress('session-start', { sessionId: session.sessionId });
      if (live) {
        const epoch = randomUUID();
        session.media = { epoch, room: `browser-${epoch}`, publisher: `publisher-${epoch}`, profile: mediaProfile.name, width: mediaProfile.width, height: mediaProfile.height, fps: mediaProfile.fps, state: 'starting' };
        shared = new SharedRoom(session.sessionId,epoch,Date.parse(session.expiresAt));
        await binding('/bind', {sessionId:session.sessionId,ownerId:session.ownerId,epoch,expiresAt:session.expiresAt,profile:mediaProfile.name});
        await members();
        const target=session;
        surface = new Surface(session, reason => { console.log(JSON.stringify({kind:'surface-failure',at:Date.now(),sessionId:target.sessionId,reason})); void cleanup("crashed",reason,target).catch(() => process.exit(1)); });
        await surface.start();
      }
      const launch = {
        headless: !live,
        channel: "chromium",
        chromiumSandbox: true,
        proxy: { server: process.env.BROWSER_PROXY ?? "http://172.30.81.2:3128" },
        timeout: 15000,
        args: [...(live ? ["--kiosk", "--window-position=0,0", `--window-size=${captureWidth},${captureHeight}`] : []), "--disable-quic", "--proxy-bypass-list=<-loopback>", "--deny-permission-prompts"],
      };
      const options = {
        viewport: { width: captureWidth, height: captureHeight }, deviceScaleFactor: 1,
        serviceWorkers: "block" as const, acceptDownloads: false, permissions: [],
      };
      progress('chromium-launch', { sessionId: session.sessionId });
      const persistent = live ? await chromium.launchPersistentContext(surface!.profile, {
        ...launch, ...options, env: surface!.env, ignoreDefaultArgs: ['--mute-audio'],
      }) : undefined;
      browser = persistent ? persistent.browser()! : await chromium.launch(launch);
      progress('chromium-ready', { sessionId: session.sessionId });
      if (closing || session.status !== 'creating' || cleaning) {
        await browser.close(); browser=undefined;
        throw error("SESSION_START_CANCELLED", 503);
      }
      const target=session, startedBrowser=browser;
      browser.on("disconnected", () => {
        if (browser===startedBrowser) {
          console.log(JSON.stringify({kind:'browser-terminated',at:Date.now(),sessionId:target.sessionId}));void cleanup("crashed",'browser-disconnected',target);
        }
      });
      const context = persistent ?? await browser.newContext(options);
      browserContext = context;
      page = context.pages()[0] ?? await context.newPage();
      trackPage(page, false);
      if(live) {
        await page.goto('chrome://sandbox');
        const sandbox=await page.locator('body').innerText();
        if(!/Layer 1 Sandbox\s+Namespace/.test(sandbox) || !/Seccomp-BPF sandbox\s+Yes/.test(sandbox)) throw Error('SANDBOX_UNAVAILABLE');
        console.log(JSON.stringify({kind:'session-sandbox-pass',sessionId:session.sessionId}));
        await page.goto('about:blank');
      }
      const fixture = process.env.BROWSER_FIXTURE === '1' ? await readFile('/app/session/fixture.html', 'utf8') : undefined;
      await context.route("**/*", (route) => {
        const url = route.request().url();
        if (fixture && url.startsWith('https://example.com/capture-fixture')) {
          console.log(JSON.stringify({kind:'session-fixture-served',sessionId:session?.sessionId}));
          return route.fulfill({contentType:'text/html',body:fixture});
        }
        return allowedUrl(url) ? route.continue() : route.abort();
      });
      await context.routeWebSocket("**/*", (ws) => ws.close());
      // Redirect requests may skip route handlers; terminate on every forbidden request.
      context.on("request", (request) => {
        if (request.isNavigationRequest() && !allowedUrl(request.url()) && !(session?.status==='creating' && request.url()==='about:blank')) {
          console.log(JSON.stringify({kind:'browser-terminated',reason:'forbidden-navigation'}));void cleanup("crashed",'forbidden-navigation',target);
        }
      });
      context.on("page", (p) => {
        trackPage(p, true);
      });
      if(live) {
        await foreground(page);
        const geometry = await page.evaluate(() => ({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,x:screenX,y:screenY}));
        if(geometry.width!==captureWidth || geometry.height!==captureHeight || geometry.dpr!==1 || geometry.x!==0 || geometry.y!==0) throw Error('GEOMETRY_MISMATCH');
        console.log(JSON.stringify({kind:'session-geometry',sessionId:session.sessionId,...geometry}));
        if(process.env.BROWSER_FIXTURE === '1') {
          await context.route('https://example.com/capture-upstream-error', route=>route.abort('connectionreset'));
          await context.route('https://example.com/capture-timeout', async route=>{
            await new Promise(resolve=>setTimeout(resolve,13000));
            await route.fulfill({contentType:'text/html',body:fixture}).catch(()=>{});
          });
        }
        surface!.startCapture();
      }
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(12000);
      page.on("crash", () => {
        console.log(JSON.stringify({kind:'browser-terminated'}));void cleanup("crashed",'page-crash',target);
      });
      page.on("dialog", (d) => {
        void d.dismiss();
      });
      session.tabs=tabSnapshot();session.activeTabId=tabIds.get(page);
      session.browserReady = true;
      progress('session-ready', { sessionId: session.sessionId });
      session.status = "active";
      integrationLeaseUntil = Date.now() + 6000;
      return dto();
    } catch (e) {
      const message=e instanceof Error?e.message:'';
      progress('session-start-failure', { sessionId: session.sessionId });
      const reason=['GEOMETRY_MISMATCH','DISPLAY_FAILED','DISPLAY_TIMEOUT','SESSION_START_CANCELLED'].find(code=>message.includes(code)) ?? (message.includes('Timeout')?'START_TIMEOUT':'START_FAILURE');
      console.log(JSON.stringify({kind:'session-start-failed',reason,detail:message.split('\n')[0].replace(/https?:\/\/\S+/g,'[url]').slice(0,180)}));
      await cleanup("crashed");
      throw error("BROWSER_START_FAILED", 502);
    }
  });
  return reply.code(201).send(result);
});
app.get<{
  Params: {
    id: string;
  };
}>("/sessions/:id", async (req) => {
  if (!session || session.sessionId !== req.params.id)
    throw error("NOT_FOUND", 404);
  return dto(live?actor(req):OWNER);
});
app.delete<{
  Params: {
    id: string;
  };
}>("/sessions/:id", async (req, reply) => {
  await serial(async()=>{
    if (!session || session.sessionId !== req.params.id)throw error('NOT_FOUND',404);
    if(live)shared!.owner(actor(req));
    await cleanup('closed','owner-delete');
  });
  return reply.code(204).send();
});
app.post<{Params:{id:string};Body:{}}>("/sessions/:id/tabs",{schema:{body:Empty}},async req=>{
  const id=live?actor(req):OWNER; active(req.params.id);fence(req,id);
  return serial(async()=>{
    active(req.params.id);fence(req,id);
    if(tabIds.size>=10)throw error('TAB_LIMIT');
    const created=await browserContext!.newPage();trackPage(created,true);await foreground(created);
    touch();return dto(id);
  });
});
app.post<{Params:{id:string;tabId:string};Body:{}}>("/sessions/:id/tabs/:tabId/activate",{schema:{body:Empty}},async req=>{
  const id=live?actor(req):OWNER; active(req.params.id);fence(req,id);
  return serial(async()=>{
    active(req.params.id);fence(req,id);
    const target=[...tabIds].find(([,tabId])=>tabId===req.params.tabId)?.[0];
    if(!target || pageClosed(target))throw error('TAB_NOT_FOUND',404);
    page=target;await foreground(target);touch();return dto(id);
  });
});
app.post<{Params:{id:string;tabId:string};Body:{}}>("/sessions/:id/tabs/:tabId/close",{schema:{body:Empty}},async req=>{
  const id=live?actor(req):OWNER; active(req.params.id);fence(req,id);
  return serial(async()=>{
    active(req.params.id);fence(req,id);
    const target=[...tabIds].find(([,tabId])=>tabId===req.params.tabId)?.[0];
    if(!target || pageClosed(target))throw error('TAB_NOT_FOUND',404);
    if(tabIds.size===1){
      const replacement=await browserContext!.newPage();trackPage(replacement,true);await foreground(replacement);
    }
    await target.close();touch();return dto(id);
  });
});
app.post<{Params:{id:string};Body:{profile:string}}>("/sessions/:id/quality",{schema:{body:{type:'object',additionalProperties:false,required:['profile'],properties:{profile:{type:'string',enum:['720p15','720p30','720p60','1080p30','1080p60']}}}}},async req=>{
  const id=live?actor(req):OWNER;active(req.params.id);fence(req,id);
  return serial(async()=>{
    active(req.params.id);fence(req,id);
    const next=resolveMediaProfile(req.body.profile);
    if(next.name===mediaProfile.name)return dto(id);
    if(!live || !surface || !session?.media)throw error('QUALITY_UNAVAILABLE');
    const target=session,old=session.media,room=shared!;
    await surface.stopCapture();
    try { await binding('/revoke',{sessionId:target.sessionId,epoch:old.epoch}); }
    catch(e) {
      try { await surface.changeMedia(old.epoch,old.profile);surface.startCapture(); }
      catch { await cleanup('crashed','quality-revoke-recovery-failed',target); }
      throw e;
    }
    const replacementRoom=room.rebind(randomUUID());
    room.close();
    const epoch=replacementRoom.epoch;
    try {
      const expiresAt=target.expiresAt;
      target.media={epoch,room:`browser-${epoch}`,publisher:`publisher-${epoch}`,profile:next.name,width:next.width,height:next.height,fps:next.fps,state:'starting'};
      shared=replacementRoom;
      await binding('/bind',{sessionId:target.sessionId,ownerId:target.ownerId,epoch,expiresAt,profile:next.name});
      await members();
      await surface.changeMedia(epoch,next.name);
      mediaProfile=next;
      surface.startCapture();
      touch();
      return dto(id);
    } catch(e) {
      await cleanup('crashed','quality-change-failed',target);
      throw e;
    }
  });
});
app.get<{
  Params: {
    id: string;
  };
}>("/sessions/:id/frame", async (req, reply) =>
  reply
    .type("image/png")
    .header("cache-control", "no-store")
    .send(
      await serial(async () => {
        const p = active(req.params.id);
        if(live)actor(req);
        try { const frame=await p.screenshot({ timeout: 8000 });if(live)actor(req);return frame; }
        catch(e) { if(e instanceof Error && "statusCode" in e)throw e;await cleanup("crashed"); throw error("FRAME_FAILED", 502); }
      }),
    ),
);
for (const action of [
  "navigate",
  "back",
  "forward",
  "reload",
  "input",
] as const) {
  app.post<{
    Params: {
      id: string;
    };
    Body: unknown;
  }>(
    `/sessions/:id/${action}`,
    {
      schema: {
        body:
          action === "navigate" ? Navigate : action === "input" ? Input : Empty,
      },
    },
    (req) => {
      const id=live?actor(req):OWNER;
      active(req.params.id);fence(req,id);
      return serial(async () => {
        const p = active(req.params.id);
        fence(req,id);
        await guard();
        active(req.params.id);fence(req,id);
        try {
          if (action === "navigate") {
            const { url } = req.body as {
              url: string;
            };
            if (!allowedUrl(url)) throw error("URL_FORBIDDEN", 400);
            await p.goto(url, { waitUntil: "domcontentloaded" });
            if(surface && process.env.BROWSER_FIXTURE==='1' && url.startsWith('https://example.com/capture-fixture'))await surface.verifyEdges();
          }
          if (action === "back")
            await p.goBack({ waitUntil: "domcontentloaded" });
          if (action === "forward")
            await p.goForward({ waitUntil: "domcontentloaded" });
          if (action === "reload")
            await p.reload({ waitUntil: "domcontentloaded" });
          if (action === "input") {
            const a = req.body as InputAction;
            switch (a.type) {
              case "mouseMove":
                await p.mouse.move(a.x*captureWidth/mediaProfile.width, a.y*captureHeight/mediaProfile.height);
                break;
              case "mouseClick":
                await p.mouse.click(a.x*captureWidth/mediaProfile.width, a.y*captureHeight/mediaProfile.height, { button: a.button });
                break;
              case "wheel":
                await p.mouse.move(a.x*captureWidth/mediaProfile.width, a.y*captureHeight/mediaProfile.height);
                fence(req,id);
                await p.mouse.wheel(a.deltaX, a.deltaY);
                break;
              case "text":
                await p.keyboard.insertText(a.text);
                break;
              case "keyPress":
                await p.keyboard.press(a.key);
                break;
            }
          }
          delete session!.navigationError;
          touch();
          return dto(id);
        } catch (e) {
          if (e instanceof Error && "statusCode" in e) throw e;
          if (browser?.isConnected() && !p.isClosed()) {
            const message = e instanceof Error ? e.message : '';
            const classification = message.includes('Timeout') || message.includes('timeout') ? 'timeout' : 'upstream';
            session!.navigationError = classification;
            touch();
            console.log(JSON.stringify({kind:'navigation-error',action,classification,sessionId:session!.sessionId}));
            throw error(classification === 'timeout' ? 'NAVIGATION_TIMEOUT' : 'UPSTREAM_NAVIGATION_FAILED', 502);
          }
          await cleanup("crashed");
          throw error("BROWSER_ACTION_FAILED", 502);
        }
      });
    },
  );
}
const timer = setInterval(() => {
  if(live && shared && session?.status==='active') {
    shared.tick();
    if(process.env.BROWSER_INTEGRATION==='1') {if(Date.now()>=integrationLeaseUntil)void cleanup('closed','integration-lease-expired');}
    else if(Date.now()-shared.ownerSeen>=shared.graceMs)void cleanup('closed','owner-presence-expired');
    else if(shared.guest && Date.now()>=shared.guest.expiresAt) {shared.remove(OWNER,true);void members().catch(()=>{});}
  }
  if (session?.media && !cleaning && !syncing && ['creating','active'].includes(session.status)) {
    const target=session; syncing=true;
    void binding('/lease',{sessionId:target.sessionId,epoch:target.media!.epoch}).then(r=>{
      if(session===target && !cleaning && ['creating','active'].includes(target.status)) target.media!.state=r.state;
    }).catch(e=>{
      if(session===target && !cleaning && ['creating','active'].includes(target.status)) {
        console.log(JSON.stringify({kind:'binding-lease-failure',at:Date.now(),sessionId:target.sessionId,reason:e instanceof Error?e.message:'unknown'}));
        return cleanup('crashed','binding-lease-failure',target);
      }
    }).catch(()=>process.exit(1)).finally(()=>{syncing=false;});
  }
  if (
    session &&
    browser &&
    (Date.now() >= Date.parse(session.expiresAt) ||
      Date.now() >= Date.parse(session.idleExpiresAt))
  )
    void cleanup("expired",Date.now() >= Date.parse(session.expiresAt)?'absolute-ttl':'idle-ttl');
}, 1000);
const controlSocket=process.env.BROWSER_CONTROL_SOCKET ?? '/control/worker.sock';
await unlink(controlSocket).catch(() => {});
await app.listen({ path: controlSocket });
await chmod(controlSocket, 0o660);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    closing = true;
    clearInterval(timer);
    const deadline = setTimeout(() => process.exit(1), 10000);
    void cleanup("closed")
      .then(() => app.close())
      .finally(() => {
        clearTimeout(deadline);
      });
  });
