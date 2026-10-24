import { expect, it, vi } from 'vitest';
import { progress } from './diagnostics.js';

it('startup diagnostics survive unavailable cgroups and identify the clock and process', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    progress('test-phase', { sessionId: 'test-session' });
    const event = JSON.parse(log.mock.calls[0][0]);
    expect(event).toMatchObject({ kind: 'startup-progress', phase: 'test-phase', pid: process.pid, sessionId: 'test-session' });
    expect(event.at).toBeGreaterThan(0);
    expect(event.monoMs).toBeGreaterThanOrEqual(0);
    expect(event.resources).toBeTypeOf('object');
  } finally { log.mockRestore(); }
});
