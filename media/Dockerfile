FROM node:24-bookworm-slim
WORKDIR /media
COPY media/package*.json ./
RUN npm ci
COPY media/*.mjs ./
RUN mkdir /frames /auth && chown 1000:1000 /frames /auth
USER 1000:1000
CMD ["node","publisher.mjs"]
