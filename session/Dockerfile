FROM zvonok-browser-poc-api:latest AS build
USER root
COPY tsconfig*.json /app/
COPY packages /app/packages
COPY apps /app/apps
COPY session/fixture.html /app/session/fixture.html
RUN npm run build

FROM zvonok-browser-poc-api:latest AS api
COPY --from=build --chown=1000:1000 /app /app

FROM zvonok-browser-capture:2b1 AS worker
USER root
RUN apt-get -o Acquire::Retries=0 -o Acquire::https::Timeout=20 update && apt-get -o Acquire::Retries=0 -o Acquire::https::Timeout=20 install -y --no-install-recommends pulseaudio pulseaudio-utils && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=1000:1000 /app /app
USER 1000:1000
CMD ["node24","apps/worker/dist/index.js"]

FROM zvonok-browser-poc-client:latest AS client
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
COPY session/nginx.conf /etc/nginx/conf.d/default.conf
