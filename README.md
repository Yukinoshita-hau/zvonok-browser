# Zvonok Browser Service — Slice 0–1

Отдельный server-hosted Chromium PoC. React показывает диагностические PNG по команде, не iframe и не видеотрансляцию. Только доверенные тестовые сайты. Production auth и LiveKit отсутствуют.

## PowerShell

Docker Desktop должен работать в Linux mode. Нужны PowerShell 7, Node 24 LTS и npm. Из ограниченного Codex окружения Docker-команды могут требовать штатного разрешения запуска вне sandbox; Windows ACL менять не нужно.

```powershell
Set-Location C:\project\zvonok-browser
Copy-Item .env.example .env
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = [Convert]::ToHexString($bytes)
Set-Content -Encoding ascii .env "DEV_TOKEN=$token`nBROWSER_PORT=47831"
npm.cmd ci
npm.cmd run build
npm.cmd test
docker compose up -d --build
Invoke-RestMethod http://127.0.0.1:47831/api/health
Invoke-RestMethod http://127.0.0.1:47831/api/ready
Start-Process http://127.0.0.1:47831
```

Если `.env` уже создан, не перезаписывайте его. Введите значение DEV_TOKEN из локального `.env` в поле клиента. Оно хранится только в памяти страницы. Разрешены `https://example.com/` и `https://www.selenium.dev/selenium/web/web-form.html`. Последняя содержит обычные текстовые формы. Фокус на кадре: печать, Tab/Enter, click и scroll. Наведение мыши обновляет диагностический кадр с ограничением частоты; это всё ещё не live media.

```powershell
pwsh -File scripts/acceptance.ps1
docker compose exec worker node24 scripts/network-check.mjs
docker compose exec worker node24 scripts/browser-check.mjs
pwsh -File scripts/lifecycle-check.ps1
docker compose ps
docker stats --no-stream $(docker compose ps -q)
docker compose logs --tail 30
docker compose down
```

`down` затрагивает только этот Compose project; volumes не удаляются. Browser profile находится в tmpfs и не сохраняется. Не запускайте `prune`. При конфликте порта измените BROWSER_PORT; acceptance script пока использует стандартный 47831. При конфликте subnet выберите свободную подсеть и согласованно измените fixed proxy IP в compose, guard и worker. Не подключайте сети других проектов.

Контракт, границы и результаты: [архитектура](docs/ARCHITECTURE.md), [security](docs/SECURITY-BOUNDARIES.md), [media ADR](docs/MEDIA-TRANSPORT-ADR.md), [отчёт](docs/SLICE-0-1-REPORT.md).

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

Media checks use installed local Chrome through Playwright; no flags weakening browser security. Linux native RTC runs in containers. `rtc-relay` is a bounded TCP hop needed by this Docker Desktop loopback ICE setup, without transcoding. It is distinct from capture IPC and LiveKit Ingress. See [measured results and limitations](docs/SLICE-2A-MEDIA-REPORT.md). Slice 2B capture/audio/control is not implemented.
