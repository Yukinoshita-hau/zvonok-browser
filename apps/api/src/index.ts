import Fastify from "fastify";
import { request } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { BrowserPool, IntegrationAuth } from './integration.js';
const token = process.env.DEV_TOKEN;
const integrationKey = process.env.BROWSER_INTEGRATION_KEY;
const workerSockets = (process.env.BROWSER_WORKER_SOCKETS ?? "/control/worker.sock").split(",");
if (!workerSockets.length || workerSockets.length > 16 || workerSockets.some(socket => !/^\/[a-zA-Z0-9_/-]+\.sock$/.test(socket))) throw Error("INVALID_WORKER_SOCKET");
if (!integrationKey && (!token || token.length < 32))
	throw new Error("DEV_TOKEN must have at least 32 characters");
const app = Fastify({ logger: false, bodyLimit: 16384, requestTimeout: 20000 });
// Two fixed buckets keep guest overload from blocking owner revoke/End.
const windows = { owner: { start: 0, commands: 0 }, guest: { start: 0, commands: 0 } };
function worker(
	method: string,
	path: string,
	body?: unknown,
	credentials: Record<string, string> = {},
	socketPath = "/control/worker.sock",
): Promise<{
	status: number;
	type: string;
	data: Buffer;
}> {
	return new Promise((resolve, reject) => {
		const started = performance.now(), traceId = randomUUID();
		const trace = (phase: string, status?: number) => {
			if (process.env.BROWSER_TRACE === '1') console.log(JSON.stringify({ kind: 'worker-ipc', phase, traceId, at: Date.now(), elapsedMs: performance.now() - started, method, path, socketPath, status }));
		};
		trace('send');
		const req = request(
			{
				socketPath,
				path,
				method,
				headers: { ...credentials, 'x-request-id': traceId, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			},
			(res) => {
				trace('headers', res.statusCode);
				const parts: Buffer[] = [];
				res.on('error', reject);
				res.on("data", (p) => parts.push(p));
				res.on("end", () => {
					trace('end', res.statusCode);
					resolve({
						status: res.statusCode ?? 502,
						type: res.headers["content-type"] ?? "application/json",
						data: Buffer.concat(parts),
					});
				});
			},
		);
		req.setTimeout(18000, () => req.destroy(new Error("WORKER_TIMEOUT")));
		req.on("error", e => { trace(e.message); reject(e); });
		req.end(body === undefined ? undefined : JSON.stringify(body));
	});
}
app.get("/health", async () => ({ status: "ok" }));
let integrationReady: (() => Promise<boolean>) | undefined;
if (integrationKey) {
	const auth = new IntegrationAuth(integrationKey), integration = new BrowserPool(workerSockets.map(socket => (method, path, body, credentials) => worker(method, path, body, credentials, socket)));
	integrationReady = () => integration.ready();
	app.post<{ Body: { assertion: string } }>('/integration', { schema: { body: { type: 'object', additionalProperties: false, required: ['assertion'], properties: { assertion: { type: 'string', maxLength: 24000 } } } } }, async (req, reply) => {
		let activityId: string | undefined, op: string | undefined;
		try {
			const c = auth.verify(req.body.assertion);
			activityId = c.activityId; op = c.op;
			const r = await integration.handle(c);
			if (r.status >= 400) console.log(JSON.stringify({ kind: 'integration-rejected', at: Date.now(), activityId, op, status: r.status }));
			return reply.code(r.status).type(r.type).header('cache-control', 'no-store').send(r.data);
		} catch (e) {
			const code = e instanceof Error && ['UNAUTHORIZED', 'ACCESS_DENIED', 'ACTIVITY_ENDED', 'ACTIVITY_BUSY', 'RATE_LIMIT'].includes(e.message) ? e.message : 'BROWSER_UNAVAILABLE';
			const status = code === 'UNAUTHORIZED' ? 401 : code === 'ACCESS_DENIED' ? 403 : code === 'RATE_LIMIT' ? 429 : code === 'BROWSER_UNAVAILABLE' ? 503 : 409;
			const detail = e instanceof Error && /^[A-Z][A-Z0-9_]{1,60}$/.test(e.message) ? e.message : code;
			console.log(JSON.stringify({ kind: 'integration-rejected', at: Date.now(), monoMs: performance.now(), pid: process.pid, activityId, op, status, reason: detail }));
			return reply.code(status).send({ error: { code } });
		}
	});
	const timer = setInterval(() => void integration.sweep().catch(() => { }), 500);
	app.addHook('onClose', async () => { clearInterval(timer); });
}
app.get("/ready", async (_, reply) => {
	try {
		if (integrationReady) {
			if (!await integrationReady()) return reply.code(503).send({ status: "not_ready", expectedWorkers: workerSockets.length });
			return { status: "ready", workers: workerSockets.length };
		}
		const r = await worker("GET", "/ready", undefined, undefined, workerSockets[0]);
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
	if (integrationKey) return reply.code(404).send({ error: { code: 'NOT_FOUND' } });
	const supplied = Buffer.from(req.headers.authorization ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	const owner = supplied.length === expected.length && timingSafeEqual(supplied, expected);
	if (!owner && process.env.BROWSER_SHARED !== '1') return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
	const accepting = req.method === 'POST' && /^\/sessions\/[0-9a-f-]{36}\/accept$/.test(req.url);
	if (!owner && !accepting && !/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization ?? ''))
		return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
	// Only this trusted API selects owner; client identity headers are never forwarded.
	const credentials: Record<string, string> = owner ? { 'x-browser-owner': '1' } : { 'x-browser-guest': (req.headers.authorization ?? '').slice(7) };
	for (const key of ['x-control-epoch', 'x-control-generation']) {
		const value = req.headers[key]; if (typeof value === 'string') credentials[key] = value;
	}
	const window = windows[owner ? 'owner' : 'guest'];
	if (Date.now() - window.start > 1000) {
		window.start = Date.now();
		window.commands = 0;
	}
	if (++window.commands > 30)
		return reply
			.code(429)
			.send({ error: { code: "RATE_LIMIT", message: "Too many commands" } });
	try {
		const r = await worker(req.method, req.url, req.body, credentials);
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
