# Slice 0–1 report — 2026-10-20

Status: Slice 0–1 implemented and real-container acceptance completed. Only local trusted-site PoC is claimed. User approved SLICE-0-1-SPEC.md; its historical approval-stage header is retained.

## Scope and actual implementation

Only C:\project\zvonok-browser changed. Standalone npm workspace: Fastify API, non-root Playwright worker, React/Vite client, shared TypeBox DTO/runtime validation, nginx gateway, fail-closed network-guard and restricted CONNECT proxy. No changes to Core Zvonok, existing Docker networks/volumes, production credentials or LiveKit. No prune/reset/ACL changes.

Topology: gateway joins dedicated edge and internal control bridges; API joins control only; API↔worker over 0700 directory/0660 Unix socket volume; worker shares guard namespace on internal browser bridge; proxy joins browser and separate outbound bridge. Guard and proxy do not mount the socket. Static addresses: proxy 172.30.81.2, guard/worker 172.30.81.3, API 172.30.82.3. Only host listener 127.0.0.1:47831. Worker/API/proxy have no published ports.

Minimal architecture chosen to enforce network egress outside browser JS, isolate control traffic, and avoid DB/media infrastructure. Internal-only gateway networking did not publish the loopback port on this Docker Desktop: an edge bridge for gateway fixed publication without giving worker a route to control. Initial static-address collision was fixed by assigning guard its own address. Local TypeScript incremental cache was excluded from Docker context after a clean Linux build exposed missing emitted DTO artifacts.

## Validation

| Scenario | Result | Evidence/limit |
|---|---|---|
| Node/TypeScript/React build | PASS | npm run build |
| Targeted unit tests | PASS | Vitest: 2 files / 3 tests, URL and action boundaries, IP policy |
| Dependency audit | PASS | npm audit: zero reported vulnerabilities after updating Vitest |
| Docker daemon diagnosis | PASS | desktop-linux, Linux Engine 28.4.0, Docker Desktop 4.47.0; access works outside Codex sandbox |
| Gateway/client/API startup | PASS | HTTP health ok; React page inspected in real local Chrome |
| Unauthenticated control | PASS | POST /api/sessions without token → 401 |
| Guard bootstrap | PASS | healthy; actual IPv4/IPv6 OUTPUT DROP, only proxy TCP/3128 allowed; dropped packet counters observed |
| Direct IP/DNS/IPv6/private/metadata/Docker-host/loopback | PASS | scripts/network-check.mjs in real guard namespace, including active loopback listener; denied connections |
| Disallowed CONNECT authorities/ports | PASS | localhost, metadata, Docker-host name, suffix attack, wrong port, IPv6 literal rejected |
| Public HTTPS via proxy | PASS | TLS verified example.com response contains Example Domain from same restricted namespace |
| Chromium non-root + sandbox | PASS | UID 1000, cap_drop ALL; chrome://sandbox: namespace/PID/network namespaces and Seccomp-BPF Yes, adequately sandboxed |
| One isolated session + second rejected | PASS | API creates active session; second creation 409 |
| Navigation/back/forward/reload | PASS | Actual example.com and Selenium form, URL/history checks |
| Mouse/text/scroll + PNG | PASS | API screenshot visibly contains Slice one in editable text input; independent Chromium harness asserts typed value and scrollY on controlled tall-page fixture |
| Redirect/subresource enforcement | PASS | Real Chromium with controlled redirect/image responses at trusted origin; forbidden target fails with and without request routing; raw namespace tests separately pass |
| DELETE/process cleanup/storage reset | PASS | After DELETE only init/worker remain; cookies/localStorage/sessionStorage seeded in real Chromium, absent after destroy/new launch |
| Crash/idle/absolute TTL/shutdown | PASS | Deep Chromium children killed, service reports crashed and cleans process tree; idle 2 sec / TTL 5 sec test override expires despite input; worker stop with active browser exits 0; default settings restored |
| Foreign Host/Origin | PASS | Both return HTTP 403 from loopback gateway |
| Proxy failure remains closed | PASS | Proxy stopped: /ready 503, direct public-IP fallback still blocked; proxy restored and API/network suites passed |

Negative connection results show tested destinations unreachable; policy/counter inspection supplies evidence of default-deny beyond an absent listener. IPv6 probes may also fail from absent routes. All network probes repeated with API/gateway live: PASS. Upstream proxy is deliberately IPv4-only; all selected DNS A results are checked and connection pinned to a checked address; IPv6 is not an upstream fallback.

Final suites: API acceptance 15 PASS; browser harness 9 PASS; network probes 17 PASS; lifecycle 4 PASS. After container recreation an immediate probe initially raced readiness; acceptance now waits on actual /ready. The original upstream seccomp profile blocked Chromium's namespaced chroot with cap_drop ALL; the narrow syscall adaptation is documented in SECURITY-BOUNDARIES.md. Headless-shell cannot display chrome://sandbox, so final worker uses full Chromium in headless mode. Writable XDG config/cache are confined to existing /tmp tmpfs. No --no-sandbox, privileged, unconfined, extra worker capabilities or Windows ACL changes were used.

## Resources

Observed form + 8 diagnostic frames on Docker Desktop/WSL2 (Linux 6.6.87.2): worker 277.3 MiB, 1.96% instantaneous CPU, 146 PIDs/threads; cgroup memory peak 307130368 bytes (~293 MiB), observed pids.current 148. CPU totals since container start at sample: 4.206 CPU seconds; 8 throttled periods / 1.408 seconds throttled. This is a short functional workload, not sustained capacity or media FPS testing.

Same sample: API 25.29 MiB / 0%; client 10.49 MiB / 0%; proxy 19.07 MiB / 0.08%; guard 872 KiB / 0% (other samples 3–5% while health checks execute). Based on the ~293 MiB observed peak, worker RAM ceiling reduced from provisional 1536 to 768 MiB, with headroom; API/browser/network/lifecycle suites repeated under 768 MiB. Retained 2 CPUs and 256 PIDs (observed 148); tmpfs 512 MiB and shm 256 MiB. API/proxy 128 MiB each, client 64 MiB, guard 32 MiB. No universal concurrency sizing or maximum-load claim; one session only. Sustained CPU peak/load/OOM stress: NOT RUN.

## Reproduce

PowerShell 7; local .env contains a freshly generated development token and is ignored by git/Docker. Never print it in shared logs. Full bootstrap in README.md.

```powershell
Set-Location C:\project\zvonok-browser
npm.cmd ci
npm.cmd run build
npm.cmd test
docker compose -f compose.poc.yaml up -d --build
Invoke-RestMethod http://127.0.0.1:47831/api/health
Invoke-RestMethod http://127.0.0.1:47831/api/ready
Start-Process http://127.0.0.1:47831
pwsh -File scripts/acceptance.ps1
docker compose -f compose.poc.yaml exec worker node24 scripts/network-check.mjs
docker compose -f compose.poc.yaml exec worker node24 scripts/browser-check.mjs
pwsh -File scripts/lifecycle-check.ps1
docker stats --no-stream $(docker compose -f compose.poc.yaml ps -q)
docker compose -f compose.poc.yaml down
```

Browser harness is an explicitly local test program, not a remotely accessible evaluate/CDP API. It must run with no active service session. It uses actual Chromium plus controlled response fixtures for redirect/subresource tests and a controlled tall page for wheel behavior; raw network probes additionally exercise the namespace without Playwright interception.

## Limits and Slice 2

Diagnostic PNG only; no video/audio, multi-user, production auth or persistence. Client page inspected in local Chrome; full automated pointer/keyboard end-to-end through the React UI is NOT RUN (API commands and their rendered PNG effects are confirmed separately). Client has click/move/text/editing keys/wheel; no drag/drop, upload, arbitrary shortcuts or IME composition protocol. Third-party CSS/resources outside the two origins stay blocked, so Selenium form appears unstyled. TLS proxy checks destination, not encrypted paths/content; allowlisted origins are trusted and must not provide arbitrary forwarding. OS escape and a compromised same-UID browser process accessing worker internals are outside this PoC's demonstrated boundary. See SECURITY-BOUNDARIES.md.

Slice 2 requires a separate measured media spike comparing RTC Node SDK capture against Linux display/audio → FFmpeg/GStreamer → Ingress. Both media paths, latency, FPS and CPU-only VPS capacity remain NOT RUN; see MEDIA-TRANSPORT-ADR.md. No Slice 2 implementation started.
