import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const LIMIT = 2048;
// shortcut: percentiles use a bounded reservoir, raise the limit only if longer-run percentile resolution is insufficient.
export type Samples = { count: number; sum: number; min: number; max: number; values: number[]; rng: number };
export const pcmDurationMs = (bytes: number, rate = 48000, channels = 2, bytesPerSample = 2) => bytes / (rate * channels * bytesPerSample) * 1000;
export function summarizeSamples(m: Samples) {
  const a=[...m.values].sort((x,y)=>x-y),p=(q:number)=>a[Math.max(0,Math.ceil(q*a.length)-1)]??null;
  return {count:m.count,min:m.count?m.min:null,mean:m.count?m.sum/m.count:null,p50:p(.5),p95:p(.95),p99:p(.99),max:m.count?m.max:null,reservoirSize:a.length};
}

type PcmRecording = { pcm: WriteStream; index: WriteStream; frames: number; samples: number; failed: boolean; pcmPath: string; indexPath: string };

export class AudioMetrics {
  readonly enabled = process.env.BROWSER_AUDIO_DIAGNOSTICS === '1';
  private metrics = new Map<string, Samples>();
  private counters = new Map<string, number>();
  private events: { at: number; kind: string; [key: string]: unknown }[] = [];
  private traceRing: { at: number; monoMs: number; kind: string; [key: string]: unknown }[] = [];
  private incidents: { id: number; kind: string; at: number; monoMs: number; events: { at: number; monoMs: number; kind: string; [key: string]: unknown }[] }[] = [];
  private frameDigests = new Map<string, { hash: Hash; count: number; firstSequenceId: string; lastSequenceId: string }>();
  private histogram?: ReturnType<typeof monitorEventLoopDelay>;
  private cpuTimer?: ReturnType<typeof setInterval>;
  private loopTimer?: ReturnType<typeof setInterval>;
  private nextLoopCheck = 0;
  private cpuPoll?: Promise<void>;
  private lastCpu?: Record<string, number>;
  private pcmRecordings = new Map<string, PcmRecording>();
  private startedAtWall = this.enabled ? Date.now() : 0;
  private flush?: Promise<void>;
  constructor(private epoch: string, private recordingDir = '/diagnostics') { if (this.enabled) { this.histogram = monitorEventLoopDelay({ resolution: 10 }); this.histogram.enable(); this.nextLoopCheck = performance.now() + 10; this.loopTimer = setInterval(() => { const now = performance.now(), delayMs = now - this.nextLoopCheck; this.nextLoopCheck = now + 10; if (delayMs > 20) this.trace('event-loop-delay-spike', { delayMs }); }, 10); this.loopTimer.unref(); this.cpuTimer = setInterval(() => void this.sampleCpu(), 100); this.cpuTimer.unref(); void this.sampleCpu(); } }
  durationMs(bytes: number) { return pcmDurationMs(bytes); }
  record(name: string, value: number) {
    if (!this.enabled || !Number.isFinite(value)) return;
    let metric = this.metrics.get(name);
    if (!metric) this.metrics.set(name, metric = { count: 0, sum: 0, min: Infinity, max: -Infinity, values: [], rng: 1 });
    metric.count++; metric.sum += value; metric.min = Math.min(metric.min, value); metric.max = Math.max(metric.max, value);
    if (metric.values.length < LIMIT) metric.values.push(value);
    else { metric.rng = (Math.imul(metric.rng, 1664525) + 1013904223) >>> 0; const i = metric.rng % metric.count; if (i < LIMIT) metric.values[i] = value; }
  }
  add(name: string, value = 1) { if (this.enabled) this.counters.set(name, (this.counters.get(name) ?? 0) + value); }
  event(kind: string, fields: Record<string, unknown> = {}) {
    if (!this.enabled) return;
    this.events.push({ at: Date.now(), monoMs: performance.now(), kind, ...fields });
    if (this.events.length > 256) this.events.shift();
  }
  trace(kind: string, fields: Record<string, unknown> = {}) {
    if (!this.enabled) return;
    const monoMs = performance.now(), entry = { at: Date.now(), monoMs, kind, ...fields };
    this.traceRing.push(entry);
    while (this.traceRing.length > 2048 || monoMs - this.traceRing[0].monoMs > 200) this.traceRing.shift();
    for (const incident of this.incidents) if (monoMs <= incident.monoMs + 200) incident.events.push(entry);
  }
  incident(kind: string, fields: Record<string, unknown> = {}) {
    if (!this.enabled) return;
    const monoMs = performance.now();
    this.trace(kind, fields);
    this.incidents.push({ id: this.incidents.length + 1, kind, at: Date.now(), monoMs, events: this.traceRing.filter(e => e.monoMs >= monoMs - 200) });
  }
  digest(stage: string, frameSequenceId: string, pcmSha256: string) {
    if (!this.enabled) return;
    let digest = this.frameDigests.get(stage);
    if (!digest) this.frameDigests.set(stage, digest = { hash: createHash('sha256'), count: 0, firstSequenceId: frameSequenceId, lastSequenceId: frameSequenceId });
    digest.hash.update(`${frameSequenceId}:${pcmSha256}\n`); digest.count++; digest.lastSequenceId = frameSequenceId;
  }
  recordPcm(stage: string, frameSequenceId: string, sourceSampleStart: number, pcm: Buffer, pcmSha256: string) {
    if (!this.enabled || process.env.BROWSER_AUDIO_PCM_RECORDING !== '1') return;
    let recording = this.pcmRecordings.get(stage);
    if (!recording) {
      const stem = `pcm-${stage}-${this.epoch}-${process.pid}`;
      recording = { pcm: createWriteStream(`${this.recordingDir}/${stem}.s16le`, { flags: 'wx', mode: 0o600, highWaterMark: 256 * 1024 }), index: createWriteStream(`${this.recordingDir}/${stem}.jsonl`, { flags: 'wx', mode: 0o600, highWaterMark: 64 * 1024 }), frames: 0, samples: 0, failed: false, pcmPath: `${this.recordingDir}/${stem}.s16le`, indexPath: `${this.recordingDir}/${stem}.jsonl` };
      recording.pcm.on('error', () => { recording!.failed = true; }); recording.index.on('error', () => { recording!.failed = true; }); this.pcmRecordings.set(stage, recording);
    }
    if (recording.failed) return;
    const sampleCount = pcm.length / 4, recordingSampleStart = recording.samples;
    const pcmReady = recording.pcm.write(pcm), indexReady = recording.index.write(JSON.stringify({ frameSequenceId, sourceSampleStart, sourceSampleEnd: sourceSampleStart + sampleCount, recordingSampleStart, recordingSampleEnd: recordingSampleStart + sampleCount, pcmSha256 }) + '\n');
    recording.frames++; recording.samples += sampleCount;
    if (!pcmReady || !indexReady) { recording.failed = true; this.add('pcm.recordingBackpressureFailures'); }
  }
  async closePcmRecordings() {
    const result: Record<string, unknown> = {};
    await Promise.all([...this.pcmRecordings].map(async ([stage, recording]) => {
      await Promise.all([recording.pcm, recording.index].map(stream => new Promise<void>(resolve => { stream.once('error', () => resolve()); stream.end(() => resolve()); })));
      result[stage] = { pcmPath: recording.pcmPath, indexPath: recording.indexPath, frames: recording.frames, samplesPerChannel: recording.samples, failed: recording.failed };
    }));
    return result;
  }
  private sampleCpu() {
    if (!this.enabled || this.cpuPoll) return this.cpuPoll;
    this.cpuPoll = (async () => {
      try {
        const [statText, maxText] = await Promise.all([readFile('/sys/fs/cgroup/cpu.stat', 'utf8'), readFile('/sys/fs/cgroup/cpu.max', 'utf8')]);
        const stat = Object.fromEntries(statText.trim().split('\n').map(line => { const [key, value] = line.split(/\s+/); return [key, Number(value)]; })) as Record<string, number>;
        const [quota, period] = maxText.trim().split(/\s+/), cores = quota === 'max' ? null : Number(quota) / Number(period);
        if (cores !== null) this.record('cpu.quotaCores', cores);
        if (this.lastCpu) {
          const periodsDelta = stat.nr_periods - this.lastCpu.nr_periods, throttledPeriodsDelta = stat.nr_throttled - this.lastCpu.nr_throttled, throttledUsecDelta = stat.throttled_usec - this.lastCpu.throttled_usec;
          this.record('cpu.periodsDelta', periodsDelta); this.record('cpu.throttledPeriodsDelta', throttledPeriodsDelta); this.record('cpu.throttledUsecDeltaMs', throttledUsecDelta / 1000); this.record('cpu.throttledPeriodRatioPct', periodsDelta ? throttledPeriodsDelta * 100 / periodsDelta : 0);
          this.trace('cgroup-cpu-interval', { periodsDelta, throttledPeriodsDelta, throttledUsecDelta, quotaCores: cores });
        }
        this.lastCpu = stat;
      } catch {}
    })().finally(() => { this.cpuPoll = undefined; });
    return this.cpuPoll;
  }
  write(stage: string, definitions: Record<string, string>) {
    if (!this.enabled) return;
    if (this.flush) return this.flush;
    this.flush = this.writeOnce(stage, definitions);
    return this.flush;
  }
  private async writeOnce(stage: string, definitions: Record<string, string>) {
    const pendingMs = Math.max(0, ...this.incidents.map(e => e.monoMs + 200 - performance.now()));
    if (pendingMs) await new Promise(resolve => setTimeout(resolve, pendingMs));
    clearInterval(this.cpuTimer); clearInterval(this.loopTimer); await this.sampleCpu();
    const pcmRecordings = await this.closePcmRecordings();
    this.histogram?.disable();
    const metrics: Record<string, unknown> = Object.fromEntries([...this.metrics].map(([name, m]) => [name,summarizeSamples(m)]));
    for (const [name, value] of this.counters) metrics[name] = value;
    const loop = this.histogram;
    if (loop) metrics.eventLoopDelayMs = { count: Number(loop.count), min: loop.count ? Number(loop.min) / 1e6 : null, mean: loop.count ? Number(loop.mean) / 1e6 : null, p50: loop.count ? Number(loop.percentile(50)) / 1e6 : null, p95: loop.count ? Number(loop.percentile(95)) / 1e6 : null, p99: loop.count ? Number(loop.percentile(99)) / 1e6 : null, max: loop.count ? Number(loop.max) / 1e6 : null };
    const path = `/diagnostics/audio-${stage}-diagnostics-${this.epoch}-${process.pid}.json`, temp = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir('/diagnostics', { recursive: true });
      const file = await open(temp, 'wx', 0o600);
      const frameDigests = Object.fromEntries([...this.frameDigests].map(([name, d]) => [name, { count: d.count, firstSequenceId: d.firstSequenceId, lastSequenceId: d.lastSequenceId, sha256: d.hash.digest('hex') }]));
      try { await file.writeFile(JSON.stringify({ schemaVersion: 1, enabled: true, startedAt: this.startedAtWall, node: process.version, livekitSdk: '1.1.0 (media/package-lock.json)', stage, pcm: { sampleRate: 48000, channels: 2, format: 's16le', bytesPerSampleFrame: 4, audioFrameSamplesPerChannel: 480, audioFrameDurationMs: 10 }, metrics, frameDigests, pcmRecordings, definitions, unavailable: ['AudioSource native queue capacity and exact overflow behavior are not visible to this process'], events: this.events, overflowWindows: this.incidents }, null, 2)); await file.sync(); } finally { await file.close(); }
      await rename(temp, path);
      console.log(JSON.stringify({ kind: 'audio-diagnostics-written', stage, path }));
    } catch (error) {
      await unlink(temp).catch(() => {});
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'WRITE_FAILED';
      console.error(JSON.stringify({ kind: 'audio-diagnostics-write-failed', stage, path, code }));
    }
  }
}
