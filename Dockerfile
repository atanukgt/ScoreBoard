# scoreboard-live — single container, prod-only deps, non-root
#
# Build:    docker build -t scoreboard-live:latest .
# Run:      docker compose up -d
# Inspect:  docker compose logs -f
#
# Why node:20-bookworm-slim and not alpine:
#   better-sqlite3 ships prebuilt binaries for Debian glibc; on Alpine it
#   always falls back to a from-source build that takes ~5 min and
#   occasionally fails. bookworm-slim is ~80 MB more, but it Just Works.

FROM node:20-bookworm-slim AS runtime

# Avoid apt cache and man-pages in the final image
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=3100 \
    DATA_DIR=/data

WORKDIR /app

# Install production deps first — better layer cache across code changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && chown -R node:node /app

# App source (public + server + minimal deploy files)
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node package.json ./

# /data is mounted as a volume by docker-compose; pre-create so first-run
# doesn't run as root.
RUN mkdir -p /data \
 && chown -R node:node /data

USER node
EXPOSE 3100

# docker-compose HEALTHCHECK overrides this with a curl-friendly path, but
# default to wget which is already installed above.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3100/api/me >/dev/null || exit 1

CMD ["node", "server/index.js"]
