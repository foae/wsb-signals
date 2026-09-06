# WSB Signals v2 — worker image (interim, single-stage)
#
# Runs the TS worker via tsx (no compile step — @wsb/shared is consumed as TS source via its
# package.json "exports" pointing at ./src/*.ts). tsx transpiles on the fly; this is the correct
# approach until a compiled-JS production build is added.
#
# NODE_ENV is intentionally NOT set to "production": tsx is a devDependency and a production install
# would drop it, breaking the image. The worker is the sole writer; run exactly one container.
#
# Build (from repo root):
#   docker compose -f deploy/v2/compose.yml build worker
#   # or directly:
#   docker build -f deploy/v2/worker.Dockerfile -t wsb-worker:latest .

FROM node:24-slim

# Corepack reads the exact pnpm version from package.json after manifests are copied.
RUN corepack enable

WORKDIR /app

# ── Layer 1: dependency manifests (cache-friendly) ───────────────────────────
# Copy only the files pnpm needs to resolve the workspace dependency graph before
# fetching node_modules. The web package manifest is included so pnpm can parse the
# workspace graph, but --filter @wsb/worker... avoids installing heavy Nuxt deps.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json   packages/shared/package.json
COPY packages/worker/package.json   packages/worker/package.json
COPY packages/web/package.json      packages/web/package.json

RUN corepack install && pnpm install --frozen-lockfile --filter @wsb/worker...

# ── Layer 2: source + runtime assets ─────────────────────────────────────────
COPY packages/shared/src            packages/shared/src
# The migrations folder (packages/shared/drizzle) is resolved by migrations.ts via `new
# URL('../drizzle', import.meta.url)` — it MUST be present in the image or the worker
# will fail to run migrateToLatest on boot.
COPY packages/shared/drizzle        packages/shared/drizzle
COPY packages/worker/src            packages/worker/src

# Tunables (committed, not a secret)
COPY config.toml                    config.toml

# Committed wordlists (stoplist + ambiguous). whitelist/symbols.txt is DERIVED (gitignored);
# the entrypoint builds it at first start via `build-whitelist`.
COPY whitelist/stoplist.txt         whitelist/stoplist.txt
COPY whitelist/ambiguous.txt        whitelist/ambiguous.txt

# Entrypoint script + runtime directories
COPY deploy/v2/entrypoint.sh        /usr/local/bin/wsb-entrypoint
RUN chmod +x /usr/local/bin/wsb-entrypoint
RUN mkdir -p /app/data /app/whitelist

# The worker resolves its project root (config.toml + whitelist/) via findRoot(); the CMD/healthcheck run
# with cwd=/app/packages/worker (`pnpm -C …`), so pin the root explicitly to /app where those assets live.
# Placed after the install layer so a source change doesn't bust the dependency cache.
ENV WSB_ROOT=/app

ENTRYPOINT ["wsb-entrypoint"]
CMD ["pnpm", "-C", "packages/worker", "start"]
