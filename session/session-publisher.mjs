import { validFrame } from './frame.mjs';
import { sourceHealth } from './source-health.mjs';
import { publishBrowserAudio } from './audio-publisher.mjs';
import { closeOnDisconnect } from './publisher-disconnect.mjs';
import { resolveMediaProfile } from './media-profiles.mjs';
import { createServer } from "node:http";
import { request } from "node:http";
import { mkdir, chmod, unlink } from "node:fs/promises";
import {
  Room,
  RoomEvent,
  VideoSource,
  VideoFrame,
  VideoBufferType,
  LocalVideoTrack,
  TrackPublishOptions,
  VideoCodec,
  TrackSource,
  dispose,
} from "@livekit/rtc-node";
let epochSocket;
const room = new Room();
let source, track;
let lastSequence = -1n;
let latest,
  received = 0,
  submitted = 0,
  dropped = 0,
  closing = false, lastReceived=performance.now(), pump;
const auth = await new Promise((resolve, reject) => {
  const r = request(
    { socketPath: process.env.BROWSER_TOKEN_SOCKET ?? "/auth/token.sock", path: "/token", method: "POST" },
    (s) => {
      let b = "";
      s.on("data", (p) => (b += p));
      s.on("end", () => {
        try {
          if (s.statusCode !== 200) process.exit(0);
          resolve(JSON.parse(b));
        } catch (e) {
          reject(e);
        }
      });
    },
  );
  r.setTimeout(5000, () => r.destroy(Error("Auth timeout")));
  r.on("error", reject);
  r.end();
});
const { width, height, fps } = resolveMediaProfile(auth.profile);
source = new VideoSource(width, height);
track = LocalVideoTrack.createVideoTrack("browser-session", source);
epochSocket = `/frames/${auth.epoch}.sock`;
await room.connect("ws://127.0.0.1:7880", auth.token, { autoSubscribe: false });
await room.localParticipant.publishTrack(
  track,
  new TrackPublishOptions({
    videoCodec: VideoCodec.VP8,
    source: TrackSource.SOURCE_CAMERA,
    stream: 'browser-session',
    simulcast: false,
    videoEncoding: {
      maxFramerate: fps,
    maxBitrate: (width === 1280 ? 3000000 : 6000000) * (fps >= 60 ? 2 : 1),
    },
  }),
);
await mkdir("/frames", { recursive: true });
await chmod("/frames", 0o700);
const audio=process.env.BROWSER_AUDIO==='0'?undefined:await publishBrowserAudio(room,auth.epoch,e=>{console.error(e.message);void close(1,'audio-failure');});
await unlink(epochSocket).catch((e) => {
  if (e.code !== "ENOENT") throw e;
});
// One fixed RGBA frame per request; one pending frame. Worker control socket is never mounted.
const server = createServer((req, res) => {
  if (
    closing ||
    req.headers["transfer-encoding"] ||
    req.method !== "POST" ||
    req.url !== "/frame" ||
    Number(req.headers["content-length"]) !== width * height * 4 + 24
  ) {
    res.writeHead(400).end();
    req.destroy();
    return;
  }
  const parts = [];
  let bytes = 0;
  req.on("data", (p) => {
    bytes += p.length;
    if (bytes > width * height * 4 + 24) req.destroy();
    else parts.push(p);
  });
  req.on("end", () => {
    if (bytes !== width * height * 4 + 24) {
      res.writeHead(400).end();
      return;
    }
    const b = Buffer.concat(parts);
    if (!validFrame(b,width,height,lastSequence)) {
      res.writeHead(400).end();return;
    }
    lastSequence=b.readBigUInt64LE(8);
    lastReceived=performance.now();
    received++;
    if (latest) dropped++;
    latest = b;
    if(!pump)pump=setImmediate(submitLatest);
    res.writeHead(204).end();
  });
});
server.maxConnections = 1;
server.requestTimeout = 2000;
server.headersTimeout = 2000;
server.timeout = 2000;
server.listen(epochSocket, () => chmod(epochSocket, 0o600));
function submitLatest() {
  pump=undefined;
  if (!latest) return;
  const b = latest;
  latest = undefined;
  const submitStart=performance.now();
  source.captureFrame(
    new VideoFrame(b.subarray(24), width, height, VideoBufferType.RGBA),
    process.hrtime.bigint()/1000n-BigInt(Math.max(0,Math.round((Date.now()-b.readDoubleLE(16))*1000))),
  );
  submitted++;
  if(submitted%fps===0)console.log(JSON.stringify({kind:'submit-stage',at:Date.now(),captureAvailableMs:b.readDoubleLE(16),captureToSubmitMs:Date.now()-b.readDoubleLE(16),videoFrameAndCaptureCallMs:performance.now()-submitStart}));
}
const authorized=setInterval(()=>{
  if(!received || sourceHealth(performance.now(),lastReceived)!=='fresh' || (audio && !audio.fresh()))return;
  const r=request({socketPath:process.env.BROWSER_TOKEN_SOCKET ?? '/auth/token.sock',path:'/published',method:'POST',headers:{'content-type':'application/json'}},res=>{res.resume();if(res.statusCode!==200)void close(0,`authorization-status-${res.statusCode}`);});
  r.setTimeout(1500,()=>r.destroy());r.on('error',()=>void close(1,'authorization-transport'));r.end(JSON.stringify({sessionId:auth.sessionId,epoch:auth.epoch}));
},1000);
let sourceState='fresh';
const sourceWatchdog=setInterval(()=>{
  const state=sourceHealth(performance.now(),lastReceived);
  if(state!==sourceState){console.log(JSON.stringify({kind:'source-health',at:Date.now(),pid:process.pid,sessionId:auth.sessionId,epoch:auth.epoch,previous:sourceState,state,gapMs:performance.now()-lastReceived,received,submitted}));sourceState=state;}
  if(state==='expired')void close(1,'source-expired');
},100);
const start = Date.now();
const stats = setInterval(async () => {
  try {
    const rtc = await room.getRtcStats();
    const outbound = rtc.publisherStats
      .filter((s) => s.stats.case === "outboundRtp")
      .map((s) => s.stats.value.outbound?.toJson());
    console.log(
      JSON.stringify({
        kind: "publisher",
        at: Date.now(),
        pid: process.pid, sessionId: auth.sessionId, epoch: auth.epoch,
        elapsedMs: Date.now() - start,
        received,
        submitted,
        dropped,
        width,
        height,
        targetFps: fps,
        rss: process.memoryUsage().rss,
        outbound,
        mediaSources: rtc.publisherStats.filter(s=>s.stats.case==='mediaSource').map(s=>({source:s.stats.value.source?.toJson(),video:s.stats.value.video?.toJson(),audio:s.stats.value.audio?.toJson()})),
      }),
    );
  } catch (e) {
    console.error(e.message);
  }
}, 5000);
async function close(code, reason) {
  if (closing) return;
  closing = true;
  console.log(JSON.stringify({kind:'publisher-close',at:Date.now(),pid:process.pid,sessionId:auth.sessionId,epoch:auth.epoch,code,reason,received,submitted}));
  const deadline = setTimeout(() => process.exit(1), 8000);
  clearImmediate(pump);
  clearInterval(sourceWatchdog);
  clearInterval(authorized);
  clearInterval(stats);
  server.closeAllConnections();
  server.close();
  latest = undefined;
  try { await audio?.close(reason); } catch (e) { console.error(JSON.stringify({kind:'publisher-audio-cleanup-failed',reason:e instanceof Error?e.name:'Error',code:e&&typeof e==='object'&&typeof e.code==='string'?e.code:'UNKNOWN'})); }
  try { await room.disconnect(); } catch {}
  try { await track.close(); } catch {}
  try { await source.close(); } catch {}
  try { await dispose(); } catch {}
  await unlink(epochSocket).catch(() => {});
  clearTimeout(deadline);
  process.exit(code);
}
closeOnDisconnect(room, (code, reason) => closing ? undefined : close(code, reason));
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => void close(0,s));
process.on("uncaughtException", (e) => {
  console.error(e.message);
  void close(1,'uncaught-exception');
});
process.on("unhandledRejection", () => void close(1,'unhandled-rejection'));
