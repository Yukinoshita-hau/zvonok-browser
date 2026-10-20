import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
const dir = await mkdtemp(`${tmpdir()}/capture-`);
let browser, xvfb;
try {
  assert.notEqual(process.getuid(), 0);
  xvfb = spawn('Xvfb', [':91', '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], {stdio:'inherit'});
  // Xvfb abstract socket stays inside this container's private network namespace.
  await sleep(1000);
  assert.equal(xvfb.exitCode, null, 'private Xvfb failed');
  browser = await chromium.launch({headless:false, channel:'chromium', chromiumSandbox:true,
    env:{...process.env, DISPLAY:':91', XDG_CONFIG_HOME:dir, XDG_CACHE_HOME:dir},
    args:['--disable-quic','--deny-permission-prompts'], timeout:15000});
  const page = await browser.newPage({viewport:{width:1280,height:720}});
  await page.goto('chrome://sandbox');
  const status = await page.locator('body').innerText();
  console.log(status);
  assert.match(status,/Layer 1 Sandbox\s+Namespace/);
  assert.match(status,/Seccomp-BPF sandbox\s+Yes/);
  console.log('HEADFUL_SANDBOX_PASS');
} finally {
  await browser?.close();
  xvfb?.kill('SIGTERM');
  await rm(dir,{recursive:true,force:true});
}

