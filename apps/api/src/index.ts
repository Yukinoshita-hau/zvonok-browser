import Fastify from "fastify";
import { request } from "node:http";
import { timingSafeEqual } from "node:crypto";
const token = process.env.DEV_TOKEN;
if (!token || token.length < 32)
  throw new Error("DEV_TOKEN must have at least 32 characters");
const app = Fastify({ logger: false, bodyLimit: 16384, requestTimeout: 20000 });
let windowStart = Date.now(),
  commands = 0;
function worker(
  method: string,
  path: string,
  body?: unknown,
): Promise<{
  status: number;
  type: string;
  data: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: "/control/worker.sock",
        path,
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (p) => parts.push(p));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 502,
            type: res.headers["content-type"] ?? "application/json",
            data: Buffer.concat(parts),
          }),
        );
      },
    );
    req.setTimeout(18000, () => req.destroy(new Error("WORKER_TIMEOUT")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
app.get("/health", async () => ({ status: "ok" }));
app.get("/ready", async (_, reply) => {
  try {
    const r = await worker("GET", "/ready");
    return reply.code(r.status).type(r.type).send(r.data);
  } catch {
    return reply
      .code(503)
      .send({
        error: { code: "WORKER_UNAVAILABLE", message: "Worker unavailable" },
      });
  }
});
app.all("/sessions*", async (req, reply) => {
  const supplied = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return reply
      .code(401)
      .send({
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      });
  if (Date.now() - windowStart > 1000) {
    windowStart = Date.now();
    commands = 0;
  }
  if (++commands > 30)
    return reply
      .code(429)
      .send({ error: { code: "RATE_LIMIT", message: "Too many commands" } });
  try {
    const r = await worker(req.method, req.url, req.body);
    return reply
      .code(r.status)
      .type(r.type)
      .header("cache-control", "no-store")
      .send(r.data);
  } catch {
    return reply
      .code(503)
      .send({
        error: { code: "WORKER_UNAVAILABLE", message: "Worker unavailable" },
      });
  }
});
await app.listen({ host: "0.0.0.0", port: 3000 });
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void app.close();
  });
