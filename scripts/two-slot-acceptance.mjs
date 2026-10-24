import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.BROWSER_ACCEPTANCE_URL ?? 'http://127.0.0.1:48131/integration';
const key = process.env.BROWSER_INTEGRATION_KEY;
assert(key && key.length >= 43, 'BROWSER_INTEGRATION_KEY must contain at least 43 characters');
const evidence = { startedAt: new Date().toISOString(), checks: [] };
const assertion = (op, subject, activityId, body = {}, control = {}) => {
  const claim = { aud: 'zvonok-browser', exp: Date.now() + 10000, nonce: randomUUID(), activityId, subject, op, body, epoch: control.epoch ?? '', generation: control.generation ?? '' };
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};
async function command(op, subject, activityId, body, control) {
  const response = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assertion: assertion(op, subject, activityId, body, control) }), signal: AbortSignal.timeout(25000) });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}
async function checked(op, subject, activityId, body, control) {
  const { response, data } = await command(op, subject, activityId, body, control);
  assert(response.ok, `${op} failed: HTTP ${response.status} ${JSON.stringify(data.error ?? data)}`);
  return data;
}
const waitFor = async (check, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.fail(`${label} did not become ready`);
};

let activityA = randomUUID(), activityB = randomUUID(), sessionA, sessionB;
try {
  const [createdA, createdB] = await Promise.all([
    checked('create', '1', activityA), checked('create', '2', activityB),
  ]);
  sessionA = createdA.sessionId; sessionB = createdB.sessionId;
  let controlA = { epoch: createdA.collaboration.epoch, generation: createdA.collaboration.generation };
  let controlB = { epoch: createdB.collaboration.epoch, generation: createdB.collaboration.generation };
  assert(sessionA && sessionB && sessionA !== sessionB, 'sessions must have distinct IDs');
  assert(createdA.media?.epoch && createdB.media?.epoch && createdA.media.epoch !== createdB.media.epoch, 'sessions must have distinct media epochs');
  assert(createdA.media?.room && createdB.media?.room && createdA.media.room !== createdB.media.room, 'sessions must bind distinct media rooms');
  const profiles = { '720p15': [1280,720,15], '720p30': [1280,720,30], '720p60': [1280,720,60], '1080p30': [1920,1080,30], '1080p60': [1920,1080,60] };
  const selected = profiles[createdA.media.profile];
  assert(selected && createdB.media.profile === createdA.media.profile, `both Worker slots must report the same configured quality profile: ${JSON.stringify({ profileA: createdA.media?.profile, profileB: createdB.media?.profile, sessionA, sessionB })}`);
  assert.deepEqual([createdA.media.width,createdA.media.height,createdA.media.fps], selected);
  assert.deepEqual([createdB.media.width,createdB.media.height,createdB.media.fps], selected);
  evidence.checks.push({ name: 'parallel-create-distinct-session-room-epoch-profile', pass: true, profile: createdA.media.profile, dimensions: selected.slice(0,2), fps: selected[2], sessions: [sessionA, sessionB], rooms: [createdA.media.room, createdB.media.room], epochs: [createdA.media.epoch, createdB.media.epoch] });

  const keepalive = async () => Promise.all([
    checked('keepalive', '1', activityA), checked('keepalive', '2', activityB),
    checked('heartbeat', '1', activityA, {}, controlA), checked('heartbeat', '2', activityB, {}, controlB),
  ]);
  const readyA = await waitFor(async () => { await keepalive(); const state = await checked('state', '1', activityA); return state.media?.state === 'streaming' && state.status === 'active' ? state : null; }, 'publisher slot A');
  const readyB = await waitFor(async () => { await keepalive(); const state = await checked('state', '2', activityB); return state.media?.state === 'streaming' && state.status === 'active' ? state : null; }, 'publisher slot B');
  evidence.checks.push({ name: 'both-publisher-bindings-streaming', pass: true, rooms: [readyA.media.room, readyB.media.room] });

  controlA = { epoch: readyA.collaboration.epoch, generation: readyA.collaboration.generation };
  controlB = { epoch: readyB.collaboration.epoch, generation: readyB.collaboration.generation };
  for (const [profile, [width, height, fps]] of Object.entries({ '720p30':[1280,720,30], '720p60':[1280,720,60], '1080p30':[1920,1080,30], '1080p60':[1920,1080,60] })) {
    const before = await checked('state','1',activityA);
    const changed = await checked('quality','1',activityA,{profile},controlA);
    assert.equal(changed.sessionId,sessionA,'quality change must keep the Chromium BrowserSession');
    assert.notEqual(changed.media.epoch,before.media.epoch,'quality change must create a fresh, isolated publisher epoch');
    assert.deepEqual([changed.media.profile,changed.media.width,changed.media.height,changed.media.fps],[profile,width,height,fps]);
    controlA={epoch:changed.collaboration.epoch,generation:changed.collaboration.generation};
    const streaming=await waitFor(async()=>{await keepalive();const state=await checked('state','1',activityA);return state.media?.state==='streaming'?state:null;},`publisher profile ${profile}`);
    for(let sample=0;sample<6;sample++){await keepalive();await new Promise(resolve=>setTimeout(resolve,1000));}
    const measured=await checked('state','1',activityA);
    assert.equal(measured.media?.state,'streaming',`publisher profile ${profile} must remain streaming during the encoder sampling window`);
    const stillB=await checked('state','2',activityB);
    assert.equal(stillB.sessionId,sessionB,'quality change in A must preserve B');
    assert.equal(stillB.media.state,'streaming','quality change in A must keep B media streaming');
    evidence.checks.push({name:'real-quality-rebind',pass:true,profile,dimensions:[width,height],targetFps:fps,sessionId:streaming.sessionId,epoch:streaming.media.epoch,room:streaming.media.room,otherSession:stillB.sessionId});
  }
  const balanced=await checked('quality','1',activityA,{profile:'720p30'},controlA);
  controlA={epoch:balanced.collaboration.epoch,generation:balanced.collaboration.generation};
  await waitFor(async()=>{await keepalive();const state=await checked('state','1',activityA);return state.media?.state==='streaming'?state:null;},'restored balanced profile');
  const initialTabA = readyA.tabs?.[0]?.id;
  assert(initialTabA, 'each runtime must start with a real Chromium tab');
  await Promise.all([
    checked('navigate', '1', activityA, { url: 'https://example.com/capture-fixture' }, controlA),
    checked('navigate', '2', activityB, { url: 'https://example.com' }, controlB),
  ]);
  const withNewTab = await checked('tabs/create', '1', activityA, {}, controlA);
  const createdTabA = withNewTab.tabs?.find(tab => tab.id !== initialTabA)?.id;
  assert(createdTabA && withNewTab.activeTabId === createdTabA, 'new Chromium tab must become active');
  evidence.checks.push({ name: 'real-tab-created-in-same-session', pass: true, tabIds: withNewTab.tabs.map(tab => tab.id) });
  await checked('navigate', '1', activityA, { url: 'https://example.com/capture-fixture?tab=second' }, controlA);
  const [navA, navB] = await Promise.all([checked('state', '1', activityA), checked('state', '2', activityB)]);
  assert.equal(navA.currentUrl, 'https://example.com/capture-fixture?tab=second');
  assert.equal(navB.currentUrl, 'https://example.com/');
  evidence.checks.push({ name: 'independent-navigation-state', pass: true, urls: [navA.currentUrl, navB.currentUrl] });
  const switchedA = await checked('tabs/activate', '1', activityA, { tabId: initialTabA }, controlA);
  assert.equal(switchedA.currentUrl, 'https://example.com/capture-fixture');
  const restoredA = await checked('tabs/activate', '1', activityA, { tabId: createdTabA }, controlA);
  assert.equal(restoredA.currentUrl, 'https://example.com/capture-fixture?tab=second');
  assert.equal(restoredA.tabs?.length, 2);
  evidence.checks.push({ name: 'real-tab-switch-preserves-page-state', pass: true, urls: restoredA.tabs.map(tab => tab.url) });

  const cross = await command('state', '1', activityB);
  assert.equal(cross.response.status, 403, 'call A must not inspect activity B');
  evidence.checks.push({ name: 'cross-call-api-denied', pass: true, status: cross.response.status });

  await checked('close', '1', activityA);
  const stillB = await checked('state', '2', activityB);
  assert.equal(stillB.status, 'active', 'closing activity A must leave B active');
  evidence.checks.push({ name: 'close-a-preserves-b', pass: true, sessionB: stillB.sessionId, statusB: stillB.status });
  await checked('close', '2', activityB);
  evidence.checks.push({ name: 'close-b', pass: true });
  const replacementActivity = randomUUID();
  try {
    const replacement = await checked('create', '1', replacementActivity);
    assert(replacement.sessionId && replacement.sessionId !== sessionA && replacement.sessionId !== sessionB);
    assert.equal(replacement.media?.profile, createdA.media.profile, 'a reused Worker slot must return to its configured default quality');
    evidence.checks.push({ name: 'released-slot-reused-with-new-runtime', pass: true, sessionId: replacement.sessionId, profile: replacement.media.profile });
  } finally {
    await checked('close', '1', replacementActivity);
  }
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (sessionA) await command('close', '1', activityA).catch(() => {});
  if (sessionB) await command('close', '2', activityB).catch(() => {});
  evidence.finishedAt = new Date().toISOString();
  const resultPath = process.env.BROWSER_ACCEPTANCE_RESULTS ?? 'artifacts/stages/two-slot-acceptance/results.json';
  await mkdir('artifacts/stages/two-slot-acceptance', { recursive: true });
  await writeFile(resultPath, JSON.stringify(evidence, null, 2) + '\n');
}
