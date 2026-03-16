FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
  apt-get -o Acquire::Retries=10 update; \
  apt-get -o Acquire::Retries=10 install -y --fix-missing --no-install-recommends \
    chromium \
    dumb-init \
    fonts-liberation \
    imagemagick \
    x11vnc \
    xvfb \
  || true; \
  rm -rf /var/cache/apt/archives/partial/*; \
  apt-get -o Acquire::Retries=10 install -y --fix-broken --fix-missing; \
  apt-get -o Acquire::Retries=10 install -y --no-install-recommends \
    chromium \
    dumb-init \
    fonts-liberation \
    imagemagick \
    x11vnc \
    xvfb; \
  rm -rf /var/lib/apt/lists/*

ENV COMPUTERD_BROWSER_PROFILE_DIR=/computerd/state/profile
ENV COMPUTERD_BROWSER_RUNTIME_DIR=/computerd/runtime
ENV COMPUTERD_BROWSER_CONTROL_SOCKET=/computerd/runtime/control.sock
ENV COMPUTERD_BROWSER_VIEWPORT=1440x900
ENV COMPUTERD_BROWSER_DEVTOOLS_PORT=9222
ENV COMPUTERD_BROWSER_VNC_PORT=5900
ENV COMPUTERD_BROWSER_DISPLAY=:99

RUN mkdir -p /computerd/state /computerd/runtime

COPY containers/browser-runtime/agent.mjs /usr/local/bin/computerd-browser-agent.mjs

RUN chmod +x /usr/local/bin/computerd-browser-agent.mjs

EXPOSE 5900 9222

ENTRYPOINT ["dumb-init", "--", "node", "/usr/local/bin/computerd-browser-agent.mjs"]
