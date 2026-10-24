> Historical PoC runbooks; session sections describe older code. Current setup: [Docker Compose](DOCKER-COMPOSE.md). Run commands from the repository root. For the PNG demo, use `docker compose -f compose.poc.yaml` instead of bare `docker compose`.

# Zvonok Browser Service — Slice 0–1

Отдельный server-hosted Chromium PoC. React показывает диагностические PNG по команде, не iframe и не видеотрансляцию. Только доверенные тестовые сайты. Production auth и LiveKit отсутствуют.

## PowerShell

Docker Desktop должен работать в Linux mode. Нужны PowerShell 7, Node 24 LTS и npm. Из ограниченного Codex окружения Docker-команды могут требовать штатного разрешения запуска вне sandbox; Windows ACL менять не нужно.

```powershell
Set-Location C:\project\zvonok-browser
# This legacy demo uses DEV_TOKEN; the current .env.example is for Core integration.
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToHexString($bytes)
Set-Content -Encoding ascii .env "DEV_TOKEN=$token`nBROWSER_PORT=47831"
npm.cmd ci
npm.cmd run build
npm.cmd test
docker compose -f compose.poc.yaml up -d --build
Invoke-RestMethod http://127.0.0.1:47831/api/health
Invoke-RestMethod http://127.0.0.1:47831/api/ready
Start-Process http://127.0.0.1:47831
```

Если `.env` уже создан, не перезаписывайте его. Введите значение DEV_TOKEN из локального `.env` в поле клиента. Оно хранится только в памяти страницы. Разрешены `https://example.com/` и `https://www.selenium.dev/selenium/web/web-form.html`. Последняя содержит обычные текстовые формы. Фокус на кадре: печать, Tab/Enter, click и scroll. Наведение мыши обновляет диагностический кадр с ограничением частоты; это всё ещё не live media.

```powershell
pwsh -File scripts/acceptance.ps1
docker compose -f compose.poc.yaml exec worker node24 scripts/network-check.mjs
docker compose -f compose.poc.yaml exec worker node24 scripts/browser-check.mjs
pwsh -File scripts/lifecycle-check.ps1
docker compose -f compose.poc.yaml ps
docker stats --no-stream $(docker compose -f compose.poc.yaml ps -q)
docker compose -f compose.poc.yaml logs --tail 30
docker compose -f compose.poc.yaml down
```

`down` затрагивает только этот Compose project; volumes не удаляются. Browser profile находится в tmpfs и не сохраняется. Не запускайте `prune`. При конфликте порта измените BROWSER_PORT; acceptance script пока использует стандартный 47831. При конфликте subnet выберите свободную подсеть и согласованно измените fixed proxy IP в compose, guard и worker. Не подключайте сети других проектов.

Контракт, границы и результаты: [архитектура](ARCHITECTURE.md), [security](SECURITY-BOUNDARIES.md), [media ADR](MEDIA-TRANSPORT-ADR.md), [отчёт](SLICE-0-1-REPORT.md).

## Slice 2A: isolated generated LiveKit video

Run `pwsh -File scripts/media-up.ps1`. This creates a random **local-only** LiveKit key in ignored `media/livekit.local.yaml` and starts the independent `zvonok-browser-media` Compose project. It reuses only the test-client source and existing local `.env` DEV_TOKEN, never Core Zvonok credentials or networks.

Open http://127.0.0.1:47832, paste the DEV_TOKEN, connect. The first three rows of pixels contain visible frame count, Unix generation milliseconds and target FPS; the square moves continuously. JSON diagnostics show actual decoded FPS, dimensions, drops, codec and timestamp-in-pixels latency. Chromium PNG diagnostics remain at http://127.0.0.1:47831. Media viewer never polls `/frame`.

```powershell
node scripts/media-check.mjs
pwsh -File scripts/media-resources.ps1 -Name 720p15-steady
$env:MEDIA_CHAOS='1'
$env:MEDIA_RUN='720p15-recovery'
node scripts/media-check.mjs # publisher restart + real RTC TCP outage + reconnect
Remove-Item Env:MEDIA_CHAOS
# Native IPC/JWT self-check needs the single producer stopped:
docker --context desktop-linux compose -f compose.media.yaml stop generator
try { Get-Content media/ipc-check.mjs -Raw | docker --context desktop-linux compose -f compose.media.yaml exec -T publisher node --input-type=module }
finally { docker --context desktop-linux compose -f compose.media.yaml start generator }
# Profile changes restart only generated source/publisher:
$env:MEDIA_WIDTH='1280'; $env:MEDIA_HEIGHT='720'; $env:MEDIA_FPS='30'
docker --context desktop-linux compose -f compose.media.yaml up -d --no-deps publisher generator
# 1080p30: WIDTH=1920, HEIGHT=1080, FPS=30
# Shutdown this project only; retain its two small socket volumes:
docker --context desktop-linux compose -f compose.media.yaml down
```

Media checks use installed local Chrome through Playwright; no flags weakening browser security. Linux native RTC runs in containers. `rtc-relay` is a bounded TCP hop needed by this Docker Desktop loopback ICE setup, without transcoding. It is distinct from capture IPC and LiveKit Ingress. See [measured results and limitations](docs/SLICE-2A-MEDIA-REPORT.md).

## Unified BrowserSession / Slice 2B.2

Run `pwsh -File session/up.ps1`, then open http://127.0.0.1:48031, enter the existing local DEV_TOKEN and create a browser. URL, navigation and input control the Chromium shown in LiveKit video. End closes the session and deletes its media room. PNG diagnostics is a separate on-demand mode. This remains a single local-owner PoC; see [acceptance results and limitations](docs/SLICE-2B2-SESSION-INTEGRATION-REPORT.md).

The dedicated project requires the existing local Slice0–1/2A/2B.1 baseline images. Its startup script generates a fresh ignored local LiveKit key only when absent. Defaults: 1280×720 at15FPS. Explicit local opt-in: `$env:MEDIA_FPS='30'` before startup. Audio/shared control/Core integration are excluded. `$env:BROWSER_FIXTURE='1'` enables only the controlled real-Chromium acceptance fixture; leave it unset for ordinary allowed HTTPS navigation.

Run `node session/e2e.mjs`, `node session/lifecycle.mjs`, `node session/security.mjs`, `node session/regression.mjs`, and `node session/reliability.mjs` sequentially with fixture mode enabled. Artifacts use fresh timestamp directories. Stop only this project with `docker --context desktop-linux compose -f compose.session.yaml down` (no volume deletion).

## Shared Browser Room / Slice 3

The session deployment now supports one owner and one independently authorized guest. Owner creates with DEV_TOKEN and selects «Пригласить B». In a separate browser context, B pastes that invitation and selects «Присоединиться», without entering the owner's token. Invite lifetime is 60 seconds/one use. B requests control; A grants/declines or returns control. Guest can leave; owner can revoke guest access or End for everyone. Reload reconnects using per-tab sessionStorage; owner disconnect has a 30-second grace. The 15-second control lease is server-authoritative and fenced at Worker execution.

Run `node session/shared-e2e.mjs` after the existing sequential regressions, with `BROWSER_FIXTURE=1`; do not run competing browser/FPS campaigns on the same deployment. [Shared protocol, security boundaries and measured acceptance](docs/SLICE-3-SHARED-BROWSER-REPORT.md). This remains loopback-only local mode; Core/production auth, audio and public hosting are excluded.
