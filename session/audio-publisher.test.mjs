import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { validAudio, AUDIO_BYTES, AUDIO_HEADER } from './audio.mjs';

const native = vi.hoisted(() => ({ capture: vi.fn(), clear: vi.fn(), queuedDuration: 0, handler: undefined, order: [] }));
vi.mock('node:http', () => ({ createServer: handler => {
  native.handler=handler;
  return { once(){}, listen(_path, ready){ready();}, closeAllConnections(){}, close(){} };
} }));
vi.mock('node:fs/promises', () => ({ chmod: async()=>{}, unlink: async()=>{} }));
vi.mock('@livekit/rtc-node', () => ({
  AudioSource: class { get queuedDuration(){return native.queuedDuration;} captureFrame(frame){return native.capture(frame);} clearQueue(){native.clear();} async close(){} },
  AudioFrame: class {}, LocalAudioTrack: {createAudioTrack:()=>({async close(){native.order.push(['native-close']);}})},
  TrackPublishOptions: class {}, TrackSource: {SOURCE_SCREENSHARE_AUDIO:4},
}));
import { publishBrowserAudio } from './audio-publisher.mjs';
import { AudioDiagnostics } from './audio-diagnostics.mjs';
afterEach(()=>vi.useRealTimers());
it('preserves audio when the SDK queue estimate exceeds the configured queue size', async()=>{
  native.queuedDuration=60;native.clear.mockClear();native.capture.mockResolvedValue(undefined);
  const publisher=await publishBrowserAudio({localParticipant:{publishTrack:async()=>{}}},'epoch',vi.fn());
  const frame=Buffer.alloc(AUDIO_HEADER+AUDIO_BYTES);
  frame.write('PCM1');frame.writeUInt32LE(48000,4);frame.writeUInt16LE(2,8);frame.writeUInt16LE(480,10);
  frame.writeBigUInt64LE(1n,12);frame.writeDoubleLE(Date.now(),20);
  const req=Object.assign(new EventEmitter(),{method:'POST',url:'/audio',headers:{'content-length':frame.length},complete:true,destroy:vi.fn()});
  const res={writeHead:vi.fn().mockReturnThis(),end:vi.fn(),once:vi.fn(),destroy:vi.fn()};
  native.handler(req,res);req.emit('data',frame);req.emit('end');
  await vi.waitFor(()=>expect(res.writeHead).toHaveBeenCalledWith(204));
  expect(native.capture).toHaveBeenCalledTimes(1);expect(native.clear).not.toHaveBeenCalled();
  await publisher.close();native.queuedDuration=0;
});

it('permanent native stall closes admission before supervisor shutdown, including a late callback', async()=>{
  vi.useFakeTimers();
  let complete;
  native.capture.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
  const failure=vi.fn();
  const publisher=await publishBrowserAudio({localParticipant:{publishTrack:async()=>{}}}, 'epoch', failure);
  function send(sequence) {
    const frame=Buffer.alloc(AUDIO_HEADER+AUDIO_BYTES);
    frame.write('PCM1');frame.writeUInt32LE(48000,4);frame.writeUInt16LE(2,8);frame.writeUInt16LE(480,10);
    frame.writeBigUInt64LE(BigInt(sequence),12);frame.writeDoubleLE(Date.now(),20);
    expect(validAudio(frame,-1n)).toBe(true);
    const req=Object.assign(new EventEmitter(),{method:'POST',url:'/audio',headers:{'content-length':frame.length},complete:true,destroy:vi.fn()});
    const res={writeHead:vi.fn().mockReturnThis(),end:vi.fn(),once:vi.fn(),destroy:vi.fn()};
    native.handler(req,res);req.emit('data',frame);req.emit('end');return res;
  }
  send(1); await vi.advanceTimersByTimeAsync(2001);
  expect(failure.mock.calls[0][0].message).toBe('AUDIO_SUBMIT_TIMEOUT');
  expect(send(2).writeHead).toHaveBeenCalledWith(400);
  complete();await vi.advanceTimersByTimeAsync(1);
  expect(send(3).writeHead).toHaveBeenCalledWith(400);
  expect(native.capture).toHaveBeenCalledTimes(1);
  await publisher.close();
});

it('correlates publisher stages by frame ID and opens a trace window on a FIFO sequence gap', async()=>{
  vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS','1');native.queuedDuration=0;native.capture.mockResolvedValue(undefined);
  const trace=vi.spyOn(AudioDiagnostics.prototype,'trace'),incident=vi.spyOn(AudioDiagnostics.prototype,'incident'),digest=vi.spyOn(AudioDiagnostics.prototype,'digest'),recordPcm=vi.spyOn(AudioDiagnostics.prototype,'recordPcm'),write=vi.spyOn(AudioDiagnostics.prototype,'write').mockResolvedValue(undefined);
  const publisher=await publishBrowserAudio({localParticipant:{publishTrack:async()=>{}}},'epoch',vi.fn());
  async function send(sequence) {
    const frame=Buffer.alloc(AUDIO_HEADER+AUDIO_BYTES);frame.write('PCM1');frame.writeUInt32LE(48000,4);frame.writeUInt16LE(2,8);frame.writeUInt16LE(480,10);frame.writeBigUInt64LE(BigInt(sequence),12);frame.writeDoubleLE(Date.now(),20);
    const req=Object.assign(new EventEmitter(),{method:'POST',url:'/audio',headers:{'content-length':frame.length},complete:true,destroy:vi.fn()});
    const res=Object.assign(new EventEmitter(),{writeHead:vi.fn().mockReturnThis(),end(){queueMicrotask(()=>this.emit('finish'));},destroy:vi.fn()});
    native.handler(req,res);req.emit('data',frame);req.emit('end');await vi.waitFor(()=>expect(res.writeHead).toHaveBeenCalledWith(204));await new Promise(resolve=>setImmediate(resolve));
  }
  await send(1);await send(3);
  expect(incident).toHaveBeenCalledWith('worker-frame-sequence-gap',expect.objectContaining({firstMissingFrameSequenceId:'2',lastMissingFrameSequenceId:'2'}));
  const stages=trace.mock.calls.map(([kind,fields])=>[kind,fields.frameSequenceId]);
  for(const stage of ['publisher-request-received','publisher-captureFrame-start','publisher-native-completion','publisher-http-ack-sent'])expect(stages).toContainEqual([stage,'1']);
  expect(stages).toContainEqual(['publisher-native-completion','3']);
  expect(digest).toHaveBeenCalledWith('requestReceived','1',expect.any(String));expect(digest).toHaveBeenCalledWith('accepted','3',expect.any(String));
  expect(recordPcm).toHaveBeenCalledWith('publisher-accepted','1',0,expect.any(Buffer),expect.any(String));
  await publisher.close();trace.mockRestore();incident.mockRestore();digest.mockRestore();recordPcm.mockRestore();write.mockRestore();vi.unstubAllEnvs();
});

it('flushes final Publisher diagnostics before native track teardown and retains the close reason', async()=>{
  vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS','1');
  native.order=[];
  const write=vi.spyOn(AudioDiagnostics.prototype,'write').mockImplementation(async(extra)=>{native.order.push(['flush',extra]);});
  const publisher=await publishBrowserAudio({localParticipant:{publishTrack:async()=>{}}},'epoch',vi.fn());
  await publisher.close('livekit-disconnected');
  expect(native.order[0]).toMatchObject(['flush',{closeReason:'livekit-disconnected'}]);
  expect(native.order[1][0]).toBe('native-close');
  write.mockRestore();vi.unstubAllEnvs();
});
