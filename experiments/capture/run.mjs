// Local-only harness. No control listener, eval endpoint, LiveKit secret or auth mount.
import {chromium} from 'playwright';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {request} from 'node:http';
import {inputControl} from './input-control.mjs';
import {monitorEventLoopDelay,PerformanceObserver} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
const method=process.env.CAPTURE_METHOD??'x11';assert(['x11','cdp'].includes(method));
const fps=Number(process.env.FPS??15), width=1280,height=720,size=width*height*4;
const ttl=Number(process.env.CAPTURE_TTL_MS??1200000);assert(Number.isInteger(ttl)&&ttl>=1000&&ttl<=1200000);setTimeout(()=>{log('ttl-expired');void close()},ttl);
assert([15,30].includes(fps));assert.notEqual(process.getuid(),0);
assert.equal((await readFile('/guard/ready','utf8')).trim(),'firewall-v1');
const delay=monitorEventLoopDelay({resolution:10});delay.enable();let gcMs=0;new PerformanceObserver(list=>{for(const e of list.getEntries())gcMs+=e.duration}).observe({entryTypes:['gc']});
let lastActivity=performance.now(),control;const idle=Number(process.env.CAPTURE_IDLE_MS??1200000);assert(Number.isInteger(idle)&&idle>=1000&&idle<=1200000);
const profile=await mkdtemp('/tmp/capture-profile-');
let browser,xvfb,capture,closing=false,latest,busy=false,count=0,replacements=0,sent=0,failed=0,lastCommand='';
const log=(kind,data={})=>console.log(JSON.stringify({kind,at:Date.now(),...data}));
async function close(code=0){if(closing)return;closing=true;latest=undefined;const deadline=setTimeout(()=>process.exit(1),8000);control?.closeAllConnections();control?.close();capture?.kill('SIGTERM');await browser?.close();xvfb?.kill('SIGTERM');await rm(profile,{recursive:true,force:true});clearTimeout(deadline);process.exit(code)}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void close());
try{
 process.env.XAUTHORITY=profile+'/Xauthority';execFileSync('xauth',['-f',process.env.XAUTHORITY,'add',':91','.',randomBytes(16).toString('hex')]);
 // Chromium clamps native bounds to screen minus one; keep the exact app rectangle inside a 1281x721 display.
 xvfb=spawn('Xvfb',[':91','-auth',process.env.XAUTHORITY,'-screen','0','1281x721x24','-nolisten','tcp'],{stdio:['ignore','ignore','pipe']});
 xvfb.on('exit',()=>{if(!closing)void close(1)});await sleep(1000);
 browser=await chromium.launchPersistentContext(profile,{headless:false,channel:'chromium',chromiumSandbox:true,ignoreDefaultArgs:['about:blank'],
  env:{...process.env,DISPLAY:':91'},viewport:{width,height},deviceScaleFactor:1,permissions:[],serviceWorkers:'block',acceptDownloads:false,
  proxy:{server:'http://172.30.85.2:3128'},args:['--app=https://example.com/','--window-position=0,0','--window-size=1280,720','--disable-quic','--proxy-bypass-list=<-loopback>','--deny-permission-prompts'],timeout:15000});
 browser.on('close',()=>{if(!closing)void close(1)});
 const page=browser.pages()[0];browser.on('page',p=>{if(p!==page)void p.close()});page.on('dialog',d=>void d.dismiss());page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(12000);
 await page.goto('chrome://sandbox');const sandbox=await page.locator('body').innerText();assert.match(sandbox,/Layer 1 Sandbox\s+Namespace/);assert.match(sandbox,/Seccomp-BPF sandbox\s+Yes/);log('sandbox',{sandbox});
 const allowed=url=>{try{const u=new URL(url);return u.protocol==='https:'&&['example.com','www.selenium.dev'].includes(u.hostname)&&!u.port&&!u.username&&!u.password}catch{return false}};
 const fixture=await readFile('/app/experiments/capture/fixture.html','utf8');
 await browser.route('**/*',route=>route.request().url()==='https://example.com/capture-fixture'?route.fulfill({contentType:'text/html',body:fixture}):allowed(route.request().url())?route.continue():route.abort());
 await browser.routeWebSocket('**/*',ws=>ws.close());
 if(process.env.CAPTURE_PUBLIC_CHECK!=='0'){
 await page.goto('https://example.com/');assert.match(await page.locator('body').innerText(),/documentation/);log('public-example-pass');
 await page.goto('https://www.selenium.dev/selenium/web/web-form.html');await page.locator('[name=my-text]').fill('Real Chromium');assert.equal(await page.locator('[name=my-text]').inputValue(),'Real Chromium');log('public-form-pass');
 await page.goBack();await page.goForward();await page.reload();log('history-pass');
 }
 await page.goto('https://example.com/capture-fixture');
 assert.equal(await page.evaluate(()=>localStorage.getItem('gate-profile')),null);assert.equal((await browser.cookies()).filter(c=>c.name==='gate-profile').length,0);
 await page.evaluate(value=>localStorage.setItem('gate-profile',value),profile);await browser.addCookies([{name:'gate-profile',value:profile,url:'https://example.com'}]);log('fresh-storage-pass',{profile});
 const windowSession=await browser.newCDPSession(page);const {windowId,bounds:beforeBounds}=await windowSession.send('Browser.getWindowForTarget');
 await windowSession.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
 await windowSession.send('Browser.setWindowBounds',{windowId,bounds:{left:0,top:0,width,height}});
 log('window-bounds',{beforeBounds,after:(await windowSession.send('Browser.getWindowBounds',{windowId})).bounds});
 await sleep(1000);log('geometry',await page.evaluate(()=>({innerWidth,innerHeight,outerWidth,outerHeight,screenX,screenY,devicePixelRatio,screenWidth:screen.width,screenHeight:screen.height})));
 control=await inputControl(page,()=>{lastActivity=performance.now()});
 setInterval(()=>{if(performance.now()-lastActivity>idle){log('idle-expired');void close()}},100);
 capture=spawn('ffmpeg',method==='x11'?['-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-f','x11grab','-draw_mouse','0','-framerate',String(fps),'-video_size','1280x720','-i',':91.0+0,0','-an','-threads','1','-pix_fmt','rgba','-f','rawvideo','pipe:1']:['-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-f','image2pipe','-vcodec','mjpeg','-i','pipe:0','-an','-vf','scale=1280:720','-threads','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'],{stdio:[method==='cdp'?'pipe':'ignore','pipe','inherit']});
 if(method==='cdp'){const cdp=await browser.newCDPSession(page);let jpeg,writing=false;async function flush(){if(writing||!jpeg||closing)return;writing=true;const bytes=jpeg;jpeg=undefined;await new Promise(resolve=>capture.stdin.write(bytes,resolve));writing=false;void flush()}cdp.on('Page.screencastFrame',event=>{void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId});if(jpeg)replacements++;jpeg=Buffer.from(event.data,'base64');void flush()});await cdp.send('Page.startScreencast',{format:'jpeg',quality:90,maxWidth:1280,maxHeight:720,everyNthFrame:fps===15?4:2})}
 capture.on('exit',()=>{if(!closing)void close(1)});
 const reuse=process.env.CAPTURE_REUSE==='1',pool=reuse?[Buffer.allocUnsafe(size),Buffer.allocUnsafe(size)]:[];
 let frame=Buffer.allocUnsafe(size),offset=0;
 capture.stdout.on('data',chunk=>{let pos=0;while(pos<chunk.length){const n=Math.min(size-offset,chunk.length-pos);chunk.copy(frame,offset,pos,pos+n);offset+=n;pos+=n;if(offset===size){count++;if(count===1){const points=[[0,360],[1279,360],[640,0],[640,719],[0,0],[1279,0],[0,719],[1279,719]];log('raw-edges',{points:points.map(([x,y])=>({x,y,rgba:[...frame.subarray((y*width+x)*4,(y*width+x)*4+4)]}))});const expected=[[255,128,0],[0,128,255],[255,0,255],[0,255,255],[255,0,0],[0,255,0],[0,0,255],[255,255,0]];for(let i=0;i<points.length;i++){const [x,y]=points[i];assert.deepEqual([...frame.subarray((y*width+x)*4,(y*width+x)*4+3)],expected[i],'raw edge '+i)}log('raw-edges-pass')}if(latest){replacements++;if(reuse)pool.push(latest.pixels)}latest={pixels:frame,at:Date.now(),sequence:count};frame=reuse?pool.pop():Buffer.allocUnsafe(size);assert(frame);offset=0;void send()}}});
 async function send(){if(busy||closing||!latest)return;busy=true;const f=latest;latest=undefined;const header=Buffer.alloc(24);header.writeUInt32LE(width,0);header.writeUInt32LE(height,4);header.writeBigUInt64LE(BigInt(f.sequence),8);header.writeDoubleLE(f.at,16);const start=performance.now();await new Promise(resolve=>{let settled=false;const finish=ok=>{if(settled)return;settled=true;ok?sent++:failed++;resolve()};const req=request({socketPath:'/frames/media.sock',path:'/frame',method:'POST',headers:{'content-length':size+24}},res=>{res.resume();res.on('end',()=>finish(res.statusCode===204));res.on('error',()=>finish(false))});req.setTimeout(1000,()=>req.destroy());req.on('error',()=>finish(false));req.write(header);req.end(f.pixels)});if(f.sequence%fps===0)log('ipc',{sequence:f.sequence,captureAvailableMs:f.at,ipcAckMs:performance.now()-start});if(reuse)pool.push(f.pixels);busy=false;void send()}
 log('capture-ready',{method,fps,width,height});
 setInterval(()=>log('capture-stats',{count,replacements,sent,failed,rss:process.memoryUsage().rss,gcMs,eventLoopP95Ms:delay.percentile(95)/1e6,eventLoopMaxMs:delay.max/1e6}),5000);
 // A fixed file command surface exists only inside the disposable container for local acceptance.
 setInterval(async()=>{if(closing)return;let command;try{command=(await readFile('/tmp/capture-command','utf8')).trim()}catch{return}if(command===lastCommand)return;lastCommand=command;const [id,action]=command.split(':');if(!/^\d+$/.test(id)||!['click','type','scroll','fixture','public','reload','back','forward','crash-capture','crash-browser','delete'].includes(action))return;const started=performance.now();try{if(action==='click')await page.getByRole('button',{name:'Change pixels'}).click();if(action==='type'){await page.getByRole('textbox',{name:'Text',exact:true}).click();await page.keyboard.insertText('typed')}if(action==='scroll'){await page.mouse.move(900,600);await page.mouse.wheel(0,400)}if(action==='fixture')await page.goto('https://example.com/capture-fixture');if(action==='public')await page.goto('https://example.com/');if(action==='reload')await page.reload();if(action==='back')await page.goBack();if(action==='forward')await page.goForward();if(action==='delete')void close();if(action==='crash-capture')capture.kill('SIGKILL');if(action==='crash-browser')await browser.browser().close();log('action-ack',{id,action,durationMs:performance.now()-started})}catch(e){log('action-fail',{id,action,message:e.message})}},50);
}catch(e){log('failure',{message:e.message});await close(1)}

