# Slice 2B.2 — Unified BrowserSession and Live Chromium

Date: 2026-10-21, Asia/Yekaterinburg. Local DEV_TOKEN owner PoC only. **Unified session functionality is implemented and verified; full Slice2B.2 acceptance is not PASS because a measured loaded720p15 run failed the FPS threshold.**

## Architecture and ownership

Dedicated `compose.session.yaml`, project `zvonok-browser-session`, gateway http://127.0.0.1:48031. Existing Slice 0–1, 2A and experimental 2B.1 projects retain their networks, volumes and images. No Core service changes.

One Worker-owned persistent Chromium context supplies Playwright navigation/input/PNG and X11 pixels. Each BrowserSession owns a fresh `/tmp/session-profile-*`, Xauthority cookie, private Xvfb :91, FFmpeg and random media epoch. Chromium uses UID1000, chromiumSandbox:true, existing seccomp, restricted proxy and guard namespace. Runtime chrome://sandbox assertions run inside the same Chromium before user navigation. Internal fixed CDP window-bounds calls do not expose a CDP listener.

Worker → private lifecycle socket → Broker → LiveKit room administration. API → authenticated owner/session-bound viewer request → Broker. FFmpeg → bounded epoch-specific RGBA socket → Publisher → LiveKit → React/WebRTC. API → private control socket → Worker → same Chromium. Chromium → guard → restricted proxy → allowed HTTPS.

Worker and broker alone mount binding IPC. Publisher never mounts control or binding IPC; Worker never mounts LiveKit keys/auth IPC. Broker and LiveKit alone mount a newly generated ignored local key. Existing same-UID compromised-browser limitation remains: Chromium, Worker and capture are not separate OS principals. This is not production multi-user isolation.

## Lifecycle and authorization

Compatible browser statuses: `creating → active → closing → closed`, with `crashed`/`expired` terminal alternatives. `browserReady` is independent from `media.state`: `starting → streaming ↔ media_reconnecting → closed`. Active means browser/input ready, not media ready. React additionally requires recent decoded callbacks before displaying video.

Creation binds `{sessionId, ownerId, epoch, expiresAt}`, starts private display and one Chromium, verifies sandbox/geometry, then starts capture. Publisher supervisor waits for an active binding and requests a publish-camera/no-subscribe/no-data JWT. Each epoch has room `browser-<random UUID>`, identity `publisher-<epoch>` and socket `/frames/<epoch>.sock`. Publisher restart reuses that binding and never creates Chromium.

Worker renews a lease once/second. Broker denies authorization after four seconds without renewal or absolute expiry and deletes the room. Broker journals room identity on private binding storage and deletes the previous room on startup before accepting new bindings. New binding is forbidden until old room deletion succeeds. Failed deletion stays quarantined; Worker exits instead of admitting another session beside incomplete cleanup.

DELETE/TTL/crash stop capture/in-flight frames, revoke authorization, delete LiveKit room, close Chromium, reap FFmpeg/Xvfb and remove the profile including XDG cache/config. Publisher disconnects after two seconds of source loss. Epoch sockets and monotonic sequence/fresh timestamp checks reject old-source/replay admission. No frames are retained for the next session.

Five-minute JWT TTL limits admission; established viewers are disconnected by server deleteRoom. A still-valid old token could rejoin its old empty room, but cannot access the next epoch. DEV_TOKEN maps only to local-owner and is not production multi-user authentication.

## React and coordinates

Existing React source selects unified mode on dedicated port48031; original PNG client and 2A viewer remain available. URL, Back/Forward/Reload, session/media states and End surround one video surface. PNG diagnostics explicitly replaces video and requests frames only on demand. No PNG polling for playback.

Contain mapping computes the rendered 1280×720 rectangle, subtracts letterbox offsets, scales to fixed server CSS pixels and rejects points outside the image. Client resize never changes the server viewport. MouseMove is throttled; left/middle/right click, wheel line/page conversion, text/paste and original key allowlist retain protocol semantics. Command queues are bounded; overload is visible. No drag/drop or IME protocol extension.

SDK reconnect and four bounded fresh-token retries preserve BrowserSession; manual reconnect renews the budget. Missing frames hide stale video behind explicit state. Unsubscribe/terminal status/DELETE/unmount detach tracks, clear srcObject and disconnect.

## Geometry and resource bounds

Xvfb1281×721; app1280×720 at0,0; DPR1; capture1280×720. Eight exact raw edge/corner colors are asserted on a controlled real-Chromium fixture. Default15FPS;30 only explicit MEDIA_FPS=30. No1080p work or disabled WebRTC adaptation.

Capture has one assembling, pending and in-flight frame; publisher has one connection/body/pending frame and one scheduled pump. New pending frames replace old ones. Maximum body1280×720×4+24, exact dimensions, finite/fresh timestamp and increasing sequence. Fastify never transports video. Native allocations and GC add memory; no zero-copy claim.

Limits: Worker/capture2CPU/1024MiB/256PIDs, tmpfs512MiB, shm256MiB; publisher2CPU/512MiB/128PIDs; LiveKit2CPU/512MiB/128PIDs; API0.5CPU/128MiB/64PIDs; proxy0.5CPU/128MiB/64PIDs; guard32MiB/16PIDs; client128MiB/32PIDs. Preserved measured capture limits, not a VPS capacity estimate.

## Files and reproduction

Changed `.dockerignore`, `apps/api/src/index.ts`, `apps/worker/src/index.ts` plus new `surface.ts`, `packages/protocol/src/index.ts`, `apps/client/src/main.tsx`/`style.css` plus new `LiveBrowser.tsx`/`coordinates.ts`/`coordinates.test.ts`, `vitest.config.ts`, README and architecture/security documentation. Added `compose.session.yaml`, `session/` broker/publisher/supervisor/frame validation and tests, fixture, guard/nginx/relay, Docker definitions, startup and acceptance scripts. Existing dirty2B.1.1 experiment work and historical failed artifacts were preserved. Original Dockerfile remains functionally unchanged. No dependencies were added.

Session Dockerfiles reuse existing local baseline images and installed dependencies. Ignored `session/livekit.local.yaml` derives from the example with a new random development key and TCP48034/UDP48035. No production credentials.

```powershell
npm.cmd run build
npm.cmd test
docker --context desktop-linux compose -f compose.session.yaml build
docker --context desktop-linux compose -f compose.session.yaml up -d --no-build
# Or generate the local key and start via: pwsh -File session/up.ps1
# Controlled fixture acceptance only:
$env:BROWSER_FIXTURE='1'
docker --context desktop-linux compose -f compose.session.yaml up -d --no-build
node session/e2e.mjs
node session/lifecycle.mjs
node session/security.mjs
node session/regression.mjs
node session/reliability.mjs
```

All campaigns run sequentially and generate distinct artifact directories. Stop only this project with `docker --context desktop-linux compose -f compose.session.yaml down`, without volume deletion.

## Measurements and acceptance

All tests ran sequentially. Actual Chromium pixels, native LiveKit publication and receiver framesDecoded were used; screenshots are only supporting UI evidence.

| Campaign | Decode FPS / window | Sampled dimensions | Decoder drops delta | Result |
| --- | --- | --- | --- | --- |
| Initial functional15 | 15.01 /34.50s |1280×720|0|PASS|
| Full functional15 |14.87 /34.50s|1280×720|0|PASS|
|15 with seven Docker resource snapshots |14.13 /101.50s|1280×720|78|**FAIL <14.25**|
|15 controlled repeat without periodic Docker polling |14.77 /65.00s|1280×720|0|PASS|
|30 explicit opt-in, best effort |28.17 /34.50s|1280×720|0|PASS current28.0 criterion, short window|

The loaded failure remains a failure. Capture replacement counters were zero in its measured source interval; receiver decoder drops were observed. Resource polling/host contention is a possible contributor, not a demonstrated cause. No WebRTC adaptation was disabled and no quotas were raised to pass. Repeatability under varying host load remains a limitation; short30FPS success is not a sustained capacity claim.

Input-to-observed-pixel,20 sequential real clicks/profile:15FPS p50/p95 **247/259ms**;30FPS **251/370ms**. Host monotonic elapsed time includes client dispatch, HTTP input queue, Playwright, capture/IPC/encode/WebRTC/decode, polling up to100ms and observation transport. It is a harness upper bound, not scanout or calibrated per-stage latency. The loaded campaign's separate20-input p50/p95 was240/254ms, before its steady resource window; do not conflate those windows.

Seven loaded15FPS resource snapshots; Docker CPU100%=one logical CPU. Last memory is working set, not peak RSS; PIDs include threads. These samples belong to the failed performance campaign and are retained as such.

| Component | Mean / max sampled CPU% | Last memory | Max PIDs |
| --- | --- | --- | --- |
| Worker: Chromium + Xvfb + capture |60.82 /71.76|435.9MiB /1GiB|141|
| Publisher |28.13 /35.42|151.5MiB /512MiB|37|
| LiveKit |1.56 /1.86|69.83MiB /512MiB|18|
| API |0.38 /1.09|38.6MiB /128MiB|12|
| Proxy |0.03 /0.12|21.15MiB /128MiB|12|
| Guard |1.31 /3.42|412KiB /32MiB|1|
| Broker |1.69 /7.79|24.71MiB /128MiB|18|

Windows sample:2,325,140KiB free physical of16,118,076KiB;8,697,848KiB free virtual of43,551,380KiB. VM samples include /proc/pressure/memory and MemAvailable (~4.1GiB in the first sample); no claim about an isolated host peak or per-process GPU/encoder cost. Native SDK software encoder remains libvpx/VP8.

| Check | Result | Evidence |
| --- | --- | --- |
| Build / unit |PASS|TypeScript/Vite;5files/10tests; existing bundle-size warning|
| Real session create/navigation/back/forward/reload/input/live frames |PASS|Both final15/30 E2E campaigns|
| Coordinate mapping, narrow resize/letterbox |PASS|Unit checks plus actual React/Chromium pixel effects|
| Raw geometry and same Chromium |PASS|8raw-edge assertions, runtime sandbox, input changes in live decoded page|
| PNG excluded from primary playback |PASS|0frame requests in final E2E; diagnostic PNG separately accepted|
| Viewer reconnect / publisher restart |PASS|Fresh decoded fixture clock resumes without another BrowserSession|
| A→DELETE→B old viewer isolation |PASS|Old srcObject cleared/no new decoded frames while B receives new video; old authorization rejected|
| DELETE/FFmpeg crash/renderer crash/shutdown/idle/absolute TTL |PASS|Real process/profile checks; final lifecycle7/7 includes publisher SIGKILL|
| Publisher SIGKILL |PASS|Supervisor recovers streaming state on same session/epoch|
| Runtime sandbox, guard, private X11, JWT/mounts, direct LiveKit denial |PASS|Final security8/8; payload size/geometry/time/replay unit validation|
| Original15-check API on integrated Worker |PASS|15/15 with capture running, including positive allowed HTTPS|
| Original network/browser harness |PASS|17/17 network,9/9 browser|
| Session network, including TLS-positive path |PASS|17/17 alone and again during active capture|
| Proxy outage/retry |PASS|/ready503 and navigation503 while proxy down; BrowserSession retained; recovery same session|
| Navigation reset/timeout classification |PASS|Real Playwright connectionreset and12s TimeoutError on fixed trusted HTTPS-origin fixtures, followed by successful navigation on same session; no security exceptions|
| Original2A native media regression |PASS|65samples/64.625s,14.59decodedFPS,0drops/PNG requests/page errors, disconnect/reconnect; source/publisher restored stopped|
| Public HTTPS through unified React without acceptance fixtures |PASS|Actual example.com navigation, advancing decoded frames,0PNG requests, DELETE removes video|
| Old experimental input schema |PASS|node --test experiments/capture/input-control.test.mjs|
| Original long2B.1 performance campaign rerun |NOT RUN|Replaced for this slice by real BrowserSession campaigns; original experiment sources preserved|
| Original lifecycle-check.ps1 separately rerun |NOT RUN|Its DELETE/idle/absolute/crash/shutdown scenarios exercised through dedicated integrated lifecycle7/7 instead|
| Host/VPS sustained load,1080p/audio/multi-user/Core |NOT RUN|Outside this slice|

Main evidence under `artifacts/`: `session-2026-10-20T22-51-24-449Z` (loadedFAIL), `session-2026-10-20T22-55-24-653Z` (final15), `session-2026-10-20T22-57-50-255Z` (30), `session-lifecycle-1792537160677`, `session-security-1792536620603`, `session-regression-1792536434030`, final `session-reliability-1792537482551`, `media-session-integration-20261021.json/.png`. Earlier `session-reliability-1792537261486` timed pause did not reproduce an upstream navigation failure; it recorded HTTP200/NOT_REPRODUCED and is not evidence for the timeout branch. Final controlled fault fixtures provide that evidence. The original2A regression uses its existing viewer deployment; new unified React is covered independently by the BrowserSession campaigns.

Six separate screenshots in `artifacts/session-2026-10-20T22-55-24-653Z/`: `01-session-created.png`, `02-live-website.png`, `03-text-typed.png`, `04-scrolled.png`, `05-media-reconnect.png`, `06-session-ended.png`. The primary evidence is decoded frames and changing pixel content, not these screenshots. Controlled fixture pages are real sandboxed Chromium rendering, not a synthetic media generator. Actual public HTTPS navigation is checked separately.

Additional ordinary-mode evidence: `artifacts/session-public-1792537557415/results.json` and `public-live.png`; `node session/public-check.mjs` reproduces the short external-site React/live/DELETE smoke with BROWSER_FIXTURE=0. The final system is left idle at http://127.0.0.1:48031 with default15FPS and fixtures disabled, ready for manual create. No BrowserSession remains active. Worker process listing contains only init/Node (plus the diagnostic ps); `/tmp/session-profile-*` and `/frames` are empty. Generated2A source/publisher were restored to their original stopped state. No detached acceptance browsers, future automations or ongoing FPS research remain.

## Retained failures and Slice3 blockers

Historical 2B.1/2B.1.1 failures remain: original720p30 28.5 threshold, old503/incomplete publisher-stop evidence and old HTTPS failures. Current product28.0 threshold does not relabel historical gates.

Current debug failures are retained: empty JSON content-type body400; watchdog starting before Chromium startup; about:blank app launch capturing browser chrome/raw-edge failure; timestamp read after detach in restart test; reload preserving scroll before latency clicks; gateway readiness race; extra IPC writer colliding with occupied single-connection limit. Root fixes/harness corrections are distinguished by final evidence below.

Known startup races in new acceptance harnesses were addressed by waiting for actual /ready after container recreation, including after restoring Worker from TTL overrides and after restarting proxy. They do not establish the root cause of historical503 responses. Current proxy/capture/API suites pass without disabling TLS, widening CONNECT rules, bypassing proxy or disabling firewall. One loaded FPS failure remains an explicit acceptance limit.

Fixtures are strictly local opt-in `BROWSER_FIXTURE=1`: a fixed page, a fixed connection-reset URL and a fixed13s deferred response to exercise the existing12s navigation timeout. They expose no arbitrary selector/code/shell API, do not enable other destinations and are disabled for ordinary use.

Slice3 blockers: production identity/ownership; stronger isolation against same-UID browser compromise; authenticated remote deployment; target-hardware resource sizing; wider crash/network campaigns and upstream reliability. No shared control, audio, Core integration, security relaxation, Docker prune, Git reset or commit.
