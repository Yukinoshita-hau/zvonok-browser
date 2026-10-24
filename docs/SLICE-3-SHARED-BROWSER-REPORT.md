# Slice 3 — Shared Browser Room

2026-10-21, Asia/Yekaterinburg. **Local two-user functional acceptance PASS**, with short-window media characterization only. Historical performance failures remain failures. This is not production multi-tenant acceptance.

## 1. Shared architecture

One existing BrowserSession, fixed 1280×720 Chromium/profile/private Xvfb/FFmpeg, one publisher and one epoch room serve both clients. No screenshot playback or per-viewer encoder. Worker owns membership and control state alongside its existing bounded sequential browser executor. Broker retains LiveKit keys and room administration on private binding IPC.

## 2. Local identity

DEV_TOKEN authenticates only local-owner at the trusted API. API overwrites internal identity headers and never forwards client role claims. Guest authenticates with a separate random 256-bit bearer capability; Worker retains only its SHA-256 digest, session/epoch-bound identity and expiry. Guest lifetime is at most ten minutes and never exceeds absolute session expiry. No production/Core authentication is claimed. Shared auth is enabled only in compose.session.yaml.

Credentials are kept in per-tab sessionStorage so reload can reconnect within grace; they are never put in URLs/cookies. This expands the old memory-only client policy: same-origin script compromise can steal tab credentials. CSP and exact local Origin checks remain necessary; this is not production credential storage.

## 3. Invite protocol

Owner POST /sessions/:id/invite issues a 256-bit capability valid for at most 60 seconds, one guest acceptance, fixed guest role, current session and epoch. Rotation/revoke invalidate the old digest. POST accept validates an exact body containing invite and epoch, atomically consumes the invitation and creates an independent guest identity before asynchronous membership synchronization. At most one owner and one guest belong to a room. Known sessionId alone grants nothing. Failures during broker synchronization fail closed by ending the BrowserSession.

## 4. Media membership

Worker validates membership before requesting a viewer JWT over private binding IPC and again before returning it. Stable viewer identities differ for owner and guest; both receive room-bound subscribe-only/no-data/no-admin JWTs. Broker synchronizes the two-member allowlist and removes revoked LiveKit participants.

Self-hosted LiveKit does not invalidate previously signed tokens on RemoveParticipant. Therefore public loopback signaling port 48033 now reaches a small membership gate in Broker; direct LiveKit 7880 is no longer published. Gate cryptographically verifies each initial/reconnect JWT, room, role and live membership; revocation closes existing signaling sockets and removes the participant. Old unexpired tokens cannot bypass membership by reconnecting. RTC TCP relay remains the existing media transport, not an alternate signaling endpoint. Internal publisher connects directly on its private network. [LiveKit token contract](https://docs.livekit.io/frontends/reference/tokens-grants/).

## 5. Control state machine

Lease contains sessionId, epoch, controller, monotonic generation, expiration and server timestamp. Owner starts as controller. Guest request → owner grant/decline; controller release → owner; owner revoke/return → owner. Request/decline also advance generation to reject replayed control operations. Controller heartbeat renews a 15-second lease only with current epoch and generation. Expiry or missing guest heartbeat returns control to owner and invalidates prior fences. No reconnect can recover control from frontend state alone.

## 6. Input authorization and fencing

Every navigate/back/forward/reload/input checks identity, epoch and generation at admission, after the existing bounded 16-command queue, and after asynchronous dependency readiness immediately before Playwright. Wheel rechecks between pointer move and wheel operation. No arbitrary CDP/evaluate/shell/selector endpoint. Client retains its smaller input queue and captures the lease when enqueueing, so delayed frontend commands cannot inherit a later grant.

Revoke changes generation synchronously, ahead of queued work, then waits for already-started work to settle before acknowledging. An operation already handed to Chromium cannot be retroactively undone; queued stale commands are rejected, and no old operation remains executing after successful revoke acknowledgement. DELETE interrupts cleanup immediately instead of waiting behind the input queue. Late HTTP responses cannot restore a terminal session, another session ID or older control generation. Guest credential expiry is checked by the execution fence itself, not only the one-second cleanup timer. Two fixed API rate buckets (owner/guest, 30 requests/sec each) prevent guest flood from consuming the owner's revoke/End budget; browser execution remains bounded at 16 outstanding operations.

## 7. React UX

Existing LiveBrowser adds a compact participant/controller strip, invite paste/copy field, request/grant/decline/revoke/release/leave controls. Guest never receives owner actions. Navigation and video input require connected authoritative controller state; viewers can use the surrounding UI. Original contain-coordinate mapping, letterbox rejection and fixed server viewport remain. Real decoded-frame freshness hides stale video; sampled width below 1280 or FPS below 10 reports degraded quality without restarting BrowserSession. This indication has a unit check; no deliberate low-FPS stress campaign was run. Membership denial unmounts the video/track. Server presence exposes «Ожидание хозяина» during owner grace. A hash-only terminal guest tombstone distinguishes SESSION_ENDED from guest-only ACCESS_DENIED and grants no API/media/input access. No multicursor, window manager or call system.

## 8. Reconnect

Per-tab credential/session reload restores membership by server read and heartbeat, not cached control state. Owner presence has a 30-second grace; authorized owner requests count as presence, enabling existing API callers. Guest heartbeat/input cannot prolong owner grace. Media reconnect obtains fresh membership-checked JWTs with bounded retries. Guest never becomes owner.

## 9. End, TTL and crash

Explicit owner DELETE closes immediately; guest can leave only itself. Cleanup closes invitations/leases, publisher binding/room, capture, Chromium/display and temporary profile through the existing lifecycle. Five-minute idle and twenty-minute absolute TTL remain; heartbeats/status do not extend idle and input cannot extend absolute expiry. Guest expiration revokes membership and returns control. Worker restart loses membership and Broker lease/journal cleanup prevents reuse of the old epoch. Same-UID browser/Worker compromise remains outside the demonstrated isolation boundary.

## 10. Two-viewer decoded frames and FPS

Two real Chrome/Playwright contexts, separate storage and identities; B never receives DEV_TOKEN. E2E checks changing timestamps and typed-text-length bits rendered by the same sandboxed Chromium, transported through capture/LiveKit and read from each client's decoded video. Fixture is an actual page, not a synthetic publisher. No PNG requests/page errors. It also asserts one root Chromium, one Xvfb, one FFmpeg and one remote video publication. Fixed viewport 1280×720 remains unchanged under letterbox/resize.

| Campaign | A decoded FPS / receiver window | B decoded FPS / receiver window | Sampled dimensions A/B | Drops delta A/B |
| --- | --- | --- | --- | --- |
| shared-1792568552588 | 15.00 / 25.006s | 15.25 / 25.501s | 1280×720 | 0 / 0 |
| shared-1792569084344 (final main campaign) | 15.04 / 24.999s | 15.06 / 25.496s | 1280×720 | 0 / 0 |

Stats callbacks and endpoints are sampled, differ between contexts and need not align with encoder frame boundaries; measured rates slightly above 15 do not imply a higher encoder target. Short campaigns characterize local delivery, not sustained repeatability or VPS capacity. Default remains 720p15; 720p30 stays explicit opt-in and was NOT RUN for shared rooms. Historical loaded Slice 2B.2 **14.13 FPS FAIL** and historical 2B.1/30FPS failures remain FAIL; no thresholds, adaptation or resource limits were raised to pass.

Final receiver byte deltas: A 547,422 over 24.999s (~175kbps); B 560,021 over 25.496s (~176kbps). These are inbound video RTP stats on the compressible controlled fixture, not total wire traffic or general website bandwidth. Both receive increasing decoded frames. Publisher restart and viewer/owner reconnect recover real advancing fixture clocks. Source loss clears stale video rather than displaying an old frame as current.

## 11. CPU/RAM

Docker snapshot after each steady measurement (100% CPU = one logical CPU). Values are samples, not sustained means, peaks or isolated encode costs. Memory is Docker working set, not peak RSS. No new resource quota or per-viewer encoder.

| Campaign | Worker CPU / memory / PIDs | Publisher CPU / memory / PIDs | LiveKit CPU / memory |
| --- | --- | --- | --- |
| first shared PASS | 55.15% / 333.9MiB / 139 | 16.19% / 144.7MiB / 37 | 1.77% / 60.81MiB |
| final main PASS | 53.19% / 402.8MiB / 139 | 42.23% / 131MiB / 37 | 2.03% / 58.95MiB |

Raw resources.jsonl retains network delivery totals. Samples are taken after FPS windows to avoid repeating the old in-window resource-polling load campaign. Variation is not attributed to an unproved cause.

## 12. Security negative tests

PASS: missing/wrong credentials, spoofed owner headers/cookies, arbitrary session ID, guest create/invite/grant/DELETE, input/navigation without lease, duplicate requests, invite replay/rotation/revoke/wrong epoch/expiry, stale epoch/generation, concurrent input/revoke, bounded queue overload and separate owner rate budget. Guest expiry while queued and old frontend response restoration have focused unit checks. Real viewer JWT expiry is checked at the gate. Guest access revocation tests an explicitly freshly-issued, still-valid JWT: existing participant disconnects, video unmounts, new API/JWT requests fail and cached JWT rejoin is refused. After DELETE/next epoch, old viewers remain denied. End while guest controls detaches both viewers; guest Release returns control without ending the owner session.

Runtime security 8/8 PASS: actual Chromium namespace/Seccomp sandbox, guard IPv4/IPv6 default-deny, proxy-only egress, private Xauthority refusal, no Worker media secrets/publisher control mounts/Docker socket, actual LiveKit IP and X11 TCP denial, finite input/URL schema, publisher camera-only JWT and bounded frame IPC. No production isolation claim follows from these local checks.

## 13. Regression evidence

| Check | Result | Evidence under artifacts/ |
| --- | --- | --- |
| TypeScript/Vite and unit | PASS | Final Docker/root TypeScript/Vite build; slice3-final-1792569734013/unit.log: 9 files / 20 tests; existing bundle warning |
| Slice 0–1 API on integrated Worker | PASS 15/15 | session-regression-1792567416076/api.log and session-regression-1792567660917/api.log |
| Original Network / Browser | PASS 17/17 and 9/9 | session-regression-1792567660917/original-*.log |
| Slice 2A media | PASS | media-slice3-regression-1792567806611.json/.png; 948 additional decoded frames / 64.719s ≈14.65FPS, 1280×720, no drops/PNG/page errors, disconnect/reconnect |
| Unified Slice 2B.2 E2E | PASS | session-2026-10-21T07-36-44-852Z; 14.78FPS / 24.499s, input/navigation/letterbox/reconnect/restart/DELETE/next-session isolation |
| Integrated lifecycle | PASS 7/7 | session-lifecycle-1792568283907; DELETE, FFmpeg/renderer crash, publisher SIGKILL, shutdown, idle/absolute TTL |
| Integrated security | PASS 8/8 | session-security-1792568347706 |
| Two independent viewers / control lease / races | PASS | slice3-shared-1792568552588 and final slice3-shared-1792569084344; 15 scenario groups + 2 FPS rows each |
| Actual room/process/profile cleanup | PASS | Final shared campaign queries RoomService listRooms=0 as well as no Chromium/Xvfb/FFmpeg/profile after End/DELETE-race/grace expiry |
| Session network / proxy recovery / navigation faults | PASS | session-reliability-1792569238244: 21/21 network checks under capture; proxy outage readiness/navigation503, same-session recovery; reset and 12-second timeout classification/recovery |
| Final guest Release / owner End with guest controller | PASS | slice3-release-1792569389020 and final slice3-release-1792569580664: both actual viewers detach; B explicitly sees session ended |
| Old experimental input schema | PASS | slice3-final-1792569734013/experimental-input.log |
| Shared30FPS, sustained host load, audio/Core/public deployment | NOT RUN | Outside limited characterization / authorized slice |
| Ten-minute real guest credential expiry / 60-second real invite wait | NOT RUN as wall-clock E2E | Strict expiry and queued expiry covered by fake-clock unit tests; viewer JWT/lease expiry are actual E2E |

Original 0–1 and 2A projects were initially stopped. They were started only for their sequential regressions and returned stopped. No heavy browser/FPS campaigns ran concurrently. Allowlist source changes from another chat were preserved with user confirmation; this slice did not add allowed destinations or relax network/sandbox policy. One positive network fixture changed from non-resolving rr1.googlevideo.com (ENOTFOUND verified inside proxy) to already-permitted googlevideo.com; this is not a proxy policy change.

Reproduce locally with fixture mode and the existing ignored local keys:

```powershell
npm.cmd run build
npm.cmd test
docker --context desktop-linux compose -f compose.session.yaml build
$env:BROWSER_FIXTURE='1'
docker --context desktop-linux compose -f compose.session.yaml up -d --no-build
# Start original 0–1 deployment for its Network/Browser checks first.
node session/regression.mjs
# Run original media-check.mjs with a unique MEDIA_RUN while only its dedicated 2A deployment runs.
node session/e2e.mjs
node session/lifecycle.mjs
node session/security.mjs
node session/shared-e2e.mjs
node session/shared-release.mjs
node session/reliability.mjs
node --test experiments/capture/input-control.test.mjs
```

All campaigns write distinct artifacts. Tests load the local development token internally; do not paste it into reports/commands. No new dependencies or production keys were introduced. Scope reaches API trusted identity forwarding/rate limits, protocol DTO, Worker room/lifecycle/executor, Broker/gate/Docker bindings, LiveBrowser/media health/styles, legacy and new acceptance callers, fixtures, focused units and these docs. Existing unrelated dirty work was preserved; no reset/stash/clean/prune or commit.

## 14. Retained FAIL / NOT RUN and interpretation

Historical loaded720p15 14.13FPS FAIL is retained. Early artifacts/session-regression-1792538740242 has API503/session-network exit137 FAIL while another chat was recreating the same deployment; this is a recorded concurrent condition, not a proved root cause. session-regression-1792567416076 has API PASS but original services stopped and a network process timeout; subsequent original checks passed after starting their deployment. session-regression-1792567660917 retains EADDRINUSE from the still-running old network probe; only that confirmed diagnostic PID was terminated.

session-2026-10-21T07-33-08-964Z retains no-decoded-frames FAIL: gate initially admitted /rtc but SDK used /rtc/v1. Exact v1 paths were added under identical cryptographic/membership checks; no catch-all path was opened. slice3-shared-1792568504692 retains a harness FAIL reading framesDecoded>10 before waiting for ten frames; corrected waits preserved actual-clock assertions. Earlier network/reliability campaigns retain timeout FAIL because a socket close on NXDOMAIN did not settle the positive probe. Added close handling, a bounded campaign deadline and the DNS-verified fixture correct the harness without changing egress rules. session-reliability-1792568702316 also retains owner-grace closure cascades while its synchronous host network call prevented heartbeat; the harness now sends genuine owner API heartbeats during asynchronous probes. session-reliability-1792568810184 records that recovery checks passed before the fixture correction. An early Release smoke read `closing` before DELETE acknowledged; the corrected smoke awaits204 and retains that failed artifact.

Local functional/security acceptance passes the listed checks. This does not convert historical failures, short FPS measurements or NOT RUN production/hardware campaigns into a broader PASS.

## 15. Production blockers

Local bearer identity, tab credential storage, process-memory membership, same-UID browser/Worker, unauthenticated trusted internal IPC topology, local unencrypted signaling and uncalibrated sustained-host capacity are production blockers. Public hosting, 3+ users, Core deployment/auth, audio, recording, persistent login and Electron integration are outside scope.

## 16. Activity readiness

Compact LiveBrowser can later be embedded as an Activity, but needs a verified Core identity contract, production trust boundaries, durable/revocable membership and embedding lifecycle integration first. No current claim of production readiness.

Final state: local http://127.0.0.1:48031 remains available, BROWSER_FIXTURE=0, MEDIA_FPS=15. No BrowserSession remains active, Worker has no Chromium/Xvfb/FFmpeg, /tmp/session-profile-* and /frames are empty, RoomService listRooms returns zero. Original 0–1 and 2A deployments are stopped as before their regression runs. No other Zvonok repository/Core deployment was changed. No commits, generated-key publication, detached acceptance browsers, recurring tasks or ongoing performance work remain. Final git diff --check passed. Work stops after this report.
