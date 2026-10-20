import { request } from "node:http";
import assert from "node:assert/strict";
async function call(
  socketPath,
  path,
  method = "POST",
  body = Buffer.alloc(0),
  headers = {},
) {
  return new Promise((resolve, reject) => {
    const r = request(
      {
        agent: false,
        socketPath,
        path,
        method,
        headers: { "content-length": body.length, ...headers },
      },
      (s) => {
        const parts = [];
        s.on("data", (p) => parts.push(p));
        s.on("end", () =>
          resolve({
            status: s.statusCode,
            body: Buffer.concat(parts).toString(),
          }),
        );
      },
    );
    r.setTimeout(3000, () => r.destroy(Error("timeout")));
    r.on("error", reject);
    r.end(body);
  });
}
const auth = await call("/auth/token.sock", "/token");
assert.equal(auth.status, 200);
const claims = JSON.parse(
  Buffer.from(JSON.parse(auth.body).token.split(".")[1], "base64url"),
);
assert.equal(claims.video.room, "slice-2a");
assert.equal(claims.sub, "media-publisher");
assert.equal(claims.video.canSubscribe, false);
assert.equal(claims.video.canPublishData, false);
assert.deepEqual(claims.video.canPublishSources, ["camera"]);
assert(claims.exp - claims.nbf <= 300);
assert.equal(claims.video.roomAdmin, undefined);
for (const [path, method] of [
  ["/shell", "POST"],
  ["/frame", "GET"],
  ["/frame", "POST"],
]) {
  try {
    const r = await call("/frames/media.sock", path, method);
    assert.equal(r.status, 400);
  } catch (e) {
    assert(["ECONNRESET", "EPIPE"].includes(e.code));
  }
}
const w = Number(process.env.WIDTH ?? 1280),
  h = Number(process.env.HEIGHT ?? 720);
const b = Buffer.alloc(w * h * 4 + 24);
b.writeUInt32LE(w, 0);
b.writeUInt32LE(h, 4);
b.writeDoubleLE(NaN, 16);
assert.equal(
  (await call("/frames/media.sock", "/frame", "POST", b)).status,
  400,
);
b.writeDoubleLE(Date.now(), 16);
b.writeUInt32LE(w + 1, 0);
assert.equal(
  (await call("/frames/media.sock", "/frame", "POST", b)).status,
  400,
);
console.log(
  "PASS: restricted JWT; method/path/length/dimensions/timestamp rejected",
);
