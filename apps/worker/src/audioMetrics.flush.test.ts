import { expect, it, vi } from 'vitest';

const fs = vi.hoisted(() => ({ mkdir: vi.fn(), open: vi.fn(), rename: vi.fn(), unlink: vi.fn() }));
vi.mock('node:fs/promises', () => fs);
import { AudioMetrics } from './audioMetrics.js';

it('flushes once through a synced temporary file and atomically publishes complete worker JSON', async () => {
  vi.clearAllMocks();
  vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS', '1');
  let content = '';
  const file = { writeFile: vi.fn(async (value: string) => { content = value; }), sync: vi.fn(), close: vi.fn() };
  fs.mkdir.mockResolvedValue(undefined); fs.open.mockResolvedValue(file); fs.rename.mockResolvedValue(undefined);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const metrics = new AudioMetrics('test-epoch'); metrics.add('capture.frames', 2);
  const first = metrics.write('capture', {}), second = metrics.write('capture', {});
  expect(first).toBe(second); await first;
  expect(JSON.parse(content).metrics['capture.frames']).toBe(2);
  expect(file.sync).toHaveBeenCalledOnce(); expect(fs.rename).toHaveBeenCalledOnce(); expect(fs.open.mock.calls[0][1]).toBe('wx');
  expect(log.mock.calls[0][0]).toContain('audio-diagnostics-written');
  log.mockRestore(); vi.unstubAllEnvs();
});

it('reports a safe filesystem code and leaves no published partial file on write failure', async () => {
  vi.clearAllMocks();
  vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS', '1');
  fs.mkdir.mockResolvedValue(undefined); fs.open.mockRejectedValue(Object.assign(Error('secret path'), { code: 'EACCES' })); fs.unlink.mockResolvedValue(undefined);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await new AudioMetrics('test-epoch').write('capture', {});
  const entry = JSON.parse(log.mock.calls[0][0]);
  expect(entry).toMatchObject({ kind: 'audio-diagnostics-write-failed', code: 'EACCES' });
  expect(entry.message).toBeUndefined(); expect(fs.rename).not.toHaveBeenCalled();
  log.mockRestore(); vi.unstubAllEnvs();
});

it('keeps a 200 ms before and after timeline for each FIFO overflow', async () => {
  vi.clearAllMocks(); vi.stubEnv('BROWSER_AUDIO_DIAGNOSTICS', '1');
  let content = '';
  const file = { writeFile: vi.fn(async (value: string) => { content = value; }), sync: vi.fn(), close: vi.fn() };
  fs.mkdir.mockResolvedValue(undefined); fs.open.mockResolvedValue(file); fs.rename.mockResolvedValue(undefined);
  const metrics = new AudioMetrics('test-epoch'); metrics.trace('frame-before', { frameSequenceId: '10' });
  metrics.incident('fifo-overflow', { droppedFrameSequenceId: '11' }); metrics.trace('frame-after', { frameSequenceId: '12' });
  metrics.digest('assembled', '1', 'frame-1'); metrics.digest('assembled', '2', 'frame-2');
  metrics.digest('dequeued', '1', 'frame-1'); metrics.digest('dequeued', '3', 'frame-2');
  await metrics.write('capture', {});
  const report = JSON.parse(content), window = report.overflowWindows[0];
  expect(window.kind).toBe('fifo-overflow');
  expect(window.events.map((event: { kind: string }) => event.kind)).toEqual(expect.arrayContaining(['frame-before', 'fifo-overflow', 'frame-after']));
  expect(window.events.every((event: { monoMs: number }) => Number.isFinite(event.monoMs))).toBe(true);
  const frameDigests = report.frameDigests;
  expect(frameDigests.assembled.count).toBe(2); expect(frameDigests.dequeued.count).toBe(2);
  expect(frameDigests.assembled.sha256).not.toBe(frameDigests.dequeued.sha256);
  vi.unstubAllEnvs();
});
