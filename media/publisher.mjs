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
const width = Number(process.env.WIDTH ?? 1280),
  height = Number(process.env.HEIGHT ?? 720),
  fps = Number(process.env.FPS ?? 15);
if (
  ![
    [1280, 720],
    [1920, 1080],
  ].some(([w, h]) => w === width && h === height) ||
  ![15, 30].includes(fps)
)
  throw Error("Invalid profile");
const room = new Room(),
  source = new VideoSource(width, height),
  track = LocalVideoTrack.createVideoTrack("controlled-pattern", source);
let latest,
  received = 0,
  submitted = 0,
  dropped = 0,
  closing = false;
const auth = await new Promise((resolve, reject) => {
  const r = request(
    { socketPath: "/auth/token.sock", path: "/token", method: "POST" },
    (s) => {
      let b = "";
      s.on("data", (p) => (b += p));
      s.on("end", () => {
        try {
          if (s.statusCode !== 200) throw Error("Auth rejected");
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
await room.connect("ws://127.0.0.1:7880", auth.token, { autoSubscribe: false });
await room.localParticipant.publishTrack(
  track,
  new TrackPublishOptions({
    videoCodec: VideoCodec.VP8,
    source: TrackSource.SOURCE_CAMERA,
    simulcast: false,
    videoEncoding: {
      maxFramerate: fps,
      maxBitrate: width === 1280 ? 3000000 : 6000000,
    },
  }),
);
await mkdir("/frames", { recursive: true });
await chmod("/frames", 0o700);
await unlink("/frames/media.sock").catch((e) => {
  if (e.code !== "ENOENT") throw e;
});
// One fixed RGBA frame per request; one pending frame. Worker control socket is never mounted.
const server = createServer((req, res) => {
  if (
    closing ||
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
    if (
      b.readUInt32LE(0) !== width ||
      b.readUInt32LE(4) !== height ||
      !Number.isFinite(b.readDoubleLE(16))
    ) {
      res.writeHead(400).end();
      return;
    }
    received++;
    if (latest) dropped++;
    latest = b;
    res.writeHead(204).end();
  });
});
server.maxConnections = 1;
server.requestTimeout = 2000;
server.headersTimeout = 2000;
server.timeout = 2000;
server.listen("/frames/media.sock", () => chmod("/frames/media.sock", 0o600));
const pump = setInterval(() => {
  if (!latest) return;
  const b = latest;
  latest = undefined;
  source.captureFrame(
    new VideoFrame(b.subarray(24), width, height, VideoBufferType.RGBA),
  );
  submitted++;
}, 1000 / fps);
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
        elapsedMs: Date.now() - start,
        received,
        submitted,
        dropped,
        width,
        height,
        targetFps: fps,
        rss: process.memoryUsage().rss,
        outbound,
      }),
    );
  } catch (e) {
    console.error(e.message);
  }
}, 5000);
async function close(code) {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 8000);
  clearInterval(pump);
  clearInterval(stats);
  server.closeAllConnections();
  server.close();
  latest = undefined;
  await room.disconnect();
  await track.close();
  await source.close();
  await dispose();
  await unlink("/frames/media.sock").catch(() => {});
  clearTimeout(deadline);
  process.exit(code);
}
room.on(RoomEvent.Disconnected, () => {
  if (!closing) void close(1);
});
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => void close(0));
process.on("uncaughtException", (e) => {
  console.error(e.message);
  void close(1);
});
