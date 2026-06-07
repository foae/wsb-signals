# WSB Signals v2 — web image (Nuxt 4 SSR, read-only board)
#
# Multi-stage build:
#   builder — installs deps and runs `nuxt build` → packages/web/.output/
#   runtime — copies only the self-contained .output/ and runs the Nitro server.
#
# A Nitro .output is self-contained: it bundles all node_modules it needs into
# .output/server/node_modules (or inline chunks). The runtime stage copies only
# .output/ and does NOT need a full node_modules tree.
#
# The web is READ-ONLY. It never migrates. It connects to Postgres via the
# read-only role provisioned by the worker on boot (WEB_RO_USER / WEB_RO_PASSWORD).
# NUXT_DATABASE_URL must reference those credentials.
#
# Build (from repo root):
#   docker compose -f deploy/v2/compose.yml build web
#   # or directly:
#   docker build -f deploy/v2/web.Dockerfile --network=host -t wsb-web:latest .

# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:24-slim AS builder

# pnpm via corepack — pinned to match root package.json "packageManager"
RUN corepack enable && corepack prepare pnpm@11.5.2 --activate

WORKDIR /app

# ── Layer 1: dependency manifests (cache-friendly) ───────────────────────────
# Copy only the files pnpm needs to resolve the workspace dependency graph before
# fetching node_modules. --filter @wsb/web... pulls @wsb/shared (consumed as TS
# source by the web build) but skips the worker's heavy deps.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json   packages/shared/package.json
COPY packages/worker/package.json   packages/worker/package.json
COPY packages/web/package.json      packages/web/package.json

RUN pnpm install --frozen-lockfile --filter @wsb/web...

# ── Layer 2: source ───────────────────────────────────────────────────────────
# @wsb/shared is consumed as TS source (package.json "exports" → ./src/*.ts);
# the Nuxt/Vite build bundles it — no separate shared build step needed.
COPY packages/shared/src            packages/shared/src
# shared/drizzle contains the SQL migrations; the web imports schema types from
# @wsb/shared/src, not the migrations, but copy for completeness in case any
# shared utility references it at build time.
COPY packages/shared/drizzle        packages/shared/drizzle
COPY packages/web/                  packages/web/

# Build the Nuxt app → packages/web/.output/
RUN pnpm -C packages/web build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-slim

WORKDIR /app

# Copy only the self-contained Nitro output — no node_modules needed at runtime.
COPY --from=builder /app/packages/web/.output  packages/web/.output

# Nitro server binding — can be overridden at compose/runtime level.
ENV NITRO_PORT=3000
ENV HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=20s \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "packages/web/.output/server/index.mjs"]
