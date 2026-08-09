# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- dependencies ----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
# argon2 has a native build step; python3/make/g++ are needed to compile it.
RUN apk add --no-cache python3 make g++ \
 && pnpm install --frozen-lockfile --filter @worldcanvas/server...

# ---- build -----------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/server packages/server
RUN pnpm --filter @worldcanvas/server build

# ---- runtime ---------------------------------------------------------------
FROM node:20-alpine AS runtime
RUN corepack enable
# Shelled out to via child_process.spawn (export/queue.ts), not an npm
# dependency — no native binding, just the binary on PATH.
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/migrations ./packages/server/migrations
COPY --from=build /app/packages/server/package.json ./packages/server/

# Tile cache, the baked geo index and exported timelapse files are
# bind-mounted at runtime.
VOLUME ["/var/tilecache", "/var/data", "/var/exports"]

# Don't run as root; the tile cache and export output are the only things
# this process writes.
RUN addgroup -S wc && adduser -S wc -G wc \
 && mkdir -p /var/tilecache /var/exports && chown wc:wc /var/tilecache /var/exports
USER wc

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

WORKDIR /app/packages/server
CMD ["node", "dist/index.js"]
