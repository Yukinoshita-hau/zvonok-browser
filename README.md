# Zvonok Browser

Совместный серверный Chromium для приватного звонка Zvonok. Команды идут через Core backend, видео и звук — через отдельный Browser LiveKit. Два Worker/Publisher-слота обслуживают до двух Activity одновременно.

После заполнения `.env` из `.env.example` и включения Browser Activity в frontend/backend:

```sh
docker compose up -d --build --wait --wait-timeout 180
```

Нужны Docker с Linux containers и Compose >= 2.24.4. Node/npm/PowerShell на хосте не нужны. Compose сам собирает образы из исходников и передаёт LiveKit-конфиг контейнерам; предварительные PoC-образы и `session/livekit.local.yaml` не требуются.

**[Настройка .env, подключение frontend/backend, запуск и диагностика](docs/DOCKER-COMPOSE.md).**

Профиль использует loopback signaling/ICE: оба клиента должны находиться на компьютере с Docker. Для VPS/LAN нужен отдельный доступный клиентам media transport; смена одной переменной origin его не включает.

Старый PNG demo сохранён в `compose.poc.yaml`. [Исторические PoC-инструкции](docs/LEGACY-POC.md) и `compose.session.yaml` оставлены для существующих экспериментов; основной вход теперь `compose.yaml`.
