# Deploy — v2 interim headless (db + worker)

This ships the v2 TypeScript pipeline as **2 services**: a Postgres database and the worker.
The web frontend (Nuxt SSR, slice 8) is deferred and will be added here when it lands.

The **frozen Python radar is not deployed here** — it is the parity oracle only (see the root
`docker-compose.yml` and `deploy/README.md` if you need to run it).

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
| `wsb-v2-data` | Worker data dir (`/app/data` — `.last_poll`, shadow dumps) | `down` / `restart` |

`docker compose down` stops the containers and preserves both volumes.
`docker compose down -v` stops the containers **and deletes the volumes** (wipes all history — do
not do this unless you intend to start from scratch).

---

## Healthcheck and the freshness runbook

The worker's healthcheck runs `pnpm -C packages/worker heartbeat` every 10 minutes. This is the
same Arctic-Shift freshness probe as the frozen radar. When the container shows `unhealthy` in
`docker compose ps`, follow the runbook in [deploy/README.md §Runbook](../README.md#runbook--arctic-shift-staledown).

---

## Single writer

The advisory lock (`pg_try_advisory_lock`) prevents two worker containers from running
simultaneously against the same Postgres instance. A second worker exits at startup rather than
double-writing. **Do not scale the worker service beyond 1 replica.**
