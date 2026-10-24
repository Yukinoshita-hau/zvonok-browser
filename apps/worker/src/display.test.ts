import { execFile } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { displayReady } from './surface.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn() }));

it('retries a transient display probe failure within a bounded budget', async () => {
  vi.mocked(execFile).mockReset();
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout?: string, stderr?: string) => void;
    callback(vi.mocked(execFile).mock.calls.length < 3 ? Error('ETIMEDOUT') : null, '', '');
    return {} as ReturnType<typeof execFile>;
  });
  await displayReady({}, 3);
  expect(execFile).toHaveBeenCalledTimes(3);
});
it('fails after three unhealthy probes instead of allowing an unbounded recovery', async () => {
  vi.mocked(execFile).mockReset();
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    (args.at(-1) as (error: Error) => void)(Error('ETIMEDOUT'));
    return {} as ReturnType<typeof execFile>;
  });
  await expect(displayReady({}, 3)).rejects.toThrow('ETIMEDOUT');
  expect(execFile).toHaveBeenCalledTimes(3);
});
