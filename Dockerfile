FROM node:24-bookworm AS build
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/client/package.json apps/client/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY packages packages
COPY apps apps
COPY scripts scripts
COPY session/fixture.html session/fixture.html
RUN npm run build

FROM node:24-bookworm AS api
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /control && chown 1000:1000 /control && chmod 700 /control
USER 1000:1000
CMD ["node","apps/api/dist/index.js"]

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS worker
USER root
RUN apt-get -o Acquire::Retries=0 -o Acquire::https::Timeout=20 update && apt-get -o Acquire::Retries=0 -o Acquire::https::Timeout=20 install -y --no-install-recommends ffmpeg x11-utils xdotool pulseaudio pulseaudio-utils && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /usr/local/bin/node24
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /control && chown 1000:1000 /control && chmod 700 /control
USER 1000:1000
CMD ["node24","apps/worker/dist/index.js"]

FROM nginxinc/nginx-unprivileged:1.28-alpine AS client
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf

FROM node:24-bookworm AS proxy
COPY infra/proxy*.mjs /
USER 1000:1000
CMD ["node","/proxy.mjs"]


