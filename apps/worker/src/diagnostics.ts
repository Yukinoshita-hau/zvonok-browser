import { readFileSync } from 'node:fs';

// Process-local monotonic time is comparable only within this pid; wall time is for correlation.
export function progress(phase: string, fields: Record<string, unknown> = {}) {
  const resources: Record<string, string> = {};
  for (const file of ['cpu.stat', 'cpu.pressure', 'memory.current', 'memory.events', 'pids.current', 'pids.max']) {
    try { resources[file] = readFileSync('/sys/fs/cgroup/' + file, 'utf8').trim(); } catch {}
  }
  console.log(JSON.stringify({ kind: 'startup-progress', phase, at: Date.now(), monoMs: performance.now(), pid: process.pid, resources, ...fields }));
}
