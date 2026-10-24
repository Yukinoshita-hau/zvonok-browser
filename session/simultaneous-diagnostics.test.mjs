import { expect, it, vi } from 'vitest';
const fs=vi.hoisted(()=>({mkdir:vi.fn(),open:vi.fn(),rename:vi.fn(),unlink:vi.fn()}));
vi.mock('node:fs/promises',()=>fs);
import { AudioMetrics } from '../apps/worker/src/audioMetrics.ts';
import { AudioDiagnostics } from './audio-diagnostics.mjs';

it('preserves both stage aggregates when Worker and Publisher flush together', async () => {
  vi.clearAllMocks();vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS','1');
  const writes=[];
  fs.mkdir.mockResolvedValue(undefined);
  fs.open.mockImplementation(async path=>({writeFile:async body=>writes.push([path,JSON.parse(body)]),sync:async()=>{},close:async()=>{}}));
  fs.rename.mockResolvedValue(undefined);
  const worker=new AudioMetrics('epoch'),publisher=new AudioDiagnostics('epoch','publisher');
  worker.add('capture.frames',7);publisher.add('publication.successfulFrames',9);
  await Promise.all([worker.write('capture',{}),publisher.write({})]);
  expect(writes).toHaveLength(2);
  expect(writes.map(([,json])=>json.stage).sort()).toEqual(['capture','publisher']);
  expect(writes.find(([,json])=>json.stage==='capture')[1].metrics['capture.frames']).toBe(7);
  expect(writes.find(([,json])=>json.stage==='publisher')[1].metrics['publication.successfulFrames']).toBe(9);
  expect(fs.rename).toHaveBeenCalledTimes(2);vi.unstubAllEnvs();
});
