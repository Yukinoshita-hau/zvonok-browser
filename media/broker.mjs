import { createServer } from "node:http";
import { mkdir, chmod, unlink, readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { AccessToken, TrackSource } from "livekit-server-sdk";
const secret = (await readFile("/secrets/livekit.yaml", "utf8")).match(
  /  spike: (\w+)/,
)?.[1];
const dev = process.env.DEV_TOKEN;
if (!secret || !dev || dev.length < 32)
  throw Error("Missing development credentials");
async function token(publisher) {
  const t = new AccessToken("spike", secret, {
    identity: publisher ? "media-publisher" : `viewer-${crypto.randomUUID()}`,
    ttl: "5m",
  });
  t.addGrant({
    roomJoin: true,
    room: "slice-2a",
    canPublish: publisher,
    canSubscribe: !publisher,
    canPublishData: false,
    ...(publisher ? { canPublishSources: [TrackSource.CAMERA] } : {}),
  });
  return t.toJwt();
}
function serve(publisher) {
  return createServer(async (req, res) => {
    const a = Buffer.from(req.headers.authorization ?? ""),
      b = Buffer.from(`Bearer ${dev}`);
    if (
      req.method !== "POST" ||
      req.url !== "/token" ||
      req.headers["transfer-encoding"] ||
      Number(req.headers["content-length"] ?? 0) !== 0 ||
      (!publisher && (a.length !== b.length || !timingSafeEqual(a, b)))
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      const jwt = await token(publisher);
      res
        .writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(
          JSON.stringify({
            token: jwt,
            url: "ws://127.0.0.1:47833",
            room: "slice-2a",
          }),
        );
    } catch (e) {
      console.error(e.message);
      res.writeHead(500).end();
    }
  });
}
await mkdir("/auth", { recursive: true });
await chmod("/auth", 0o700);
await unlink("/auth/token.sock").catch((e) => {
  if (e.code !== "ENOENT") throw e;
});
const privateServer = serve(true);
privateServer.maxConnections = 2;
privateServer.requestTimeout = 5000;
privateServer.listen("/auth/token.sock", () =>
  chmod("/auth/token.sock", 0o600),
);
const viewer = serve(false);
viewer.maxConnections = 16;
viewer.requestTimeout = 5000;
viewer.listen(3001, "0.0.0.0");
for (const s of ["SIGTERM", "SIGINT"])
  process.on(s, () => {
    viewer.close();
    privateServer.close();
  });
