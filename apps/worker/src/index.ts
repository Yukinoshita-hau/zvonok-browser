import Fastify from "fastify";
import { chromium, type Browser, type Page } from "playwright";
import { randomUUID } from "node:crypto";
import { chmod, unlink, readFile } from "node:fs/promises";
import {
  Empty,
  Input,
  Navigate,
  allowedUrl,
  type BrowserSession,
  type InputAction,
} from "@browser/protocol";
const app = Fastify({
  logger: false,
  bodyLimit: 16384,
  ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  requestTimeout: 20000,
});
let browser: Browser | undefined,
  page: Page | undefined,
  session: BrowserSession | undefined,
  closing = false;
let cleaning: Promise<void> | undefined;
let tail = Promise.resolve(),
  pending = 0;
const idleMs = Number(process.env.IDLE_MS ?? 300000),
  ttlMs = Number(process.env.TTL_MS ?? 1200000);
function error(code: string, statusCode = 409) {
  return Object.assign(new Error(code), { statusCode, code });
}
async function guard() {
  try {
    if ((await readFile("/guard/ready", "utf8")).trim() !== "firewall-v1")
      throw new Error("Firewall unavailable");
    const r = await fetch("http://172.30.81.2:3128/guard-ready", {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) throw new Error("Proxy unavailable");
  } catch {
    throw error("DEPENDENCIES_UNAVAILABLE", 503);
  }
}
async function cleanup(status: BrowserSession["status"]) {
  if (cleaning) return cleaning;
  const b = browser;
  browser = undefined;
  page = undefined;
  const target = session;
  if (target) target.status = "closing";
  const job = (async () => {
    const deadline = setTimeout(() => process.exit(1), 10000);
    try {
      if (b) await b.close();
      if (target) target.status = status;
    } finally {
      clearTimeout(deadline);
    }
  })();
  cleaning = job;
  try {
    await job;
  } finally {
    cleaning = undefined;
  }
}
function serial<T>(fn: () => Promise<T>): Promise<T> {
  if (closing || pending >= 16) return Promise.reject(error("QUEUE_FULL", 429));
  pending++;
  const result = tail.then(fn);
  tail = result
    .then(
      () => {},
      () => {},
    )
    .finally(() => {
      pending--;
    });
  return result;
}
function active(id: string) {
  if (!session || session.sessionId !== id) throw error("NOT_FOUND", 404);
  if (session.status !== "active" || !page) throw error("SESSION_NOT_ACTIVE");
  if (
    Date.now() >= Date.parse(session.expiresAt) ||
    Date.now() >= Date.parse(session.idleExpiresAt)
  )
    throw error("SESSION_EXPIRED");
  return page;
}
function touch() {
  if (session) {
    session.lastActivityAt = new Date().toISOString();
    session.idleExpiresAt = new Date(Date.now() + idleMs).toISOString();
    session.currentUrl = page?.url() ?? session.currentUrl;
  }
}
app.setErrorHandler((value, _req, reply) => {
  const e = value as Error & {
    statusCode?: number;
    code?: string;
  };
  const status = e.statusCode ?? 500;
  reply
    .code(status)
    .send({
      error: {
        code:
          status === 400
            ? "INVALID_ACTION"
            : status >= 500
              ? (e.code ?? "BROWSER_FAILURE")
              : e.message,
        message: status >= 500 ? "Browser operation failed" : e.message,
      },
    });
});
app.get("/ready", async () => {
  await guard();
  return { status: "ready" };
});
app.post("/sessions", { schema: { body: Empty } }, async (_req, reply) => {
  const result = await serial(async () => {
    if (browser || cleaning) throw error("SESSION_LIMIT");
    await guard();
    const now = new Date().toISOString();
    session = {
      sessionId: randomUUID(),
      ownerId: "local-owner",
      status: "creating",
      createdAt: now,
      lastActivityAt: now,
      currentUrl: "about:blank",
      workerId: process.env.HOSTNAME ?? "worker",
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      idleExpiresAt: new Date(Date.now() + idleMs).toISOString(),
    };
    try {
      browser = await chromium.launch({
        headless: true,
        channel: "chromium",
        chromiumSandbox: true,
        proxy: { server: "http://172.30.81.2:3128" },
        timeout: 15000,
        args: ["--disable-quic", "--proxy-bypass-list=<-loopback>", "--deny-permission-prompts"],
      });
      if (closing) throw error("SHUTTING_DOWN", 503);
      browser.on("disconnected", () => {
        if (browser) {
          void cleanup("crashed");
        }
      });
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        serviceWorkers: "block",
        acceptDownloads: false,
        permissions: [],
      });
      await context.route("**/*", (route) =>
        allowedUrl(route.request().url()) ? route.continue() : route.abort(),
      );
      await context.routeWebSocket("**/*", (ws) => ws.close());
      // Redirect requests may skip route handlers; terminate on every forbidden request.
      context.on("request", (request) => {
        if (request.isNavigationRequest() && !allowedUrl(request.url()))
          void cleanup("crashed");
      });
      context.on("page", (p) => {
        if (page && p !== page) void p.close();
      });
      page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(12000);
      page.on("crash", () => {
        void cleanup("crashed");
      });
      page.on("dialog", (d) => {
        void d.dismiss();
      });
      page.on("framenavigated", (frame) => {
        if (session?.status === "active" && frame === page?.mainFrame())
          session.currentUrl = frame.url();
      });
      session.status = "active";
      return session;
    } catch {
      await cleanup("crashed");
      throw error("BROWSER_START_FAILED", 502);
    }
  });
  return reply.code(201).send(result);
});
app.get<{
  Params: {
    id: string;
  };
}>("/sessions/:id", async (req) => {
  if (!session || session.sessionId !== req.params.id)
    throw error("NOT_FOUND", 404);
  return session;
});
app.delete<{
  Params: {
    id: string;
  };
}>("/sessions/:id", async (req, reply) => {
  await serial(async () => {
    if (!session || session.sessionId !== req.params.id)
      throw error("NOT_FOUND", 404);
    await cleanup("closed");
  });
  return reply.code(204).send();
});
app.get<{
  Params: {
    id: string;
  };
}>("/sessions/:id/frame", async (req, reply) =>
  reply
    .type("image/png")
    .header("cache-control", "no-store")
    .send(
      await serial(async () => {
        const p = active(req.params.id);
        try { return await p.screenshot({ timeout: 8000 }); }
        catch { await cleanup("crashed"); throw error("FRAME_FAILED", 502); }
      }),
    ),
);
for (const action of [
  "navigate",
  "back",
  "forward",
  "reload",
  "input",
] as const) {
  app.post<{
    Params: {
      id: string;
    };
    Body: unknown;
  }>(
    `/sessions/:id/${action}`,
    {
      schema: {
        body:
          action === "navigate" ? Navigate : action === "input" ? Input : Empty,
      },
    },
    (req) =>
      serial(async () => {
        const p = active(req.params.id);
        await guard();
        try {
          if (action === "navigate") {
            const { url } = req.body as {
              url: string;
            };
            if (!allowedUrl(url)) throw error("URL_FORBIDDEN", 400);
            await p.goto(url, { waitUntil: "domcontentloaded" });
          }
          if (action === "back")
            await p.goBack({ waitUntil: "domcontentloaded" });
          if (action === "forward")
            await p.goForward({ waitUntil: "domcontentloaded" });
          if (action === "reload")
            await p.reload({ waitUntil: "domcontentloaded" });
          if (action === "input") {
            const a = req.body as InputAction;
            switch (a.type) {
              case "mouseMove":
                await p.mouse.move(a.x, a.y);
                break;
              case "mouseClick":
                await p.mouse.click(a.x, a.y, { button: a.button });
                break;
              case "wheel":
                await p.mouse.move(a.x, a.y);
                await p.mouse.wheel(a.deltaX, a.deltaY);
                break;
              case "text":
                await p.keyboard.insertText(a.text);
                break;
              case "keyPress":
                await p.keyboard.press(a.key);
                break;
            }
          }
          touch();
          return session;
        } catch (e) {
          if (e instanceof Error && "statusCode" in e) throw e;
          await cleanup("crashed");
          throw error("BROWSER_ACTION_FAILED", 502);
        }
      }),
  );
}
const timer = setInterval(() => {
  if (
    session &&
    browser &&
    (Date.now() >= Date.parse(session.expiresAt) ||
      Date.now() >= Date.parse(session.idleExpiresAt))
  )
    void cleanup("expired");
}, 1000);
await unlink("/control/worker.sock").catch(() => {});
await app.listen({ path: "/control/worker.sock" });
await chmod("/control/worker.sock", 0o660);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    closing = true;
    clearInterval(timer);
    const deadline = setTimeout(() => process.exit(1), 10000);
    void cleanup("closed")
      .then(() => app.close())
      .finally(() => {
        clearTimeout(deadline);
      });
  });
