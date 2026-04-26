# syntax=docker/dockerfile:1.7
#
# Multi-stage build for LocalSURV.
#
#   stage 1: build the React dashboard (Vite)
#   stage 2: build the Fastify server (tsc) and install prod deps
#   stage 3: slim runtime image with both artifacts colocated
#
# Run as:
#   docker run --rm -it \
#     -p 8787:8787 -p 80:80 -p 443:443 \
#     -v $HOME/.survhub:/data \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -e SURVHUB_SECRET_KEY=$(openssl rand -base64 32) \
#     -e SURVHUB_DATA_DIR=/data \
#     localsurv:latest

ARG NODE_VERSION=20

# ---------- stage 1: web build ----------
FROM node:${NODE_VERSION}-alpine AS web-builder
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages ./packages
RUN npm ci --ignore-scripts --workspace @survhub/web --include-workspace-root
COPY apps/web ./apps/web
COPY tsconfig.base.json ./
RUN npm run build -w @survhub/web

# ---------- stage 2: server build ----------
FROM node:${NODE_VERSION}-alpine AS server-builder
# better-sqlite3 needs a C toolchain to compile its native addon
RUN apk add --no-cache python3 make g++ git
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY packages ./packages
RUN npm ci --workspace @survhub/server --include-workspace-root
COPY apps/server ./apps/server
COPY tsconfig.base.json ./
RUN npm run build -w @survhub/server

# Prune dev dependencies for the runtime copy
RUN npm prune --omit=dev --workspace @survhub/server

# ---------- stage 3: runtime ----------
FROM node:${NODE_VERSION}-alpine AS runtime
RUN apk add --no-cache ca-certificates tini git docker-cli openssh-client \
 && mkdir -p /data /app/apps/server /app/apps/web
WORKDIR /app

# Server runtime code + its pruned node_modules
COPY --from=server-builder /build/package.json /build/package-lock.json ./
COPY --from=server-builder /build/apps/server/package.json ./apps/server/package.json
COPY --from=server-builder /build/apps/server/dist ./apps/server/dist
COPY --from=server-builder /build/node_modules ./node_modules
COPY --from=server-builder /build/apps/server/node_modules ./apps/server/node_modules

# Dashboard static bundle — lives where the server's app.ts looks for it
COPY --from=web-builder /build/apps/web/dist ./apps/web/dist
RUN ln -s /app/apps/web/dist /app/apps/server/web-dist

ENV NODE_ENV=production \
    SURVHUB_PORT=8787 \
    SURVHUB_HOST=0.0.0.0 \
    SURVHUB_DATA_DIR=/data

EXPOSE 8787 80 443

VOLUME ["/data"]

ENTRYPOINT ["tini", "--", "node", "/app/apps/server/dist/index.js"]
