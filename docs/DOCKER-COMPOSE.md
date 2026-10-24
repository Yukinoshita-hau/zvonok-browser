# Browser через Docker Compose

Проверка 24.10.2026: образы собраны, Compose и init-конфиг проверены, оба Worker проходят readiness. Проверка двух реальных Activity выявила `WORKER_TIMEOUT` после создания Chromium и истечение lease; стабильное видео и полный Core/frontend E2E пока не подтверждены. Подробности: `artifacts/stages/compose-integration/REPORT.md`.

Это подключение Browser к **уже настроенному Zvonok**: используются обычные `zvonok-backend/docker-compose.yml`, `zvonok-frontend/docker-compose.yml` и их существующие `.env`. Browser запускается своим проектом `zvonok-browser`. Обычный голосовой LiveKit, БД и storage должны быть настроены как раньше; этот Compose добавляет серверный браузер и отдельный медиапоток для него.

Нужны Docker с Linux containers и Compose **2.24.4+** (`docker compose version`). Зависимости собираются внутри Docker. `.ps1`, Node/npm на хосте, ручная генерация YAML и предварительная сборка PoC-образов не нужны.

Compose сначала запускает одноразовый `config-init`: он проверяет media secret и атомарно записывает LiveKit-конфиг в named volume. Затем запускаются LiveKit, broker, Worker и API. Код завершения `0` / состояние `Exited` у `config-init` — норма. У LiveKit и broker этот volume доступен только для чтения.

## 1. .env Browser

Создайте `zvonok-browser/.env` по `.env.example`. Если `.env` уже существует, добавьте новые поля, сохранив прежние значения. Выполните эту команду **два раза** и используйте два разных результата:

```sh
docker run --rm node:24-alpine node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Минимальный `.env` Browser:

```dotenv
BROWSER_INTEGRATION_KEY=<первый случайный ключ из 64 hex-символов>
BROWSER_LIVEKIT_SECRET=<второй случайный ключ из 64 hex-символов>
ZVONOK_CORE_NETWORK=zvonok-net
BROWSER_UI_ORIGIN=http://localhost:3000
BROWSER_SIGNALING_URL=ws://127.0.0.1:48033
BROWSER_SIGNALING_URL_2=ws://127.0.0.1:48039
BROWSER_MEDIA_PROFILE=720p15
BROWSER_AUDIO=1
```

Замените строки в угловых скобках своими значениями. Integration key связывает Core и Browser API; media secret используется только Browser LiveKit и двумя broker. Это отдельные секреты, они не заменяют JWT secret Core и ключ голосового LiveKit. Во frontend секреты не передаются. `DEV_TOKEN` здесь не используется.

`BROWSER_UI_ORIGIN` — точный origin страницы: схема, hostname и порт, без завершающего `/`. `http://localhost:3000` и `http://127.0.0.1:3000` — разные origin. В production используйте HTTPS origin. `BROWSER_SIGNALING_URL` и `_2` — адреса, которые получат клиенты для WebSocket signaling: локально это loopback `ws://`, удалённо задайте `wss://` адреса, опубликованные через TLS reverse proxy к соответствующим Broker.

## 2. .env backend

Добавьте в существующий `zvonok-backend/.env`:

```dotenv
BROWSER_ACTIVITY_ENABLED=true
BROWSER_INTEGRATION_KEY=<тот же первый ключ из Browser .env>
BROWSER_ACTIVITY_URL=http://browser-api:3000/integration
```

Backend Compose передаст `BROWSER_INTEGRATION_KEY` как Spring-свойство `BROWSER_ACTIVITY_KEY`. Если в старом `.env` уже задан `BROWSER_ACTIVITY_KEY`, он имеет приоритет: удалите дубликат или задайте то же значение. Java property называется `browser.activity.key`: при запуске Java вне Compose одного `BROWSER_INTEGRATION_KEY` недостаточно.

Backend и Browser API должны находиться в одной Docker-сети. Для штатного backend это `zvonok-net`; установите её имя в Browser `.env`. Если Zvonok ещё не создавал эту сеть, создайте один раз:

```sh
docker network create zvonok-net
```

У существующей сети ничего создавать не нужно. Адрес `browser-api` разрешает Docker DNS; `localhost` внутри backend-контейнера означает сам backend.

## 3. .env frontend

Добавьте в существующий `zvonok-frontend/.env`:

```dotenv
VITE_BROWSER_ACTIVITY=true
```

Сохраните рабочие `VITE_API_URL`, `VITE_WS_URL`, `VITE_LIVEKIT_URL` и `FRONTEND_PORT`. Например, для стандартного локального UI: `FRONTEND_PORT=3000`, `VITE_API_URL=http://localhost:8080/api`. `VITE_LIVEKIT_URL` относится к обычному звонку; Browser media URL приходит от backend при подключении Activity.

`VITE_BROWSER_ACTIVITY` читается **при сборке**: после изменения нужен `up --build`, одного `restart` недостаточно. Отдельный Browser URL во frontend не задаётся.

## 4. Запуск

Из `zvonok-browser`:

```sh
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
```

Из `zvonok-backend`:

```sh
docker compose up -d --build backend
```

Из `zvonok-frontend`:

```sh
docker compose up -d --build frontend
```

Это обновляет соответствующие сервисы: завершите активные звонки/Activity перед обновлением. Откройте обычный UI (по примеру — `http://localhost:3000`). Два пользователя должны быть друзьями и принять приватный звонок. Затем: **Активности → Совместный браузер**, второй участник подключается к Activity.

Отдельная страница Browser на 48031 не запускается. Core авторизует пользователя, подписывает команды и отправляет их в закрытый `/integration`. Browser API распределяет Activity между двумя Worker. Каждый Worker запускает собственные Chromium/Xvfb/PulseAudio, отправляет кадры/звук своему Publisher; LiveKit доставляет их пользователям. Владелец передаёт и отзывает управление.

## Дополнительные настройки

| Переменная Browser | Назначение / значение по умолчанию |
|---|---|
| `BROWSER_INTEGRATION_KEY` | Обязательный отдельный секрет, минимум 43 символа; рекомендуются 64 случайных hex-символа. Совпадает с backend |
| `BROWSER_LIVEKIT_SECRET` | Обязательные 64 случайных hex-символа, отдельные от integration key |
| `ZVONOK_CORE_NETWORK` | `zvonok-net`; существующая сеть backend |
| `BROWSER_UI_ORIGIN` | `http://localhost:3000`; точный origin UI для обоих broker |
| `BROWSER_SIGNALING_URL` / `_2` | `ws://127.0.0.1:48033` / `ws://127.0.0.1:48039`; клиентские signaling URL для слотов 1 и 2. Удалённый доступ требует `wss://` через TLS reverse proxy |
| `BROWSER_MEDIA_PROFILE` | `720p15`; также доступны `720p30`, `720p60`, `1080p30`, `1080p60` |
| `BROWSER_WORKER_CPUS` | `4` CPU на Worker; это потолок, а не резервирование. Не задавайте больше CPU, доступных Docker |
| `BROWSER_AUDIO` | `1` — звук страниц включён; `0` — выключен |
| `SESSION_IDLE_MS` | `300000` — 5 минут без действий |
| `SESSION_TTL_MS` | `1200000` — максимальная жизнь сессии 20 минут; текущий broker не допускает больше |
| `BROWSER_BROKER_PORT` / `BROWSER_BROKER_2_PORT` | `48033` / `48039`; signaling порт каждого слота, Compose согласует его с выдаваемым URL |
| `BROWSER_LIVEKIT_PORT` / `BROWSER_LIVEKIT_UDP_PORT` | `48034` / `48035`; TCP relay и UDP mux для ICE; можно менять при занятом порте |
| `BROWSER_LIVEKIT_NODE_IP` | `127.0.0.1` локально; IPv4 адрес, который LiveKit сообщает браузерам. Для удалённых клиентов это routable IP узла |
| `BROWSER_LIVEKIT_BIND_ADDRESS` | `127.0.0.1` локально; интерфейс публикации TCP/UDP ICE портов. На сервере `0.0.0.0` допустим при ограничении портов firewall-ом |
| `BROWSER_SUBNET` | `172.30.87.0/24`; внутренняя сеть Chromium |
| `BROWSER_PROXY_IP` / `BROWSER_GUARD_IP` | `172.30.87.2` / `172.30.87.3`; при смене подсети поменяйте все три значения согласованно |

По умолчанию RTC TCP relay и UDP mux доступны только на loopback и годятся только для локальной проверки. Удалённым браузерам нужен достижимый ICE candidate: установите `BROWSER_LIVEKIT_NODE_IP` в routable IPv4 узла, выберите `BROWSER_LIVEKIT_BIND_ADDRESS`, откройте соответствующие TCP/UDP порты в firewall и маршрутизируйте оба `BROWSER_SIGNALING_URL` через TLS reverse proxy/WebSocket к портам Broker `48033` и `48039`. Нельзя оставлять рекламируемый `127.0.0.1` для удалённых клиентов. Порты по умолчанию — 48034/TCP и 48035/UDP. Высокие FPS — выбор профиля, не гарантия производительности: CPU/RAM лимиты контейнеров являются потолком, а не резервированием ядер.

В локальной конфигурации на loopback публикуются 48033, 48039 (membership-aware signaling) и 48034/48035 (RTC). На сервере reverse proxy направляет WebSocket signaling к broker; RTC TCP/UDP порты доступны клиентам по настройкам firewall и bind address. Browser API и Worker не публикуют host-порты. В Core-сеть входит только API; Worker сохраняет Guard, seccomp, Chromium sandbox и выход через Proxy. Профили Chromium временные, закрытие Activity удаляет их.

## Управление и диагностика

Из `zvonok-browser`:

```sh
docker compose ps
docker compose logs --tail 100 api worker worker-2 broker broker-2 publisher publisher-2
docker compose exec api node -e "fetch('http://127.0.0.1:3000/ready').then(r=>r.json()).then(console.log)"
```

Ожидаемый readiness: `status: ready, workers: 2`. Это проверка инфраструктуры; видео/звук проверяются в звонке. После изменения `.env` повторите `docker compose up -d --build --wait --wait-timeout 180`. Для смены media secret завершите Activity и пересоздайте media-сервисы вместе: `docker compose up -d --force-recreate --wait --wait-timeout 180`.

Остановка Browser с сохранением volumes:

```sh
docker compose down
```

Для отключения функции также задайте `BROWSER_ACTIVITY_ENABLED=false` у backend и `VITE_BROWSER_ACTIVITY=false` у frontend и примените их Compose-команды заново.

| Симптом | Что проверить |
|---|---|
| Compose сообщает отсутствующий ключ | Заполнены оба секрета в `.env`, команда выполняется из нужного каталога |
| Внешняя сеть не найдена | Имя существующей Core-сети или её создание при первом развёртывании |
| `port is already allocated` | Старый Browser/session/acceptance проект занимает 48033/48034/48039; завершите его Activity и остановите именно его |
| `Pool overlaps ...` | Выберите свободную подсеть, согласуйте `BROWSER_SUBNET`, `BROWSER_PROXY_IP`, `BROWSER_GUARD_IP` |
| `all predefined address pools have been fully subnetted` | Docker исчерпал пул сетей; остановите ненужные старые Compose-проекты их командой `down` без `-v` либо настройте Docker address pools. Не удаляйте чужие сети через `prune` |
| Нет пункта Browser в UI | Frontend пересобран с `VITE_BROWSER_ACTIVITY=true`, звонок PRIVATE |
| API Activity отвечает 404 | Backend не пересоздан с `BROWSER_ACTIVITY_ENABLED=true` |
| `BROWSER_UNAVAILABLE` / 503 | Readiness, одинаковый integration key, общая сеть и DNS `browser-api`; второй API с тем же alias в этой сети запускать нельзя |
| Broker отвечает 403 | `BROWSER_UI_ORIGIN` точно совпадает с адресной строкой |
| Третий звонок не может создать Browser | Заняты оба Worker-слота; завершите одну Activity |

`docker compose config` без `--quiet` выводит раскрытые переменные и media secret — не публикуйте такой вывод. `.env*` исключены из Docker build context и Git (кроме примера).

## Переход со старых запусков и ограничения

Если запущен `zvonok-local-browser-session` или `zvonok-browser-session`, он может занимать те же порты. Новый проект не останавливает его автоматически. Проверьте `docker ps`, завершите Activity и остановите старый Browser его прежней Compose-командой. БД и обычный голосовой LiveKit трогать не требуется.

Прежний PNG demo теперь запускается явно через `docker compose -f compose.poc.yaml ...` с `DEV_TOKEN`; его lifecycle-проверки переключены на этот файл. Основному Compose не нужны overlays `compose.integration.yaml` / `compose.main-local.yaml`.

Этот запуск предназначен для клиентов **на компьютере с Docker**. Remote/LAN/VPS требуют WSS/TLS origin, доступного ICE IP, TCP/UDP/TURN и изменений broker/relay. Замена одного `localhost` на домен не сделает удалённый медиапоток рабочим.
