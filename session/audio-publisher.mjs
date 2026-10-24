import {createServer} from 'node:http';
import {submitAudio} from './audio-submit.mjs';
import {chmod,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {AudioSource,AudioFrame,LocalAudioTrack,TrackPublishOptions,TrackSource} from '@livekit/rtc-node';
import {validAudio,AUDIO_BYTES,AUDIO_HEADER} from './audio.mjs';
import {AudioDiagnostics,intervalJitterMs} from './audio-diagnostics.mjs';

export async function publishBrowserAudio(room,epoch,fail) {
  const source=new AudioSource(48000,2,50),track=LocalAudioTrack.createAudioTrack('browser-audio',source);
  const diagnostics=new AudioDiagnostics(epoch,'publisher');let lastFrameMono=0;
  await room.localParticipant.publishTrack(track,new TrackPublishOptions({source:TrackSource.SOURCE_SCREENSHARE_AUDIO,stream:'browser-session',dtx:false}));
  const socket=`/frames/${epoch}.audio.sock`;await unlink(socket).catch(e=>{if(e.code!=='ENOENT')throw e;});
  const recordBytes=AUDIO_HEADER+AUDIO_BYTES,maxBatchFrames=1;
  let sequence=-1n,closed=false,busy=false,lastInput=0,received=0,submitted=0,rejected=0,underruns=0,nonzero=0,maxQueueMs=0,closeTask,processing=Promise.resolve();
  const server=createServer((req,res)=>{
    req.on('error',()=>{});
    const contentLength=Number(req.headers['content-length']);
    if(closed || busy || req.method!=='POST' || req.url!=='/audio' || req.headers['transfer-encoding'] || contentLength<recordBytes || contentLength>recordBytes*maxBatchFrames || contentLength%recordBytes!==0){rejected++;diagnostics.add('publication.rejectedRequests');diagnostics.event('request-rejected',{reason:closed?'closed':busy?'busy':'invalid-request'});res.writeHead(400).end();req.destroy();return;}
    busy=true;const requestReceivedAt=performance.now(),parts=[];let size=0;
    req.on('close',()=>{if(!req.complete)busy=false;});
    req.on('data',p=>{size+=p.length;if(size>recordBytes*maxBatchFrames)req.destroy();else parts.push(p);});
    req.on('end',()=>{processing=(async()=>{
      const b=Buffer.concat(parts);
      const frames=[];let candidateSequence=sequence;
      for(let offset=0;offset<b.length;offset+=recordBytes){const frame=b.subarray(offset,offset+recordBytes);if(!validAudio(frame,candidateSequence)){rejected++;diagnostics.add('publication.rejectedFrames');diagnostics.event('frame-rejected',{reason:'invalid-or-nonmonotonic-sequence',batchIndex:frames.length});res.writeHead(400).end();return;}frames.push(frame);candidateSequence=frame.readBigUInt64LE(12);}
      const bodyCompleteAt=performance.now(),batchId=`${frames[0].readBigUInt64LE(12)}-${frames.at(-1).readBigUInt64LE(12)}`,completed=[];
      diagnostics.record('publication.requestBodyDurationMs',bodyCompleteAt-requestReceivedAt);diagnostics.record('publication.batchFrameCount',frames.length);
      if(lastInput){const interval=bodyCompleteAt-lastInput;diagnostics.record('pcm.inputIntervalMs',interval);if(interval>30){underruns++;diagnostics.add('health.interarrivalGapOver30ms');diagnostics.event('input-gap-over-30ms',{intervalMs:interval,batchId});}}lastInput=bodyCompleteAt;
      for(const frame of frames){
        const previousSequence=sequence;sequence=frame.readBigUInt64LE(12);received++;
        const frameId=String(sequence),sampleStart=Number((sequence-1n)*480n),sampleEnd=sampleStart+480,rawPcm=frame.subarray(AUDIO_HEADER),pcmSha256=createHash('sha256').update(rawPcm).digest('hex');
        diagnostics.digest('requestReceived',frameId,pcmSha256);diagnostics.trace('publisher-request-received',{frameSequenceId:frameId,sampleStart,sampleEnd,batchId,batchFrameCount:frames.length,requestReceivedMonoMs:requestReceivedAt,bodyCompleteMonoMs:bodyCompleteAt,pcmSha256,monoMs:requestReceivedAt});
        if(received>1 && sequence>previousSequence+1n){const firstMissing=previousSequence+1n,lastMissing=sequence-1n,missing=Number(lastMissing-firstMissing+1n);diagnostics.add('publication.workerMissingFrames',missing);diagnostics.incident('worker-frame-sequence-gap',{firstMissingFrameSequenceId:String(firstMissing),lastMissingFrameSequenceId:String(lastMissing),previousFrameSequenceId:String(previousSequence),nextFrameSequenceId:frameId,missingFrames:missing});}
        diagnostics.add('pcm.validFrames');diagnostics.add('pcm.bytes',AUDIO_BYTES);diagnostics.add('pcm.samplesPerChannel',480);diagnostics.record('pcm.chunkBytes',AUDIO_BYTES);diagnostics.record('pcm.chunkDurationMs',10);
        const queueBefore=Number(source.queuedDuration);diagnostics.record('audioSource.queuedDurationBeforeMs',queueBefore);
        const pcm=new Int16Array(960);for(let i=0;i<pcm.length;i++)pcm[i]=frame.readInt16LE(AUDIO_HEADER+i*2);
        if(pcm.some(v=>v!==0))nonzero++;
        const submitStart=performance.now();diagnostics.record('publication.requestReceivedToCaptureStartMs',submitStart-requestReceivedAt);diagnostics.trace('publisher-captureFrame-start',{frameSequenceId:frameId,sampleStart,sampleEnd,batchId,batchFrameCount:frames.length,pcmSha256,monoMs:submitStart});if(diagnostics.enabled){if(lastFrameMono){const interval=submitStart-lastFrameMono;diagnostics.record('pacing.captureFrameCallIntervalMs',interval);diagnostics.record('pacing.captureFrameIntervalJitterMs',intervalJitterMs(interval));}lastFrameMono=submitStart;diagnostics.record('pacing.publisherArrivalToCallMs',submitStart-bodyCompleteAt);}
        const accepted=await submitAudio(source,new AudioFrame(pcm,48000,2,480),()=>{
          diagnostics.add('publication.softTimeouts');diagnostics.event('captureFrame-soft-timeout',{sequence:frameId,batchId});
          console.log(JSON.stringify({kind:'audio-submit-stall',at:Date.now(),monoMs:performance.now(),pid:process.pid,epoch,sequence:frameId,submitMs:performance.now()-submitStart}));
          res.writeHead(503).end();diagnostics.trace('publisher-http-ack-sent',{frameSequenceId:frameId,batchId,statusCode:503,monoMs:performance.now()});
        });
        const nativeCompletedAt=performance.now();diagnostics.digest('nativeCompleted',frameId,pcmSha256);diagnostics.record('publication.captureFramePromiseMs',nativeCompletedAt-submitStart);diagnostics.record('audioSource.queuedDurationAfterMs',Number(source.queuedDuration));diagnostics.trace('publisher-native-completion',{frameSequenceId:frameId,sampleStart,sampleEnd,batchId,pcmSha256,accepted,nativeDurationMs:nativeCompletedAt-submitStart,queuedDurationMs:Number(source.queuedDuration),monoMs:nativeCompletedAt});if(!accepted){rejected++;diagnostics.add('publication.rejectedAfterTimeout');return;}
        submitted++;diagnostics.add('publication.successfulFrames');diagnostics.digest('accepted',frameId,pcmSha256);diagnostics.recordPcm('publisher-accepted',frameId,sampleStart,rawPcm,pcmSha256);maxQueueMs=Math.max(maxQueueMs,source.queuedDuration);completed.push({frameId,pcmSha256,nativeCompletedAt});
        if(submitted%100===0)console.log(JSON.stringify({kind:'audio-submit',at:Date.now(),pid:process.pid,epoch,received,submitted,rejected,underruns,nonzero,queueMs:source.queuedDuration,maxQueueMs,captureAvailableToSubmitMs:Date.now()-frame.readDoubleLE(20)}));
      }
      res.writeHead(204).end();const ackSentAt=performance.now();for(const frame of completed){diagnostics.digest('httpAckSent',frame.frameId,frame.pcmSha256);diagnostics.trace('publisher-http-ack-sent',{frameSequenceId:frame.frameId,batchId,batchFrameCount:frames.length,statusCode:204,captureCompleteToAckMs:ackSentAt-frame.nativeCompletedAt,monoMs:ackSentAt});}
    })().catch(e=>{diagnostics.add('publication.captureFrameErrors');diagnostics.event('captureFrame-error',{name:e instanceof Error?e.name:'Error',code:e&&typeof e==='object'&&typeof e.code==='string'?e.code:'UNKNOWN'});closed=true;res.destroy();fail(e);}).finally(()=>{if(!closed)busy=false;});});
  });
  server.maxConnections=1;server.requestTimeout=500;server.headersTimeout=500;server.timeout=500;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});await chmod(socket,0o600);
  return {
    fresh:()=>!!lastInput && performance.now()-lastInput<2000,
    close(reason='publisher-close'){if(closeTask)return closeTask;closeTask=(async()=>{closed=true;server.closeAllConnections();server.close();await processing.catch(()=>{});source.clearQueue();await diagnostics.write({received,submitted,rejected,underruns,nonzero,maxQueueMs,closeReason:reason,configuration:{audioSourceQueueSizeMs:50,maxBatchFrames}});let failure;try{await track.close();await source.close();}catch(error){failure=error;}finally{await unlink(socket).catch(()=>{});}if(failure)throw failure;})();return closeTask;},
  };
}
