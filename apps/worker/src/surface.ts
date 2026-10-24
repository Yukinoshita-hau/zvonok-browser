import { request } from 'node:http';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrowserSession } from '@browser/protocol';
import { BrowserAudioCapture } from './audioCapture.js';
import { resolveMediaProfile } from './mediaProfile.js';
import { progress } from './diagnostics.js';
const run = promisify(execFile);
export async function displayReady(env: NodeJS.ProcessEnv, attempts = 1) {
  for (let attempt = 0; ; attempt++) {
    try { await run('xdpyinfo', [], { env, timeout: 500 }); return; }
    catch (error) { if (attempt + 1 >= attempts) throw error; await sleep(100 * 2 ** attempt); }
  }
}

export const live = process.env.BROWSER_LIVE === '1';
export function binding(path: string, body: unknown): Promise<{ state: 'starting' | 'streaming' | 'media_reconnecting' }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: process.env.BROWSER_BINDING_SOCKET ?? '/binding/broker.sock', path, method: 'POST', headers: {'content-type':'application/json'} }, res => {
      let bytes = '';
      res.on('data', p => { bytes += p; if (bytes.length > 4096) req.destroy(Error('BINDING_OVERSIZE')); });
      res.on('error', reject);
      res.on('end', () => { try { if (res.statusCode !== 200) throw Error('MEDIA_BINDING_REJECTED'); resolve(JSON.parse(bytes)); } catch(e) { reject(e); } });
    });
    req.setTimeout(2000, () => req.destroy(Error('BINDING_TIMEOUT')));
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}
export class Surface {
  profile = '';
  private mediaProfile: ReturnType<typeof resolveMediaProfile>;
  env: NodeJS.ProcessEnv = {};
  private xvfb?: ChildProcess;
  private capture?: ChildProcess;
  private audio?: BrowserAudioCapture;
  private stopped = false;
  private latest?: Buffer;
  private latestAt=0;
  private generation=0;
  private recovering=false;
  private recoveries=0;
  private capturedBytes=0;
  private lastByte=0;
  private lastAck=0;
  private lastTick=performance.now();
  private inFlight?: ReturnType<typeof request>;
  private busy = false;
  private sequence = 0;
  private lastFrame = performance.now();
  private watchdog?: ReturnType<typeof setInterval>;
  private bytes?: Buffer;
  private offset = 0;
  private edges: number[][] = [];
  async verifyEdges() {
    const expected=[[255,128,0],[0,128,255],[255,0,255],[0,255,255],[255,0,0],[0,255,0],[0,0,255],[255,255,0]];
    for(let i=0;i<20;i++) {
      if(JSON.stringify(this.edges)===JSON.stringify(expected)) {
        console.log(JSON.stringify({kind:'session-raw-edges-pass',sessionId:this.session.sessionId,points:8}));return;
      }
      await sleep(100);
    }
    console.log(JSON.stringify({kind:'session-raw-edges-failed',sessionId:this.session.sessionId,observed:this.edges}));
    throw Error('RAW_EDGE_MISMATCH');
  }
  private captured = 0;
  private replaced = 0;
  constructor(private session: BrowserSession, private failed: (reason:string) => void) { this.mediaProfile=resolveMediaProfile(session.media?.profile); }
  async start() {
    progress('surface-start', { sessionId: this.session.sessionId });
    this.profile = await mkdtemp('/tmp/session-profile-');
    const display=process.env.BROWSER_DISPLAY ?? ':91';
    if(!/^:[0-9]{1,3}$/.test(display))throw Error('INVALID_DISPLAY');
    this.env = { ...process.env, DISPLAY: display, XAUTHORITY: this.profile + '/Xauthority', XDG_CONFIG_HOME: this.profile+'/config', XDG_CACHE_HOME: this.profile+'/cache' };
    if(process.env.BROWSER_AUDIO!=='0') {
      this.audio=new BrowserAudioCapture(this.session.media!.epoch,this.env,this.failed);
      await this.audio.start(this.profile);
      progress('pulse-ready', { sessionId: this.session.sessionId });
    } else progress('audio-disabled', {sessionId:this.session.sessionId});
    execFileSync('xauth', ['-f', this.env.XAUTHORITY!, 'add', display, '.', randomBytes(16).toString('hex')]);
    this.xvfb = spawn('Xvfb', [display,'-auth',this.env.XAUTHORITY!,'-screen','0','1921x1081x24','-nolisten','tcp'], {env:this.env, stdio:'ignore'});
    this.watch(this.xvfb);
    for(let i=0;i<40;i++) {
      if(this.stopped || this.xvfb.exitCode !== null) throw Error('DISPLAY_FAILED');
      try { await displayReady(this.env); progress('xvfb-ready', { sessionId: this.session.sessionId, childPid: this.xvfb.pid }); return; } catch { await sleep(100); }
    }
    throw Error('DISPLAY_TIMEOUT');
  }
  private watch(child: ChildProcess) {
    child.on('error', () => { if(!this.stopped) this.failed("child-exit"); });
    child.on('exit', () => { if(!this.stopped) this.failed("child-exit"); });
  }
  startCapture() {
    this.stopped=false;
    this.lastTick=performance.now();
    this.audio?.startCapture();
    this.startVideo();
    this.watchdog=setInterval(()=>{
      const now=performance.now(),gap=now-this.lastFrame,loopGap=now-this.lastTick;this.lastTick=now;
      console.log(JSON.stringify({kind:'capture-progress',at:Date.now(),sessionId:this.session.sessionId,epoch:this.session.media?.epoch,profile:this.mediaProfile.name,targetFps:this.mediaProfile.fps,generation:this.generation,captured:this.captured,replaced:this.replaced,capturedBytes:this.capturedBytes,frameGapMs:gap,byteGapMs:this.lastByte?now-this.lastByte:null,ipcAckGapMs:this.lastAck?now-this.lastAck:null,eventLoopIntervalMs:loopGap,captureAlive:this.capture?.exitCode===null,xAlive:this.xvfb?.exitCode===null,rss:process.memoryUsage().rss,recoveries:this.recoveries}));
      if(gap>2000)void this.recoverVideo('source-starvation');
    },500);
  }
  private startVideo() {
    const generation=++this.generation;
    this.offset=0;this.latest=undefined;
    this.lastFrame=performance.now();
    const { width, height, fps } = this.mediaProfile;
    const size = width*height*4;
    this.bytes = Buffer.allocUnsafe(size);
    this.capture = spawn('ffmpeg', ['-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-f','x11grab','-draw_mouse','0','-framerate',String(fps),'-video_size','1920x1080','-i',`${this.env.DISPLAY}.0+0,0`,'-vf',`scale=${width}:${height}:flags=fast_bilinear`,'-an','-threads','1','-pix_fmt','rgba','-f','rawvideo','pipe:1'], {env:this.env,stdio:['ignore','pipe','inherit']});
    this.capture.on('error',()=>{if(!this.stopped && generation===this.generation)void this.recoverVideo('capture-error');});
    this.capture.on('exit',(code,signal)=>{if(!this.stopped && generation===this.generation)void this.recoverVideo(`capture-exit:${code}:${signal}`);});
    this.capture.stdout!.on('data', (chunk: Buffer) => {
      if(this.stopped || generation!==this.generation) return;
      this.capturedBytes+=chunk.length;this.lastByte=performance.now();
      let pos=0;
      while(pos<chunk.length) {
        const n=Math.min(size-this.offset,chunk.length-pos);
        chunk.copy(this.bytes!,this.offset,pos,pos+n);this.offset+=n;pos+=n;
        if(this.offset===size) {
          this.edges=[[0,Math.floor(height/2)],[width-1,Math.floor(height/2)],[Math.floor(width/2),0],[Math.floor(width/2),height-1],[0,0],[width-1,0],[0,height-1],[width-1,height-1]].map(([x,y])=>[...this.bytes!.subarray((y*width+x)*4,(y*width+x)*4+3)]);
          this.lastFrame=performance.now(); this.captured++;
          if(this.latest) this.replaced++;
          this.latest=this.bytes;this.latestAt=Date.now(); this.bytes=Buffer.allocUnsafe(size);this.offset=0;
          void this.send();
        }
      }
    });
  }
  private async recoverVideo(reason:string) {
    if(this.stopped || this.recovering)return;
    this.recovering=true;
    try {
      const child=this.capture;
      ++this.generation;this.latest=undefined;this.inFlight?.destroy();
      console.log(JSON.stringify({kind:'capture-recovery',at:Date.now(),monoMs:performance.now(),pid:process.pid,sessionId:this.session.sessionId,epoch:this.session.media!.epoch,generation:this.generation,reason,attempt:this.recoveries+1,frameGapMs:performance.now()-this.lastFrame,byteGapMs:performance.now()-this.lastByte,capturedBytes:this.capturedBytes}));
      if(this.xvfb?.exitCode!==null)throw Error('display-process-exit');
      await displayReady(this.env,3);
      if(this.recoveries>=3)throw Error('capture-recovery-exhausted');
      await this.stopChild(child);
      await sleep(250*2**this.recoveries++);
      if(!this.stopped)this.startVideo();
    } catch(e) {if(!this.stopped)this.failed(e instanceof Error?e.message:'display-unhealthy');}
    finally {this.recovering=false;}
  }
  private async send() {
    if(this.busy || this.stopped || !this.latest) return;
    this.busy=true;
    const pixels=this.latest,at=this.latestAt;this.latest=undefined;
    if(Date.now()-at>1000){this.busy=false;return;}
    const header=Buffer.alloc(24);header.writeUInt32LE(this.mediaProfile.width);header.writeUInt32LE(this.mediaProfile.height,4);header.writeBigUInt64LE(BigInt(++this.sequence),8);header.writeDoubleLE(at,16);
    await new Promise<void>(resolve=>{
      let done=false;
      const finish=()=>{if(!done){done=true;resolve();}};
      const req=request({socketPath:`/frames/${this.session.media!.epoch}.sock`,path:'/frame',method:'POST',headers:{'content-length':pixels.length+24}},res=>{res.resume();res.on('end',()=>{if(res.statusCode===204)this.lastAck=performance.now();finish();});res.on('error',finish);});
      this.inFlight=req; req.setTimeout(1000,()=>req.destroy());req.on('error',finish);req.write(header);req.end(pixels);
    });
    this.inFlight=undefined;this.busy=false;
    if(this.sequence%150===0) console.log(JSON.stringify({kind:'session-capture',sessionId:this.session.sessionId,captured:this.captured,replaced:this.replaced}));
    void this.send();
  }
  async stopCapture() {
    this.stopped=true;++this.generation; clearInterval(this.watchdog);this.latest=undefined;this.bytes=undefined;this.inFlight?.destroy();
    await this.stopChild(this.capture);
    await this.audio?.close();
    this.audio=undefined;
  }
  async changeMedia(epoch: string, profile: string) {
    this.mediaProfile=resolveMediaProfile(profile);
    if(!this.session.media)throw Error('MEDIA_BINDING_MISSING');
    Object.assign(this.session.media,{epoch,room:`browser-${epoch}`,publisher:`publisher-${epoch}`,profile:this.mediaProfile.name,width:this.mediaProfile.width,height:this.mediaProfile.height,fps:this.mediaProfile.fps,state:'starting'});
    if(process.env.BROWSER_AUDIO!=='0') {
      this.audio=new BrowserAudioCapture(epoch,this.env,this.failed);
      await this.audio.start(this.profile);
    }
  }
  private async stopChild(child?: ChildProcess) {
    if(!child || child.exitCode!==null || child.signalCode!==null) return;
    await new Promise<void>(resolve=>{
      const timer=setTimeout(()=>child.kill('SIGKILL'),1500);
      child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');
    });
  }
  async close() {
    await this.stopCapture();await this.stopChild(this.xvfb);
    if(this.profile) await rm(this.profile,{recursive:true,force:true});
  }
}
