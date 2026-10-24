import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {mkdir,writeFile,chmod} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import {request,type ClientRequest} from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';
import {AudioMetrics} from './audioMetrics.js';

export class BrowserAudioCapture {
  private daemon?:ChildProcess;
  private capture?:ChildProcess;
  private stopped=false;
  private generation=0;
  private sequence=0n;private sampleOffset=0;
  private pending:{pcm:Buffer;atWall:number;availableAt:number;assembledAt:number;enqueuedAt:number;sequence:bigint;sampleStart:number;hash:string}[]=[];
  private busy=false;
  private inFlight?:ClientRequest;
  private partial=Buffer.alloc(1920);
  private offset=0;
  private lastInput=0;
  private timer?:ReturnType<typeof setInterval>;
  private recovering=false;private recoveries=0;private sending?:Promise<void>;private closing?:Promise<void>;
  private received=0;private dropped=0;private nonzero=0;private ack=0;private inFlightRequests=0;
  private diagnostics:AudioMetrics;private lastChunkAt=0;private sampleByteRemainder=0;private lastAckMono=0;
  private httpSockets=new WeakSet<object>();
  constructor(private epoch:string,private env:NodeJS.ProcessEnv,private fail:(reason:string)=>void){this.diagnostics=new AudioMetrics(epoch);}
  async start(profile:string) {
    const dir=profile+'/pulse';await mkdir(dir,{mode:0o700,recursive:true});
    const cookie=dir+'/cookie';await writeFile(cookie,randomBytes(256),{mode:0o600});
    this.env.PULSE_SERVER='unix:'+dir+'/native';this.env.PULSE_SINK='browser';this.env.PULSE_COOKIE=cookie;
    this.env.PULSE_RUNTIME_PATH=dir;
    const config=dir+'/daemon.pa';
    await writeFile(config,`load-module module-native-protocol-unix socket=${dir}/native auth-anonymous=false auth-cookie=${cookie}\nload-module module-null-sink sink_name=browser rate=48000 channels=2\nset-default-sink browser\nset-default-source browser.monitor\n`,{mode:0o600});
    this.daemon=spawn('pulseaudio',['-n','--daemonize=no','--exit-idle-time=-1','--use-pid-file=no','--disable-shm=true','--file='+config],{env:this.env,stdio:['ignore','ignore','inherit']});
    this.daemon.on('error',()=>{if(!this.stopped)this.fail('audio-server-error');});
    this.daemon.on('exit',()=>{if(!this.stopped)this.fail('audio-server-exit');});
    for(let i=0;i<40;i++) {
      if(this.daemon.exitCode!==null)throw Error('AUDIO_SERVER_FAILED');
      try {execFileSync('pactl',['info'],{env:this.env,stdio:'ignore',timeout:500});await chmod(dir+'/native',0o600);return;}catch{await sleep(100);}
    }
    throw Error('AUDIO_SERVER_TIMEOUT');
  }
  startCapture() {
    this.launchCapture();
    this.timer=setInterval(()=>{
      const gap=performance.now()-this.lastInput;
      console.log(JSON.stringify({kind:'audio-capture-progress',at:Date.now(),epoch:this.epoch,received:this.received,nonzero:this.nonzero,dropped:this.dropped,pending:this.pending.length,lastAckAgeMs:this.ack?Date.now()-this.ack:null,inputGapMs:gap,recoveries:this.recoveries}));
      if(gap>2000)void this.recover('audio-input-stalled');
    },1000);
  }
  private launchCapture() {
    this.offset=0;this.sampleByteRemainder=0;this.partial=Buffer.alloc(1920);this.pending=[];
    const generation=++this.generation;this.lastInput=performance.now();
    const child=this.capture=spawn('ffmpeg',['-hide_banner','-loglevel','error','-threads','1','-probesize','32','-analyzeduration','0','-f','pulse','-sample_rate','48000','-channels','2','-fragment_size','1920','-i','browser.monitor','-ac','2','-ar','48000','-f','s16le','pipe:1'],{env:this.env,stdio:['ignore','pipe','inherit']});
    child.on('error',()=>{if(!this.stopped && generation===this.generation)void this.recover('audio-capture-error');});
    child.on('exit',()=>{if(!this.stopped && generation===this.generation)void this.recover('audio-capture-exit');});
    child.stdout!.on('data',(chunk:Buffer)=>{
      if(this.stopped || generation!==this.generation)return;
      const chunkAt=performance.now(),sampleBytes=this.sampleByteRemainder+chunk.length;let burstFrames=0;this.diagnostics.add('pcm.inputChunks');this.diagnostics.add('pcm.totalBytes',chunk.length);this.diagnostics.add('pcm.completeSampleFrames',Math.floor(sampleBytes/4));this.sampleByteRemainder=sampleBytes%4;this.diagnostics.record('pcm.chunkBytes',chunk.length);this.diagnostics.record('pcm.chunkDurationMs',this.diagnostics.durationMs(chunk.length));if(this.lastChunkAt)this.diagnostics.record('pcm.chunkArrivalIntervalMs',chunkAt-this.lastChunkAt);this.lastChunkAt=chunkAt;this.diagnostics.trace('ffmpeg-pcm-available',{availableAtMonoMs:chunkAt,bytes:chunk.length,pcmDurationMs:this.diagnostics.durationMs(chunk.length)});
      for(let pos=0;pos<chunk.length;) {
        const n=Math.min(1920-this.offset,chunk.length-pos);chunk.copy(this.partial,this.offset,pos,pos+n);this.offset+=n;pos+=n;
        if(this.offset===1920) {
          const assembledAt=performance.now(),sequence=++this.sequence,sampleStart=this.sampleOffset,hash=createHash('sha256').update(this.partial).digest('hex');this.sampleOffset+=480;this.lastInput=assembledAt;this.received++;burstFrames++;
          this.diagnostics.add('assembly.completeFrames');this.diagnostics.record('assembly.frameSamplesPerChannel',480);this.diagnostics.record('assembly.frameDurationMs',10);
          const frameId=String(sequence),range={sampleStart,sampleEnd:sampleStart+480};this.diagnostics.digest('assembled',frameId,hash);this.diagnostics.recordPcm('worker-assembled',frameId,sampleStart,this.partial,hash);this.diagnostics.trace('worker-frame-assembled',{frameSequenceId:frameId,...range,pcmSha256:hash,assembledAtMonoMs:assembledAt,availableAtMonoMs:chunkAt});
          if(this.partial.some(v=>v!==0)){this.nonzero++;this.diagnostics.add('capture.nonzeroFrames');}
          if(this.pending.length===12){const discarded=this.pending.shift()!;this.dropped++;this.diagnostics.add('capture.droppedQueueOverflow');this.diagnostics.trace('worker-fifo-drop',{frameSequenceId:String(discarded.sequence),sampleStart:discarded.sampleStart,sampleEnd:discarded.sampleStart+480,reason:'overflow-oldest'});this.diagnostics.incident('fifo-overflow',{droppedFrameSequenceId:String(discarded.sequence),droppedSampleStart:discarded.sampleStart,droppedSampleEnd:discarded.sampleStart+480,incomingFrameSequenceId:frameId,pendingCapacityFrames:12});this.diagnostics.event('capture-queue-overflow-drop-oldest',{frameSequenceId:String(discarded.sequence),pendingCapacityFrames:12,dropped:this.dropped});}
          const frame={pcm:this.partial,atWall:Date.now(),assembledAt,availableAt:chunkAt,enqueuedAt:performance.now(),sequence,sampleStart,hash};this.pending.push(frame);this.diagnostics.trace('worker-fifo-enqueue',{frameSequenceId:frameId,...range,pendingFrames:this.pending.length});this.diagnostics.record('capture.pendingFrames',this.pending.length);this.partial=Buffer.allocUnsafe(1920);this.offset=0;void this.send();
        }
      }
      this.diagnostics.record('pcm.stdoutBurstFrames',burstFrames);this.diagnostics.record('assembly.accumulatorBytes',this.offset);this.diagnostics.record('assembly.accumulatorCompleteSamplesPerChannel',Math.floor(this.offset/4));
    });
  }
  private async recover(reason:string) {
    if(this.stopped || this.recovering)return;this.recovering=true;
    try {
      ++this.generation;if(this.offset){this.diagnostics.add('assembly.partialBytesDiscarded',this.offset);this.diagnostics.event('capture-partial-bytes-discarded',{bytes:this.offset});}if(this.sampleByteRemainder){this.diagnostics.add('pcm.discardedSampleByteRemainder',this.sampleByteRemainder);this.sampleByteRemainder=0;}if(this.pending.length){this.diagnostics.add('capture.recoveryFramesDiscarded',this.pending.length);this.dropped+=this.pending.length;for(const frame of this.pending){const frameId=String(frame.sequence),sampleEnd=frame.sampleStart+480;this.diagnostics.trace('worker-recovery-fifo-drop',{frameSequenceId:frameId,sampleStart:frame.sampleStart,sampleEnd});this.diagnostics.event('capture-recovery-queue-frame-discarded',{frameSequenceId:frameId,sampleStart:frame.sampleStart,sampleEnd});}}this.pending=[];this.inFlight?.destroy();
      this.diagnostics.event('capture-recovery',{generation:this.generation,reason,attempt:this.recoveries+1});console.log(JSON.stringify({kind:'audio-capture-recovery',at:Date.now(),monoMs:performance.now(),pid:process.pid,epoch:this.epoch,generation:this.generation,reason,attempt:this.recoveries+1}));
      if(this.recoveries>=3){this.fail('audio-recovery-exhausted');return;}
      const child=this.capture;
      if(child && child.exitCode===null && child.signalCode===null)await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),1500);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
      await sleep(250*2**this.recoveries++);if(!this.stopped)this.launchCapture();
    } finally {this.recovering=false;}
  }
  private send() {
    if(this.stopped || this.busy)return;
    this.busy=true;
    const task=(async()=>{try {
      while(!this.stopped && this.pending.length) {
        const batch=this.pending.splice(0,Math.min(1,this.pending.length));const frames:typeof batch=[];
        for(const frame of batch) {
          const dequeueAt=performance.now(),frameAgeMs=dequeueAt-frame.assembledAt,enqueueToDequeueMs=dequeueAt-frame.enqueuedAt,frameId=String(frame.sequence),sampleEnd=frame.sampleStart+480;
          this.diagnostics.digest('dequeued',frameId,frame.hash);this.diagnostics.recordPcm('worker-dequeued',frameId,frame.sampleStart,frame.pcm,frame.hash);this.diagnostics.record('capture.enqueueToDequeueMs',enqueueToDequeueMs);this.diagnostics.record('capture.frameAgeMs',frameAgeMs);this.diagnostics.record('capture.ffmpegAvailableToDequeueMs',dequeueAt-frame.availableAt);this.diagnostics.record('capture.fifoOccupancyAtDequeue',this.pending.length);this.diagnostics.trace('worker-fifo-dequeue',{frameSequenceId:frameId,sampleStart:frame.sampleStart,sampleEnd,enqueueToDequeueMs,frameAgeMs,ffmpegAvailableToDequeueMs:dequeueAt-frame.availableAt,pendingFrames:this.pending.length,batchFrameCount:batch.length});
          if(frameAgeMs>150){this.dropped++;this.diagnostics.add('capture.droppedStale');this.diagnostics.trace('worker-stale-drop',{frameSequenceId:frameId,sampleStart:frame.sampleStart,sampleEnd,frameAgeMs});this.diagnostics.event('capture-stale-frame-drop',{frameSequenceId:frameId,sampleStart:frame.sampleStart,sampleEnd,ageMs:frameAgeMs,dropped:this.dropped});continue;}
          if(createHash('sha256').update(frame.pcm).digest('hex')!==frame.hash){this.diagnostics.add('capture.frameChecksumMismatch');this.diagnostics.trace('worker-frame-checksum-mismatch',{frameSequenceId:frameId,sampleStart:frame.sampleStart,sampleEnd});}
          frames.push(frame);
        }
        if(!frames.length)continue;
        const recordBytes=28+1920,batchId=`${frames[0].sequence}-${frames.at(-1)!.sequence}`,body=Buffer.allocUnsafe(recordBytes*frames.length);
        for(let i=0;i<frames.length;i++) {
          const frame=frames[i],frameId=String(frame.sequence),sampleEnd=frame.sampleStart+480,offset=i*recordBytes,header=body.subarray(offset,offset+28);
          header.write('PCM1');header.writeUInt32LE(48000,4);header.writeUInt16LE(2,8);header.writeUInt16LE(480,10);header.writeBigUInt64LE(frame.sequence,12);header.writeDoubleLE(frame.atWall,20);frame.pcm.copy(body,offset+28);
          this.diagnostics.digest('httpRequestStarted',frameId,frame.hash);this.diagnostics.trace('worker-http-request-start',{frameSequenceId:frameId,sampleStart:frame.sampleStart,sampleEnd,pcmSha256:frame.hash,batchId,batchFrameCount:frames.length});
        }
        this.diagnostics.record('capture.batchFrameCount',frames.length);
        await new Promise<void>(resolve=>{
          let settled=false;const fail=(eventKind:string,traceKind:string)=>{if(settled)return;settled=true;this.dropped+=frames.length;this.diagnostics.add('capture.droppedIpcError',frames.length);for(const frame of frames){const frameId=String(frame.sequence);this.diagnostics.trace(traceKind,{frameSequenceId:frameId,batchId});this.diagnostics.event(eventKind,{frameSequenceId:frameId,batchId,dropped:this.dropped});}resolve();};
          const start=performance.now();this.inFlightRequests++;this.diagnostics.record('capture.inFlightRequests',this.inFlightRequests);this.diagnostics.record('capture.inFlightAudioFrames',frames.length);
          const req=request({socketPath:`/frames/${this.epoch}.audio.sock`,path:'/audio',method:'POST',headers:{'content-length':body.length}},res=>{res.resume();res.on('end',()=>{if(settled)return;settled=true;const now=performance.now();this.diagnostics.record('capture.ipcAckDurationMs',now-start);if(this.lastAckMono)this.diagnostics.record('capture.ackIntervalMs',now-this.lastAckMono);this.lastAckMono=now;if(res.statusCode===204){this.ack=Date.now();for(const frame of frames){const frameId=String(frame.sequence);this.diagnostics.digest('httpAckReceived',frameId,frame.hash);this.diagnostics.trace('worker-http-ack-received',{frameSequenceId:frameId,batchId,batchFrameCount:frames.length,statusCode:204,roundTripMs:now-start});}}else {this.dropped+=frames.length;this.diagnostics.add('capture.droppedIpcRejected',frames.length);for(const frame of frames){const frameId=String(frame.sequence);this.diagnostics.trace('worker-http-ack-received',{frameSequenceId:frameId,batchId,batchFrameCount:frames.length,statusCode:res.statusCode,roundTripMs:now-start});this.diagnostics.event('capture-ipc-rejected',{frameSequenceId:frameId,batchId,statusCode:res.statusCode,dropped:this.dropped});}}resolve();});res.on('error',()=>fail('capture-ipc-response-error','worker-http-response-error'));});
          this.inFlight=req;req.on('socket',socket=>{const reused=this.httpSockets.has(socket);this.httpSockets.add(socket);this.diagnostics.add(reused?'ipc.reusedSocketRequests':'ipc.uniqueSockets');for(const frame of frames)this.diagnostics.trace('worker-http-socket-assigned',{frameSequenceId:String(frame.sequence),batchId,reusedSocket:reused});});req.setTimeout(200,()=>req.destroy());req.on('error',()=>fail('capture-ipc-error','worker-http-error'));req.end(body);
        });
        this.inFlightRequests=Math.max(0,this.inFlightRequests-1);this.diagnostics.record('capture.inFlightRequests',this.inFlightRequests);
        this.diagnostics.record('capture.inFlightAudioFrames',0);
      }
    } finally {this.inFlight=undefined;this.busy=false;}})();
    this.sending=task;void task.then(()=>{if(this.sending===task)this.sending=undefined;},()=>{if(this.sending===task)this.sending=undefined;});return task;
  }
  close() {if(this.closing)return this.closing;this.closing=this.closeOnce();return this.closing;}
  private async closeOnce() {
    this.stopped=true;++this.generation;clearInterval(this.timer);if(this.offset){this.diagnostics.add('assembly.partialBytesDiscarded',this.offset);this.diagnostics.event('capture-partial-bytes-discarded',{bytes:this.offset});}if(this.sampleByteRemainder)this.diagnostics.add('pcm.discardedSampleByteRemainder',this.sampleByteRemainder);if(this.pending.length){this.diagnostics.add('capture.shutdownFramesDiscarded',this.pending.length);this.dropped+=this.pending.length;for(const frame of this.pending){const frameId=String(frame.sequence),sampleEnd=frame.sampleStart+480;this.diagnostics.trace('worker-shutdown-fifo-drop',{frameSequenceId:frameId,sampleStart:frame.sampleStart,sampleEnd});this.diagnostics.event('capture-shutdown-queue-frame-discarded',{frameSequenceId:frameId,sampleStart:frame.sampleStart,sampleEnd});}}this.pending=[];this.inFlight?.destroy();
    await this.sending?.catch(()=>{});
    for(const child of [this.capture,this.daemon]) {
      if(!child || child.exitCode!==null || child.signalCode!==null)continue;
      await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),1500);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');});
    }
    await this.diagnostics.write('capture',{queueOverflow:'Oldest complete frame discarded when pending already contained 12 frames',staleFrame:'Complete frame discarded when monotonic assembled-to-dequeue age exceeds 150 ms',partialSamples:'Bytes left in a non-full 1920-byte assembly buffer at capture stop/restart are discarded',sampleRanges:'Worker ranges are 480 samples per channel and sequence IDs are assigned at assembly; frame age is Worker-local assembly-to-dequeue time, not source capture time',underrun:'Not inferred at capture; publisher legacy counter increments when consecutive received audio frames are separated by >30 ms'});
  }
}
