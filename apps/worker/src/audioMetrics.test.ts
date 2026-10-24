import {afterEach,expect,it,vi} from 'vitest';
import {AudioMetrics,pcmDurationMs,summarizeSamples} from './audioMetrics.js';

afterEach(()=>{vi.unstubAllEnvs();});
it('converts PCM byte sizes to interleaved sample duration',()=>{
  expect(pcmDurationMs(1920)).toBe(10);
  expect(pcmDurationMs(3840)).toBe(20);
});
it('summarizes exact median and tail percentiles for a complete sample set',()=>{
  const values=Array.from({length:100},(_,i)=>i+1);
  expect(summarizeSamples({count:100,sum:5050,min:1,max:100,values,rng:1})).toMatchObject({p50:50,p95:95,p99:99,mean:50.5});
});
it('records monotonic call intervals and keeps only a bounded percentile reservoir',()=>{
  vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS','1');
  const metrics=new AudioMetrics('epoch');let prior=performance.now();
  for(let i=0;i<10000;i++){const now=performance.now();metrics.record('captureFrame.intervalMs',Math.max(0,now-prior));prior=now;}
  const samples=(metrics as unknown as {metrics:Map<string,{count:number;values:number[]}>}).metrics.get('captureFrame.intervalMs')!;
  expect(samples.count).toBe(10000);expect(samples.values.length).toBe(2048);
});
it('does not collect metrics or enable timing when diagnostics are disabled',()=>{
  vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS','0');
  const metrics=new AudioMetrics('epoch');metrics.record('x',1);metrics.add('y');metrics.event('e');
  expect((metrics as unknown as {metrics:Map<string,unknown>}).metrics.size).toBe(0);
  expect((metrics as unknown as {counters:Map<string,unknown>}).counters.size).toBe(0);
  expect((metrics as unknown as {histogram?:unknown}).histogram).toBeUndefined();
});
