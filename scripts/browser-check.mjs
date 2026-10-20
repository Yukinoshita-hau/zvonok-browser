// Only a local container acceptance harness; never exposed by the service API.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { allowedUrl } from "../packages/protocol/dist/index.js";
const rows = [];
let browser;
async function check(name, fn) {
  try {
    await fn();
    rows.push({ name, result: "PASS" });
  } catch (e) {
    rows.push({ name, result: "FAIL", detail: e.message.split("\n")[0] });
  }
}
const launch = () =>
  chromium.launch({
    chromiumSandbox: true,
    headless: true, channel: "chromium",
    proxy: { server: "http://172.30.81.2:3128" },
    args: ["--disable-quic", "--proxy-bypass-list=<-loopback>", "--deny-permission-prompts"],
    timeout: 15000,
  });
try {
  await check("non-root Chromium sandbox launch", async () => {
    assert.notEqual(process.getuid(), 0);
    browser = await launch();
  });
  if (browser) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      permissions: [],
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(12000);
    await check("Chromium reports namespace and seccomp sandbox", async () => {
      await page.goto("chrome://sandbox");
      const text = await page.locator("body").innerText();
      assert.match(text, /Layer 1 Sandbox\s+Namespace/);
      assert.match(text, /Seccomp-BPF sandbox\s+Yes/);
    });
    await check("public form click text scroll", async () => {
      await page.goto("https://www.selenium.dev/selenium/web/web-form.html");
      await page.locator('input[name="my-text"]').click();
      await page.keyboard.insertText("Slice one");
      assert.equal(
        await page.locator('input[name="my-text"]').inputValue(),
        "Slice one",
      );
      await page.mouse.move(600, 600);
      // Controlled tall-page fixture verifies wheel even when the public form fits.
      await page.evaluate(() => { document.body.style.minHeight = "2000px"; });
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(300);
      assert.ok(await page.evaluate(() => scrollY > 0));
    });
    await check("storage seed", async () => {
      await page.goto("https://example.com/");
      const denied = await page.evaluate(() => new Promise(resolve => navigator.geolocation.getCurrentPosition(() => resolve(false), e => resolve(e.code === 1), {timeout: 3000})));
      assert.equal(denied, true);
      await context.addCookies([
        { name: "slice-test", value: "temporary", url: "https://example.com/" },
      ]);
      await page.evaluate(() => {
        localStorage.setItem("slice-test", "temporary");
        sessionStorage.setItem("slice-test", "temporary");
      });
      assert.equal((await context.cookies()).length, 1);
    });
    await context.close();
    await browser.close();
    browser = await launch();
    const clean = await browser.newContext();
    const p = await clean.newPage();
    await check("fresh browser storage empty", async () => {
      await p.goto("https://example.com/");
      assert.equal((await clean.cookies()).length, 0);
      assert.deepEqual(
        await p.evaluate(() => [
          localStorage.getItem("slice-test"),
          sessionStorage.getItem("slice-test"),
        ]),
        [null, null],
      );
    });
    await check("redirect blocked by request policy", async () => {
      let rejected = false;
      p.on("request", request => { if (!allowedUrl(request.url())) rejected = true; });
      await p.route("**/*", async (route) => {
        const url = route.request().url();
        if (url === "https://example.com/__redirect") {
          await route.fulfill({
            status: 302,
            headers: { location: "https://169.254.169.254/" },
            body: "",
          });
        } else if (!allowedUrl(url)) {
          rejected = true;
          await route.abort();
        } else await route.continue();
      });
      await p.goto("https://example.com/__redirect").catch(() => {});
      assert.equal(rejected, true);
    });
    await check("subresource blocked by request policy", async () => {
      let blocked = false;
      await p.unrouteAll();
      await p.route("**/*", async (route) => {
        const url = route.request().url();
        if (url === "https://example.com/__fixture")
          await route.fulfill({
            contentType: "text/html",
            body: '<img src="https://169.254.169.254/private.png">',
          });
        else if (!allowedUrl(url)) {
          blocked = true;
          await route.abort();
        } else await route.continue();
      });
      await p.goto("https://example.com/__fixture");
      assert.equal(blocked, true);
    });
    await check("network blocks redirect without interception", async () => {
      await p.unrouteAll();
      await p.route("https://example.com/__redirect", (route) =>
        route.fulfill({
          status: 302,
          headers: { location: "https://127.0.0.1:443/" },
          body: "",
        }),
      );
      let failed = false;
      try {
        await p.goto("https://example.com/__redirect", { timeout: 4000 });
      } catch {
        failed = true;
      }
      assert.equal(failed, true);
    });
    await check("network blocks subresource without interception", async () => {
      await p.unrouteAll();
      let failed = false;
      p.on("requestfailed", request => { if (request.url().startsWith("https://169.254.169.254/")) failed = true; });
      await p.route("https://example.com/__fixture", route => route.fulfill({contentType:"text/html",body:'<img src="https://169.254.169.254/private.png">'}));
      await p.goto("https://example.com/__fixture");
      assert.equal(failed, true);
    });
  }
} finally {
  await browser?.close();
  console.table(rows);
  if (rows.some((r) => r.result === "FAIL")) process.exitCode = 1;
}

