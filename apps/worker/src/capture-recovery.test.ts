import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserSession } from '@browser/protocol';
const harness=vi.hoisted(()=>({ children: [] as any[], spawnArgs:[] as string[][], frames: [] as Buffer[], audioStarts:0 }));
vi.mock('node:fs/promises',()=>({mkdtemp:async()=>'/tmp/test-surface',rm:async()=>{}}));
vi.mock('./diagnostics.js',()=>({progress:()=>{}}));
vi.mock('node:timers/promises',()=>({setTimeout:async()=>{}}));
vi.mock('./audioCapture.js',()=>({BrowserAudioCapture:class {async start(){harness.audioStarts++;} startCapture(){} async close(){}}}));
vi.mock('node:child_process',()=>({
  execFileSync:vi.fn(),
  execFile:(_file:unknown,_args:unknown,_options:unknown,done:any)=>done(null,'',''),
  spawn:(_file:string,args:string[])=>{
    harness.spawnArgs.push(args);
    const child=Object.assign(new EventEmitter(),{stdout:new EventEmitter(),exitCode:null as number|null,signalCode:null as string|null,kill(this:EventEmitter & {signalCode:string|null},signal:string){this.signalCode=signal;this.emit('exit',null,signal);}});
    harness.children.push(child);return child;
  },
}));
vi.mock('node:http',()=>({request:(_options:unknown,receive:any)=>{
  const response=Object.assign(new EventEmitter(),{statusCode:204,resume(){}});
  const req=Object.assign(new EventEmitter(),{setTimeout(){},write(){},end(frame:Buffer){harness.frames.push(frame);receive(response);response.emit('end');},destroy(this:EventEmitter){this.emit('error',Error('destroyed'));}});
  return req;
}}));
import { Surface } from './surface.js';
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});

it.each(['1','0'])('audio=%s capture restart retains its session, rejects old generation data, and stop prevents late callbacks',async audio=>{
  vi.stubEnv('BROWSER_AUDIO',audio);
  vi.useFakeTimers();harness.children=[];harness.frames=[];harness.audioStarts=0;
  const failed=vi.fn(), session={sessionId:'session-one',media:{epoch:'epoch-one'}} as BrowserSession;
  const surface=new Surface(session,failed);
  await surface.start();surface.startCapture();
  expect(harness.audioStarts).toBe(audio==='0'?0:1);
  const old=harness.children[1];old.exitCode=1;old.emit('exit',1,null);
  await vi.advanceTimersByTimeAsync(300);
  expect(harness.children).toHaveLength(3);
  const frame=Buffer.alloc(1280*720*4);
  old.stdout.emit('data',frame);
  expect(harness.frames).toHaveLength(0);
  harness.children[2].stdout.emit('data',frame);
  await vi.advanceTimersByTimeAsync(1);
  expect(harness.frames).toHaveLength(1);
  expect(session.media!.epoch).toBe('epoch-one');expect(failed).not.toHaveBeenCalled();
  await surface.close();
  harness.children[2].stdout.emit('data',frame);
  expect(harness.frames).toHaveLength(1);expect(failed).not.toHaveBeenCalled();
});

it.each([
  ['720p30', 1280, 720], ['720p60', 1280, 720], ['1080p30', 1920, 1080], ['1080p60', 1920, 1080],
] as const)('captures and frames the %s profile at its configured dimensions',async(profile,width,height)=>{
  vi.stubEnv('BROWSER_MEDIA_PROFILE',profile);vi.stubEnv('BROWSER_AUDIO','0');harness.children=[];harness.spawnArgs=[];harness.frames=[];
  const surface=new Surface({sessionId:'profile-session',media:{epoch:'profile-epoch'}} as BrowserSession,vi.fn());
  await surface.start();surface.startCapture();
  expect(harness.spawnArgs[0]).toContain('1921x1081x24');
  expect(harness.spawnArgs[1]).toContain('1920x1080');
  expect(harness.spawnArgs[1].some(arg=>arg.startsWith(`scale=${width}:${height}`))).toBe(true);
  harness.children[1].stdout.emit('data',Buffer.alloc(width*height*4));
  expect(harness.frames[0]).toHaveLength(width*height*4);
  await surface.close();
});
