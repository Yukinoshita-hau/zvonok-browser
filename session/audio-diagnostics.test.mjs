import {afterEach,expect,it,vi} from 'vitest';
const fs=vi.hoisted(()=>({mkdir:vi.fn(),open:vi.fn(),rename:vi.fn(),unlink:vi.fn()}));
vi.mock('node:fs/promises',()=>fs);
import {AudioDiagnostics,intervalJitterMs} from './audio-diagnostics.mjs';

afterEach(()=>vi.unstubAllEnvs());
it('keeps publication diagnostics disabled by default',()=>{
  vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS','0');
  const diagnostics=new AudioDiagnostics('epoch','publisher');diagnostics.record('x',1);diagnostics.event('x');
  expect(diagnostics.metrics.size).toBe(0);expect(diagnostics.events).toHaveLength(0);expect(diagnostics.loop).toBeUndefined();
});
it('measures absolute call-interval jitter against the nominal 10 ms frame cadence',()=>{
  expect(intervalJitterMs(12)).toBe(2);expect(intervalJitterMs(8)).toBe(2);expect(intervalJitterMs(10)).toBe(0);
});
it('writes complete publisher JSON once across concurrent shutdown callers',async()=>{
  vi.clearAllMocks();vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS','1');let content='';
  const file={writeFile:vi.fn(async value=>{content=value;}),sync:vi.fn(),close:vi.fn()};fs.mkdir.mockResolvedValue(undefined);fs.open.mockResolvedValue(file);fs.rename.mockResolvedValue(undefined);
  const log=vi.spyOn(console,'log').mockImplementation(()=>{}),diagnostics=new AudioDiagnostics('epoch','publisher');diagnostics.add('publication.successfulFrames',2);
  const first=diagnostics.write({received:2}),second=diagnostics.write({received:2});expect(first).toBe(second);await first;
  expect(JSON.parse(content).metrics['publication.successfulFrames']).toBe(2);expect(file.sync).toHaveBeenCalledOnce();expect(fs.rename).toHaveBeenCalledOnce();expect(log.mock.calls[0][0]).toContain('audio-diagnostics-written');
  log.mockRestore();vi.unstubAllEnvs();
});
it('logs a safe publisher filesystem error and does not publish a partial JSON file',async()=>{
  vi.clearAllMocks();vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS','1');fs.mkdir.mockResolvedValue(undefined);fs.open.mockRejectedValue(Object.assign(Error('secret token path'),{code:'EACCES'}));fs.unlink.mockResolvedValue(undefined);
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});await new AudioDiagnostics('epoch','publisher').write();
  const event=JSON.parse(log.mock.calls[0][0]);expect(event).toMatchObject({kind:'audio-diagnostics-write-failed',code:'EACCES'});expect(event.message).toBeUndefined();expect(fs.rename).not.toHaveBeenCalled();log.mockRestore();vi.unstubAllEnvs();
});
