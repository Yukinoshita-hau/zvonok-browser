import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const token = (await readFile(".env", "utf8"))
  .split(/\r?\n/)
  .find((s) => s.startsWith("DEV_TOKEN="))
  .slice(10)
  .trim();
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
let pngRequests = 0;
const errors = [];
page.on("request", (r) => {
  if (r.url().includes("/frame")) pngRequests++;
});
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    console.log(m.text().replace(/eyJ[\w.-]+/g, "[JWT]"));
});
page.on("requestfailed", (r) =>
  console.log(
    "request failed",
    new URL(r.url()).origin + new URL(r.url()).pathname,
    r.failure()?.errorText,
  ),
);
const samples = [];
const events = [];
function compose(...args) {
  execFileSync(
    "docker",
    [
      "--context",
      "desktop-linux",
      "compose",
      "-f",
      "compose.media.yaml",
      ...args,
    ],
    { stdio: "pipe" },
  );
}
const name = process.env.MEDIA_RUN ?? "720p15";
try {
  const denied = await fetch("http://127.0.0.1:47832/media/token", {
    method: "POST",
  });
  assert.equal(denied.status, 403);
  const issued = await fetch("http://127.0.0.1:47832/media/token", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(issued.status, 200);
  const claims = JSON.parse(
    Buffer.from((await issued.json()).token.split(".")[1], "base64url"),
  );
  assert.equal(claims.video.room, "slice-2a");
  assert.equal(claims.video.canPublish, false);
  assert.equal(claims.video.canPublishData, false);
  assert.equal(claims.video.roomAdmin, undefined);
  assert(claims.exp - claims.nbf <= 300);
  await page.goto("http://127.0.0.1:47832");
  await page.getByLabel("Dev token").fill(token);
  await page
    .getByRole("button", { name: "Подключиться к видео", exact: true })
    .click();
  await page.waitForFunction(
    () => window.mediaMetrics?.framesDecoded > 10,
    {},
    { timeout: 45000 },
  );
  await mkdir("artifacts", { recursive: true });
  const duration = Number(process.env.MEDIA_SECONDS ?? 65);
  for (let i = 0; i < duration; i++) {
    if (process.env.MEDIA_CHAOS === "1" && (i === 20 || i === 40)) {
      const before = await page.evaluate(
        () => window.mediaMetrics.generationMs,
      );
      if (i === 20) compose("restart", "publisher");
      else {
        compose("stop", "rtc-relay");
        await page.waitForTimeout(5000);
        assert(
          await page.evaluate(
            () => Date.now() - window.mediaMetrics.generationMs > 2000,
          ),
          "actual video must stop during RTC loss",
        );
        compose("start", "rtc-relay");
      }
      await page.waitForFunction(
        (old) => window.mediaMetrics?.generationMs > old,
        before,
        { timeout: 45000 },
      );
      events.push({
        event: i === 20 ? "publisher restart recovered" : "RTC loss recovered",
        at: Date.now(),
      });
    }
    await page.waitForTimeout(1000);
    samples.push(
      await page.evaluate(() => ({
        at: Date.now(),
        ...window.mediaMetrics,
        videoTime: document.querySelector("video").currentTime,
        state: document.querySelector("section [role=status]").textContent,
      })),
    );
  }
  assert(
    samples.at(-1).videoTime > samples[0].videoTime,
    "video time must advance",
  );
  assert.equal(pngRequests, 0);
  assert(samples.at(-1).latencyRejectedFrames / samples.at(-1).presentedFrames < 0.05,
    'timestamp decode rejection must stay below 5%');
  assert(
    samples.at(-1).generationMs > samples[0].generationMs,
    "timestamp in decoded pixels must advance",
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  await page.screenshot({
    path: `artifacts/media-${name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Отключиться от видео", exact: true })
    .click();
  await page.waitForTimeout(1200);
  assert.match(
    await page.locator("section [role=status]").first().textContent(),
    /disconnected/,
  );
  await page
    .getByRole("button", { name: "Подключиться к видео", exact: true })
    .click();
  await page.waitForTimeout(6000);
  assert.match(
    await page.locator("section [role=status]").first().textContent(),
    /^connected\b/,
  );
  console.log(
    JSON.stringify({
      name,
      first: samples[0],
      last: samples.at(-1),
      pngRequests,
      errors,
    }),
  );
} catch (e) {
  console.log(await page.locator("section").first().innerText());
  console.log(errors);
  await page.screenshot({ path: "artifacts/media-failure.png" });
  throw e;
} finally {
  await writeFile(
    `artifacts/media-${name}.json`,
    JSON.stringify({ samples, events, pngRequests, errors }, null, 2),
  );
  await browser.close();
}
