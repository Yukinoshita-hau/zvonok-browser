FROM zvonok-browser-poc-worker:latest
USER root
RUN sed -i -e s@http://azure.archive.ubuntu.com@https://archive.ubuntu.com@g -e s@http://security.ubuntu.com@https://security.ubuntu.com@g /etc/apt/sources.list.d/ubuntu.sources && apt-get -o Acquire::Retries=0 -o Acquire::https::Timeout=20 -o Acquire::http::Timeout=20 update && apt-get -o Acquire::Retries=0 -o Acquire::https::Timeout=20 install -y --no-install-recommends ffmpeg x11-utils && rm -rf /var/lib/apt/lists/*
COPY --chown=1000:1000 experiments/capture /app/experiments/capture
USER 1000:1000
CMD ["node24", "experiments/capture/preflight.mjs"]



