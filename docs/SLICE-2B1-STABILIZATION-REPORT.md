# Slice 2B.1.1 — capture performance, input latency and reliability gate

Date: 2026-10-21 (Asia/Yekaterinburg). Scope: local Docker Desktop experiment only. **Slice 2B.2 is NOT STARTED.** Final acceptance results and the decision are below; historical failures remain part of the evidence.

## 1. Baseline and protected systems

User-approved source-only baseline: commit `50f3bd6`, branch `codex/slice-2b1-stabilization`, 82 files total: 81 paths listed in `docs/SLICE-2B1-BASELINE-FILES.txt` plus the manifest itself. No remote publication. `.env`, both local LiveKit key files, dependencies, builds, logs, screenshots/recordings and temporary profiles are excluded. A value-based scan of tracked sources against the actual local development secrets found no matches. This is a local scan, not a general secret-scanner certification.

Original API, Worker, protocol, proxy, guard and seccomp SHA-256 hashes still match the saved pre-change snapshot (`artifacts/final-protected-hashes.json`). Original generated-media source and React code are unchanged. No Core Zvonok repository, network or credentials were changed. A pre-experiment Git history did not exist; hash verification establishes preservation during this task, not independent reconstruction of older source history.

Resume snapshot: `artifacts/20261021-resume-source.patch`, `*-source-hashes.json`, `*-state.txt`, `*-prior-logs.txt`. Final filtered image/mount/security settings: `artifacts/final-security-config.txt`. Snapshot excludes environment secrets. Historical failed JSON/logs/screenshots were not deleted or overwritten.

## 2. Changed files and actual scope

- `.gitignore` and baseline manifest: source-only baseline exclusions.
- `compose.capture.yaml`: explicit experiment-only buffer reuse and public-preflight switches; CPU/RAM quotas unchanged.
- `experiments/capture/run.mjs`: three-buffer source pool behind `CAPTURE_REUSE`, GC/event-loop diagnostics, private input service, idle expiry, exact native window geometry and raw-edge assertions; fresh cookie/storage checks; bounded IPC response-error handling.
- `experiments/capture/publisher.mjs`: monotonic source-loss detection and an explicit source-lost diagnostic. Two-second threshold, immediate latest-frame pump, native SDK and VP8 settings retained.
- `experiments/capture/fixture.html`: action counter barcode, controlled scrolling and eight edge/corner markers; fixture scrollbar hidden.
- `input-control.mjs`, `input-bridge.mjs`, `input-control.test.mjs`: bounded authenticated local benchmark command path and schema checks.
- `gate-check.mjs`, `gate-runs.ps1`, `gate-summary.mjs`: independent steady windows, counters/resources, latency and retained error evidence.
- `gate-lifecycle.mjs`, `gate-api.mjs`, `gate-finish.ps1`, `security-check.mjs`: local acceptance campaigns. `recovery-check.mjs` writes distinct campaign files instead of overwriting historical recovery evidence.
- `network-check.mjs`: experiment-only positive-HTTPS probe has a finite overall deadline and close handler, so abrupt upstream closure cannot leave the test pending forever. Original `scripts/network-check.mjs` remains unchanged.
- This report. No optimization was copied into `media/publisher.mjs` or the original Worker/API.

## 3. Conditions and acceptance method

X11/Xvfb, real non-root headful Chromium, RGBA IPC, VP8/libvpx, requested app/viewport 1280×720, DPR1. Capture: 2 CPUs / 1024 MiB / 256 PIDs; publisher: 2 CPUs / 512 MiB / 128 PIDs. FFmpeg codec/filter thread counts are one. Bitrate ceiling 3 Mbps, simulcast false; WebRTC adaptation remains enabled. Docker CPU 100% means one logical CPU.

Final long runs were sequential with no competing frontend browser test started by this task. Generated-media source/publisher were stopped. Existing Core containers remained running and were not stopped or reconfigured. No claim that Windows host/user activity was fully controlled. Hardware/runtime are the previously documented Ryzen 5600H / Docker Desktop / WSL2 environment, not a VPS capacity estimate.

Each final run recreates capture and publisher, warms up past 30 decoded frames plus three seconds, then samples for 95 seconds. First-to-last receiver windows are about 94 seconds, all individually within the requested 90–120 seconds. Actual resolution is recorded at each receiver sample; sub-second unsampled resolution changes cannot be excluded. Source/publisher rates use overlapping five-second log windows, not identical receiver endpoints. Do not subtract frame counts across those windows. Manual reconnect/restart is covered separately at 720p15, not inside every steady window.

Performance runs use the controlled fixture with `CAPTURE_PUBLIC_CHECK=0`, explicitly separating external-site availability from steady media measurement. Public navigation/network/browser checks run separately. Two resumed public preflights failed at example.com with `ERR_EMPTY_RESPONSE`; logs are retained in `artifacts/resume-geometry2*-failed.log`. They are startup failures, not successful FPS attempts.

## 4. Historical failures, A/B and final FPS

Earlier Slice 2B.1: 720p15 13.91 FAIL; 14.41 PASS in one sustained attempt; short smoke 12.51 FAIL. Original 720p30 immediate: capture 30.01 → submit 28.54 → publish 25.50 → decode 25.28, including 960×540/640×360 adaptation: FAIL.

The first stabilization campaign retained: 15 baseline 14.79 PASS; pool attempts 13.57 FAIL/input timeout, publisher-stop FAIL with incomplete logs, 13.33 FAIL. At 30: baseline 24.36 FAIL/adapted; pool 29.71 and 29.44 PASS at 1280×720. Those successes do not replace the later failures below.

| Attempt | Window s | Capture | Submit | Native sent | Decode | Dimensions | Steady replacements source/publisher | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 15-baseline | 94.25 | 15.00 | 14.99 | 14.88 | 14.79 | 1280x720 | 0/0 | PASS |
| 15-pool-1 | 94.27 | 15.00 | 14.39 | 13.48 | 13.57 | 1280x720 | 53/0 | FAIL |
| 15-pool-3 | 94.30 | 15.01 | 14.44 | 13.26 | 13.33 | 1280x720 | 49/0 | FAIL |
| 30-baseline | 94.12 | 30.02 | 27.61 | 24.31 | 24.36 | 1280x720, 960x540, 640x360 | 217/0 | FAIL |
| 30-pool-1 | 94.46 | 30.01 | 30.00 | 29.85 | 29.71 | 1280x720 | 1/0 | PASS |
| 30-pool-2 | 94.33 | 30.00 | 29.92 | 29.49 | 29.44 | 1280x720 | 6/0 | PASS |
| final15-1 | 94.44 | 15.00 | 15.00 | 14.98 | 14.91 | 1280x720 | 0/0 | PASS |
| final15-2 | 94.27 | 15.00 | 15.00 | 14.99 | 14.95 | 1280x720 | 0/0 | PASS |
| final15-3 | 94.50 | 15.00 | 15.00 | 15.00 | 14.92 | 1280x720 | 0/0 | PASS |
| final30-1 | 94.73 | 30.01 | 29.59 | 28.57 | 28.42 | 1280x720 | 39/0 | FAIL |
| final30-2 | 94.29 | 30.01 | 29.93 | 29.23 | 29.06 | 1280x720 | 7/0 | PASS |

Pool-15 attempt 2: FAIL, publisher not running; no completed JSON receiver window. The separate `latency-final15` five-second setup window is not a sustained FPS acceptance attempt.

Three final 720p15 attempts each exceed 14.25 decoded FPS at constant sampled 1280×720: **repeatability PASS for this campaign**. Final 720p30 has one attempt below 28.5: **repeatability FAIL**, irrespective of the successful attempts. No averaging a failed attempt into a PASS.

## 5. Bottleneck localization, buffers and scheduler

The source owns exactly three RGBA buffers when reuse is enabled: assembling, latest pending and in-flight HTTP body. An overwritten pending buffer returns to the pool; in-flight pixels return only after completion/error. Publisher assembles its own `Buffer.concat` before acknowledging and constructs its native frame from that separate storage. Source reuse therefore does not reuse the publisher's backing array. It is not zero-copy; publisher body assembly and native conversion/copy remain.

One pending source and publisher frame, one source request, one scheduled publisher `setImmediate`: no application FIFO growth. Capture continues at target while replacement counters account for upstream loss. The two-second watchdog intentionally unpublishes on lost input; threshold was not raised. Its old wall-clock dependency was replaced with `performance.now()` and the gap/counters are logged. A response-stream error now takes the same single completion path as request error, preventing a retained busy/in-flight slot on that error path.

The old failed pool-15 attempts had 53/49 steady source replacements, capture cgroup throttling 3.36/4.32 seconds and event-loop maxima about 457/401 ms. Publisher replacements were zero, and native quality reason was NONE. This locates losses before submit and between native submit/send; it does **not** prove the pool intrinsically breaks 15 FPS. Final pool-15 attempts have zero steady source/publisher replacements and no capture throttling. Both profiles can function with the pool. Changing host contention, fixture/geometry and timing means the final campaign is not an isolated causal A/B proof.

Old 30 baseline: 217 replacements, GC ~3.39 seconds from startup, capture/publisher throttling ~24.40/26.06 seconds, native CPU limitation and 960×540/640×360 adaptation. Pool-30 historical passes had 1/6 steady replacements and no native CPU-limitation samples. Allocation/GC pressure and CPU quota correlate with the difference; exact attribution between them is not established.

Final failed 30 attempt: 30.01 capture → 29.59 submit → 28.57 native send → 28.42 decode, 39 source replacements, no publisher replacements or decoder drops, no sampled native adaptation reason, publisher throttling ~9.54 seconds. The final successful 30 attempt also has ~9.84 seconds publisher throttling. Throttle totals alone do not explain the pass/fail boundary. Remaining bottleneck is combined source scheduling/backpressure plus native encoder/pacer throughput under quota; not demonstrated LiveKit packet loss. Native framesSent is measured separately from captureFrame calls.

Xvfb compositing, x11grab and RGBA conversion occur before the frame-availability header and are not separately timestamped. Raw assembly includes copies; Unix IPC ack and header-to-submit are sampled diagnostics. VideoFrame construction plus captureFrame is a combined call cost. Native encode and receiver decode are aggregate means, not per-action stages. Forwarding delay cannot be isolated by subtracting those overlapping values. Controlled forced 960×540/640×360 profiles: NOT RUN; historical automatic adaptation at those resolutions is recorded, not treated as fixed-resolution acceptance.

The historical pool attempt where publisher stopped lacks its terminal source/publisher logs because an unhandled resource-collector rejection terminated the old harness. Its cause remains **unproven** (source-loss watchdog, process failure and startup/dependency failure cannot be distinguished retrospectively). New collector errors are retained instead of aborting evidence collection; new source-loss diagnostics improve future attribution. It is not relabeled a fixed known bug.

| Final attempt | Capture CPU mean/max %; last working set | Publisher CPU mean/max %; last working set | Throttle delta capture/publisher ms | Capture GC delta ms; event-loop max ms |
| --- | --- | --- | --- | --- |
| final15-1 | 38.87/60.80; 367.5MiB / 1GiB | 16.51/19.87; 134MiB / 512MiB | 0.00/1369.94 | 328.45; 69.80 |
| final15-2 | 43.11/55.96; 357.3MiB / 1GiB | 27.78/62.16; 145.8MiB / 512MiB | 0.00/511.92 | 382.96; 61.37 |
| final15-3 | 47.82/74.51; 359.4MiB / 1GiB | 48.30/74.72; 104MiB / 512MiB | 0.00/808.51 | 327.61; 49.15 |
| final30-1 | 76.72/104.98; 371.4MiB / 1GiB | 49.40/71.03; 142MiB / 512MiB | 604.43/9540.82 | 857.46; 206.70 |
| final30-2 | 80.03/100.52; 370.5MiB / 1GiB | 86.54/174.16; 118MiB / 512MiB | 637.08/9840.97 | 795.21; 59.05 |

Ten resource snapshots per run; sampled maxima are not guaranteed peaks. No cgroup OOM events in these samples; host memory pressure is not an isolated controlled variable. Linux `/proc/pressure` is retained in raw JSON, not presented as a container-exclusive pressure measurement.

| Final attempt | TTFF ms | IPC ack p50/p95 ms | Availability→submit p50/p95 ms | VideoFrame+call p95 ms | Encode/decode mean ms | Decoder drops |
| --- | --- | --- | --- | --- | --- | --- |
| final15-1 | 2076 | 2.72/7.75 | 3.00/9.00 | 1.81 | 3.22/1.23 | 0 |
| final15-2 | 1370 | 2.82/8.79 | 4.00/11.00 | 2.24 | 3.05/1.21 | 0 |
| final15-3 | 1398 | 2.75/10.92 | 4.00/13.00 | 2.30 | 3.12/1.17 | 0 |
| final30-1 | 1576 | 3.59/16.26 | 4.00/32.00 | 2.39 | 5.34/1.52 | 0 |
| final30-2 | 1378 | 4.00/28.31 | 5.00/12.00 | 2.09 | 4.46/1.42 | 0 |

## 6. Input-to-pixel without per-action docker exec

The experimental bridge opens one `docker compose exec -T` before a readiness handshake, then reuses stdin/stdout. Startup exec cost is excluded in final measurements. Persistent Docker transport scheduling remains included. It reaches a private mode-0600 Unix socket inside capture, authenticated by a random mode-0600 tmpfs key. No TCP listener, no new egress, no LiveKit/API credentials in Chromium.

Exact JSON schema permits only one `action` property: click/type/scroll. Actual actions are fixed Playwright operations from the existing mouse/text/wheel contract. No shell/code/CDP/evaluate argument, navigation URL, arbitrary selector or command value is accepted. One busy action, finite request size and socket/time limits. Local fixed `evaluate` calls inside trusted harness code do not expose an evaluate endpoint. Same-UID compromise limitation remains.

Every steady run records 60 successful actions when complete. A separate final 100-action campaign additionally brackets the receiver's monotonic clock with host request/response timestamps. Callback latency is an interval mapped by that bracket; host-observed latency also includes polling/scheduling after the callback. This interval avoids pretending two process clocks have identical origins. It does not measure display scanout. Counter observations are visual consequences on a controlled page, not proof of the future BrowserSession control API's behavior.

| Final attempt | Actions | Host-observed p50/p95/max ms | Transport+action ack p50/p95 ms | Old per-action exec dispatch p50/p95 ms |
| --- | --- | --- | --- | --- |
| final15-1 | 60 | 199.08/269.71/406.44 | 48.52/85.66 | 287.16/331.65 |
| final15-2 | 60 | 205.46/253.37/305.33 | 46.93/87.25 | 283.04/322.44 |
| final15-3 | 60 | 204.21/244.68/258.52 | 42.97/82.39 | 317.37/379.68 |
| final30-1 | 60 | 203.15/262.79/378.93 | 49.30/87.15 | 374.93/481.13 |
| final30-2 | 60 | 349.92/693.82/2062.43 | 90.40/264.60 | 516.25/681.21 |
| latency-final15 | 100 | 198.70/269.85/309.83 | 49.29/78.66 | 271.45/306.23 |

Final 100-action callback-latency interval quantiles: p50 **193.15–194.01 ms**, p95 **264.00–264.94 ms**; maximum upper endpoint **303.32 ms**. Clock bracket width p50/p95/max **0.74/1.77/3.34 ms**. These are interval bounds from round-trip bracketing, not a symmetric confidence interval or a physical-display measurement. Nearest-rank percentiles; actions are sequential, not independent random production traffic.

Old per-action docker-exec dispatch is measured separately (five actions per run, inadequate for a stable p95). No stage is subtracted from overlapping end-to-end durations. For the 60-action steady-series numbers, host observation is an upper bound and scheduling uncertainty has no finite measured worst-case bound. The 100-action campaign supplies measured clock-bracket widths, but does not bound OS/display scheduling outside that interval.

## 7. API 503 investigation

Historical API acceptance 13 PASS / forward+reload 503 FAIL remains retained. New initial acceptance: 15/15 alone and 15/15 with capture. Resume navigation campaign recorded three separate create → navigate → navigate → back → forward → reload → delete histories with session/readiness observations after each action (`artifacts/gate-api-capture.json`). All responses in that campaign succeeded.

Code inspection distinguishes original Worker `DEPENDENCIES_UNAVAILABLE` (guard/proxy readiness) from API `WORKER_UNAVAILABLE` (socket/request error). Worker navigation timeout, queue, cleanup deadline and API socket timeout are distinct paths. Historical status-only evidence cannot identify which caused those two 503s. Resource contention is plausible, not a proven root cause. No original timeout, readiness, gateway route or Worker/API implementation was changed. Current acceptance PASS is not a historical root-cause PASS.

Final alone: **15/15 PASS**. Final capture-active first attempt: **7 PASS / 8 FAIL**: example navigation 502, then inactive-session 409 cascades. Timeline records first browser action failure after **12369.51 ms**, error code `BROWSER_ACTION_FAILED`, with subsequent session `crashed` and ready responses 200. This identifies the navigation/cleanup path, not the exact upstream browser error; the Worker intentionally does not expose its original error text. Later histories and a distinct full capture-active retry **15/15 PASS** are retained beside the failure (`final-api-capture-retry.txt`). No reproduced 503, no proven historical 503 root cause.

The capture positive-HTTPS probe hung once and then reported FAIL in two bounded attempts, while its 16 deny checks passed. A separate allowed-origin diagnostic from the proxy completed TLS/HTTP to both then-resolved public IPv4 addresses (8.47.69.0 and 8.6.112.0). This does not isolate whether the remaining probe failure is in capture-to-proxy transport, upstream timing or the probe's TLS/close handling. It is a failed acceptance probe, not proof of an egress bypass or a permanently unreachable origin. Preserve and instrument CONNECT/TLS/HTTP/close events before changing either proxy policy or timeouts.

## 8. TTL, crashes, cleanup, profiles and epochs

Controlled campaigns use only dedicated capture containers. Every attempt has a distinct source log and state record, saved before removal. Normal DELETE-equivalent and idle/absolute TTL must exit zero; intentional Chrome/FFmpeg kills can exit nonzero. Capture and publisher must both reach PID0. This establishes no surviving process tree in those stopped PID namespaces; it is not actual BrowserSession lifecycle integration.

Each recreated capture has a private tmpfs profile and Xauthority. The final lifecycle build asserts fresh cookies/localStorage, then seeds both with a profile marker; its next recreation repeats the empty-storage assertion. That build adds startup/storage assertions and IPC response-error handling after the long FPS image; those changes do not change the normal steady frame path. Image IDs are retained separately. Image/source differences are explicit, not an identical-image claim.

| Scenario | Attempts | Result |
| --- | --- | --- |
| delete | 3/3 | PASS |
| browser-crash | 3/3 | PASS |
| ffmpeg-crash | 3/3 | PASS |
| publisher-crash | 3/3 | PASS |
| idle | 3/3 | PASS |
| ttl | 3/3 | PASS |

Absolute TTL 30 s, idle 25 s (including startup); all normal expiry/delete exits zero and all stopped capture/publisher PIDs zero. Source logs and states are retained per attempt in `artifacts/gate-lifecycle-final/`. This first campaign saved source logs and publisher state, not separate per-attempt publisher stdout; the harness now also saves publisher stdout on future runs. Three distinct recovery/epoch campaigns each PASS publisher restart, old-viewer freeze/new-room pixels and wrong-viewer/subscription-only authorization. `artifacts/capture-recovery-final-{1,2,3}.json`. Frame socket removal after shutdown PASS (`final-frame-socket.txt`). Per-FPS-window manual reconnect and 30-FPS recovery campaign: NOT RUN.

Historical intermediate TTL FAIL is preserved in `artifacts/capture-lifecycle.json`; new repetitions do not recover missing historical evidence. Publisher restart and new broker-room epochs are checked with a real receiver; an old viewer must remain frozen while a newly authorized viewer receives fresh pixels. Fresh profile isolation and room epoch isolation are separate properties.

## 9. Pixel-perfect geometry

Original emulated inner viewport/DPR reported 1280×720/1 while native app window was 1279×719. Raw X11 capture had black x=1279 and y=719: a real native window deficit. Merely requesting Browser.setWindowBounds on a 1280×720 Xvfb screen still returned 1279×719. Removing kiosk alone did not fix that clamp.

Fix: private Xvfb virtual screen is explicitly **1281×721**, app window state is normal, native bounds explicitly **0,0,1280,720**; emulated viewport remains 1280×720/DPR1. FFmpeg region remains exactly **1280×720 at +0,0**. One outside desktop row/column is intentionally outside the app rectangle. This is native window sizing inside a larger display, not padding/scaling/cropping a deficient source frame. No FFmpeg scale filter on the X11 path.

The controlled fixture hides its scrollbar to make its right-edge marker visible; this is fixture styling, not a capture geometry correction. Raw sampled RGBA matches exactly: left orange (255,128,0), right blue (0,128,255), top magenta, bottom cyan; corners red/green/blue/yellow. Eight assertions run on the first assembled frame. All final long runs pass them; decoded samples also preserve resolution. Browser chrome cannot occupy those asserted edge pixels. VP8 edge colors need not be bit-exact after lossy encode; acceptance of pixel-exact boundaries uses raw pixels before encode.

## 10. Security and final matrix

Chromium remains UID1000 with actual namespace/PID/network namespaces and Seccomp-BPF verified per launch. No --no-sandbox, new browser capabilities, Docker socket, host mounts, public X11 or browser credentials. Existing default-deny IPv4/IPv6 guard and restricted proxy stay in place. Xauthority remains private; actual display :91 means its TCP port would be **6091**, not 6000. Test checks the actual listener table and denied no-cookie access.

JWT viewer subscribe-only / no data/no publish, unique room per broker epoch, publisher fixed identity/camera-source publish-only. Loopback-only viewer/signaling/encrypted RTC relay. Raw frame IPC remains bounded with original dimension/length/timestamp validation. No Core connections. Same-UID compromised-browser access to harness state is still outside the demonstrated isolation boundary. No production isolation PASS is claimed.

| Check | Result | Evidence / boundary |
| --- | --- | --- |
| Build / unit / input schema | PASS | TypeScript/Vite; 2 files / 3 unit tests; schema assertions; existing bundle-size warning |
| Original API alone | PASS | 15/15 final |
| API with capture | FAIL, then retry PASS | 7/15 first; 15/15 retry; retain both |
| Historical 503 cause | FAIL / unresolved | Not reproduced; status-only old evidence insufficient |
| Original network / browser | PASS | 17/17; 9/9 final |
| Capture network deny checks | PASS | 16/16, actual IPv4/IPv6 OUTPUT DROP retained |
| Capture positive HTTPS | FAIL | Bounded final attempt and retry; do not call aggregate network 17/17 PASS |
| Original lifecycle | PASS | idle, absolute TTL, renderer crash, shutdown: 4 checks |
| Capture lifecycle | PASS | 18/18 controlled equivalents; not BrowserSession integration |
| Old intermediate TTL cause | FAIL / unresolved | Historical failure remains; new campaign 3/3 TTL PASS |
| Publisher old unexplained exit | FAIL / unresolved | Missing terminal evidence; current 3/3 crash recovery PASS |
| 720p15 repeatability | PASS | 14.91 / 14.95 / 14.92, each independent >90s |
| 720p30 repeatability | FAIL | 28.42 FAIL / 29.06 PASS; old 29.71/29.44 passes retained |
| Input benchmark | PASS, qualified | 100 final observations; persistent Docker stream remains in path |
| Exact raw edges | PASS | 8 raw pixel assertions, native app1280x720 inside Xvfb1281x721 |
| Sandbox / private X11 / secret mounts | PASS local | actual sandbox status; cookie rejection; no TCP6091; no auth/control/Docker/key mounts |
| Input endpoint negative tests | PASS | wrong bearer, extra property, eval/shell, oversize rejected |
| Frame IPC / publisher JWT | PASS | method/path/length/dimensions/NaN and room/source/rights assertions |
| Viewer auth / media epochs | PASS local | 3/3 separate real-viewer campaigns |
| Slice 2A regression | PASS | final-2a; 995−38 decoded frames over64.463s ≈14.85 FPS; no decoder drops/page errors; reconnect |
| Fixed 960x540 / 640x360 source campaigns | NOT RUN | Automatic adaptation observed separately; no forced adaptation disabled |
| Production isolation / Core / audio / 2B.2 | NOT RUN | Outside authorized slice; same-UID limitation open |

## 11. Decision and next local experiment

**Overall gate: FAIL / HOLD for Slice 2B.2.** The requested repeated 720p15 performance and raw-edge checks now pass, control latency is measured without per-action exec startup, and current local lifecycle repeats pass. However, mixed-load API/navigation and capture positive-HTTPS failures remain intermittent/unexplained; historical 503 and publisher-stop root causes are not proven. Fixed 720p30 is still not repeatably above threshold. This report does not authorize BrowserSession migration. Stop after this report.

Do not migrate the optimization into the original media publisher. For the remaining 30-FPS quota/scheduling boundary, the next local experiment is a matched, alternating A/B with separate fixed capture/publisher CPU quotas and identical fixture/image, retaining cgroup/event-loop/native counters and terminal logs. Change one quota at a time; retain adaptation and frame bounds. Do not substitute Ingress or force adaptation off. For the unexplained historical publisher exit, the next occurrence must preserve source-lost/process state plus both terminal logs before recreation. No evidence-free timeout increase is justified.

Reproduce steady series with `pwsh -File experiments/capture/gate-runs.ps1`; finish campaign with `gate-finish.ps1`. These scripts affect dedicated browser experiment projects only, but create fresh containers. Choose new evidence names/directories before repeating: current fixed filenames are not an append-only archive. At completion capture/publisher and generated-media source/publisher are stopped; no `zvonok-browser-gate-*` containers remain. Existing viewer/broker/guard/proxy/LiveKit services remain available intentionally; original Worker is restored to its normal configuration. No recurring automation, shared control, audio, Core integration or Slice 2B.2 work was started.
