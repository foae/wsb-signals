# Deploy — v2 (db + worker + web)

This ships the v2 TypeScript pipeline as **3 services**: a Postgres database, the worker, and the
Nuxt 4 SSR web board.

(The frozen v0.0.1 Python oracle was pruned from `main` — recover it at tag `v0.0.1` if you ever
need to run it.)

---

## Quickstart

```bash
# 1. Fill in credentials — REQUIRED before ANY compose command (config/build/up). compose interpolates
#    ${POSTGRES_PASSWORD} from deploy/v2/.env (the compose-file directory), and `docker compose config`
#    errors if it is unset, so create the .env first.
cp deploy/v2/.env.example deploy/v2/.env
$EDITOR deploy/v2/.env      # set POSTGRES_PASSWORD, ALPACA_API_KEY, ALPACA_API_SECRET

# 2. Build and start
docker compose -f deploy/v2/compose.yml up -d --build

# 3. Tail worker logs (first cycle takes a few seconds after db is healthy)
docker compose -f deploy/v2/compose.yml logs -f worker

# 4. Check status
docker compose -f deploy/v2/compose.yml ps
```

The worker shows `healthy` in `ps` once the first `heartbeat` passes (~3 min start_period).

---

## How the worker starts

1. Waits for `db` to pass its `pg_isready` healthcheck.
2. The entrypoint (`deploy/v2/entrypoint.sh`) checks for `whitelist/symbols.txt`. If missing it
   runs `build-whitelist` (fetches the Alpaca asset universe). A failure here is non-fatal — the
   extractor falls back to cashtag-only mode and the worker continues.
3. The worker process runs `migrateToLatest` on boot (Drizzle migrations from
   `packages/shared/drizzle`) — no separate migration step is needed.
4. The advisory lock prevents a second worker from double-writing. Run exactly one replica.

### Refreshing the whitelist

To rebuild `whitelist/symbols.txt` after the Alpaca universe changes, restart the worker:

```bash
docker compose -f deploy/v2/compose.yml restart worker
```

Or run it directly without restarting the full pipeline:

```bash
docker compose -f deploy/v2/compose.yml exec worker pnpm -C packages/worker build-whitelist
```

> **Note:** the first-start entrypoint only runs `build-whitelist` when `symbols.txt` is *absent*. It
> writes `symbols.txt` before upserting company names to `ticker_names`, so if that DB upsert fails on a
> very first start (e.g. transient DB hiccup), `symbols.txt` exists and later restarts skip the build —
> leaving `ticker_names` empty (display-only; the data path is unaffected). Re-run `build-whitelist`
> (command above) to populate names.

---

## Networking — Incus/LXC host

This compose defaults to `network_mode: host` for both services (and `build.network: host` for
the image build). Docker-inside-Incus/LXC has no egress on the default bridge (NAT through the
nested netns fails), so host networking is required. The worker reaches Arctic-Shift, Alpaca, and
Postgres all via `localhost`.

**`DATABASE_URL` must use `localhost:5432`** (the db service binds on the host's port 5432).

> ⚠ **Port 5432 conflict:** with host networking the db container binds the host's `5432` directly. If
> another Postgres (a system install, or the v0.0.1 stack) already listens there, the db container will
> fail to start. Stop the other service, or remap (which on host networking means changing
> `POSTGRES_*`/the bind — easiest is to free 5432).

### Normal bridge networking (standard Docker host)

If you are running on a host where the default Docker bridge has egress:

1. In `compose.yml`: remove both `network_mode: host` entries and the `build.network: host` key.
2. In `.env`: change `DATABASE_URL` to use the service name instead of localhost:
   ```
   DATABASE_URL=postgres://wsb:changeme@db:5432/wsb_signals
   ```
3. Add `ports: ["5432:5432"]` to the `db` service if external access is needed.

---

## Secrets and volumes

**Secrets** are injected at runtime via `env_file: .env`. Nothing secret is baked into the image.

**Volumes:**

| Volume | Contents | Survives |
|---|---|---|
| `wsb-v2-pg` | Postgres data directory | `down` / `restart` |
| `wsb-v2-data` | Worker data dir (`/app/data` — `.last_poll`) | `down` / `restart` |

`docker compose down` stops the containers and preserves both volumes.
`docker compose down -v` stops the containers **and deletes the volumes** (wipes all history — do
not do this unless you intend to start from scratch).

---

## Healthcheck and the freshness runbook

The worker's healthcheck runs `pnpm -C packages/worker heartbeat` every 10 minutes — an
Arctic-Shift freshness probe (exit 0 OK / 1 stale / 2 down).

Arctic-Shift is the **sole** live tap (PullPush frozen, Reddit API excluded) — **no free fallback**.
When the worker shows `unhealthy` in `docker compose ps`, or cycle logs show `STALE`/`NO-DATA`:

1. The worker keeps polling but **do not trust** signals while stale — the SoV denominator is biased.
2. Re-test: `docker compose exec worker pnpm -C packages/worker heartbeat`.
3. If down for long, stop the worker rather than publish stale signals. Threshold:
   `heartbeat.max_staleness_seconds` in `config.toml`.

---

## Web service (Nuxt 4 SSR read-only board)

The `web` service serves the read-only leaderboard at **http://localhost:3000** (host networking)
or via the configured port mapping on a normal bridge host.

### Read-only role model

The web never connects as the writer role and never migrates. Instead:

1. The **worker** provisions a read-only Postgres role on boot (`ensure-read-role.ts`), using the
   credentials in `WEB_RO_USER` and `WEB_RO_PASSWORD`. It grants `SELECT` on all current and future
   public-schema tables.
2. The **web** connects via `NUXT_DATABASE_URL`, which must use those same credentials.

**Implication:** the web service requires the worker to have run at least once. On a brand-new
deployment, bring up the worker first (or let `depends_on: db: healthy` order sort it — the worker
will provision the role before the web's first request arrives, since `start_period: 20s` on the web
healthcheck gives the worker time to boot). Until the role exists the web `/api/board` returns a
transient `503` and the **healthcheck** (`/api/health`, which runs a real `SELECT 1` over the read-only
pool) reports the container `unhealthy` — both self-heal the moment the worker finishes provisioning.

### Degraded behavior (near-live, "stale > nothing")

`/api/board` is route-cached **60s with stale-while-revalidate**. Two consequences worth knowing:

- During a **sustained DB outage** *after* a good response is cached, Nitro keeps serving the last good
  board (revalidation fails in the background) rather than erroring. This is intentional for a near-live
  observational board — but it means the board can age silently. The **stale-data banner** surfaces it
  once `now − newest_utc` crosses `max_staleness_seconds`; the `/api/health` probe will already be
  `unhealthy` (it hits the DB), so rely on container health, not the board, to detect an outage.
- A cold cache + DB down returns the `503` error banner (no cached payload to fall back to).

### Config coupling — window and staleness constants

The web UI uses `NUXT_WINDOW_SECONDS` and `NUXT_MAX_STALENESS_SECONDS` to display the correct
aggregation window and flag stale data. These **must stay in sync** with the matching tunables in
`config.toml` (`window_seconds` and `max_staleness_seconds`). If you change either value in
`config.toml`, set the corresponding `NUXT_*` env var in `.env` to match. Drift here is a display
bug — the board will show an incorrect window label or flag data as stale at the wrong threshold.

### Accessing the board

- **Host networking (Incus/LXC default):** http://localhost:3000 — reachable from the host directly;
  no port mapping needed.
- **Normal bridge networking:** add `ports: ["3000:3000"]` to the `web` service in `compose.yml` and
  update `NUXT_DATABASE_URL` to use the `db` service name (see `.env.example` comment and the
  [Networking section](#networking--incuslxc-host) above).

---

## Single writer

The advisory lock (`pg_try_advisory_lock`) prevents two worker containers from running
simultaneously against the same Postgres instance. A second worker exits at startup rather than
double-writing. **Do not scale the worker service beyond 1 replica.**
