import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { AudioMetrics } from './audioMetrics.js';

it('records stage PCM with exact source and recording sample ranges', async () => {
  vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS', '1'); vi.stubEnv('BROWSER_AUDIO_PCM_RECORDING', '1');
  const dir = await mkdtemp(join(tmpdir(), 'browser-audio-pcm-')), error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const first = Buffer.alloc(1920, 1), second = Buffer.alloc(1920, 2), metrics = new AudioMetrics('test-epoch', dir);
    metrics.recordPcm('worker-dequeued', '4', 1440, first, 'frame-4'); metrics.recordPcm('worker-dequeued', '6', 2400, second, 'frame-6');
    await metrics.write('capture', {});
    const raw = await readFile(join(dir, 'pcm-worker-dequeued-test-epoch-' + process.pid + '.s16le'));
    const rows = (await readFile(join(dir, 'pcm-worker-dequeued-test-epoch-' + process.pid + '.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(raw).toEqual(Buffer.concat([first, second]));
    expect(rows).toEqual([
      { frameSequenceId: '4', sourceSampleStart: 1440, sourceSampleEnd: 1920, recordingSampleStart: 0, recordingSampleEnd: 480, pcmSha256: 'frame-4' },
      { frameSequenceId: '6', sourceSampleStart: 2400, sourceSampleEnd: 2880, recordingSampleStart: 480, recordingSampleEnd: 960, pcmSha256: 'frame-6' },
    ]);
  } finally { error.mockRestore(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
});
