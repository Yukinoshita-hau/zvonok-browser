import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
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
const glyphs = [
  "111101101101111",
  "010110010010111",
  "111001111100111",
  "111001111001111",
  "101101111001001",
  "111100111001111",
  "111100111101111",
  "111001001001001",
  "111101111101111",
  "111101111001111",
];
let count = 0,
  failed = 0,
  stopping = false;
const start = Date.now();
for (const s of ["SIGTERM", "SIGINT"])
  process.on(s, () => {
    stopping = true;
  });
while (!stopping) {
  const due = performance.now() + 1000 / fps,
    now = Date.now(),
    b = Buffer.alloc(width * height * 4 + 24);
  b.writeUInt32LE(width, 0);
  b.writeUInt32LE(height, 4);
  b.writeBigUInt64LE(BigInt(++count), 8);
  b.writeDoubleLE(now, 16);
  const pixels = b.subarray(24);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 24;
    pixels[i + 1] = 40;
    pixels[i + 2] = 70;
    pixels[i + 3] = 255;
  }
  function rect(x, y, w, h, v) {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        const i = (yy * width + xx) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
      }
  }
  function text(value, y) {
    [...String(value)].forEach((ch, n) => {
      const g = glyphs[Number(ch)];
      if (g)
        for (let j = 0; j < 15; j++)
          if (g[j] === "1")
            rect(
              24 + n * 32 + (j % 3) * 8,
              y + Math.floor(j / 3) * 8,
              8,
              8,
              240,
            );
    });
  }
  text(count, 100);
  text(now, 180);
  text(fps, 260);
  rect((count * 9) % (width - 80), 350, 80, 80, 220);
  // 48-bit Unix milliseconds embedded in pixels, measured from the decoded frame (not a data channel).
  for (let i = 0; i < 48; i++)
    rect(
      ((16 + i * 12) * width) / 1280,
      (16 * height) / 720,
      (12 * width) / 1280,
      (24 * height) / 720,
      Number((BigInt(now) >> BigInt(i)) & 1n) ? 240 : 0,
    );
  await new Promise((resolve) => {
    const r = request(
      {
        socketPath: "/frames/media.sock",
        path: "/frame",
        method: "POST",
        headers: { "content-length": b.length },
      },
      (s) => {
        s.resume();
        s.on("end", () => {
          if (s.statusCode !== 204) failed++;
          resolve();
        });
      },
    );
    r.setTimeout(1000, () => r.destroy());
    r.on("error", () => {
      failed++;
      resolve();
    });
    r.end(b);
  });
  if (count % fps === 0)
    console.log(
      JSON.stringify({
        kind: "generator",
        at: Date.now(),
        count,
        failed,
        elapsedMs: Date.now() - start,
        generatedFps: (count * 1000) / (Date.now() - start),
      }),
    );
  await sleep(Math.max(0, due - performance.now()));
}
