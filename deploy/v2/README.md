# Deploy v2

This deployment runs three Compose services: PostgreSQL, one worker, and the Nuxt read-only board.
The base stack uses ordinary Docker Compose bridge networking. PostgreSQL is private to the Compose
network; the board is published only at `http://127.0.0.1:3000` on the Docker host.

## Configure before starting

Copy the tracked template to the ignored runtime environment file and replace its placeholder
passwords. Keep this file private.

```bash
cp deploy/v2/.env.example deploy/v2/.env
$EDITOR deploy/v2/.env
```

The required database values must agree:

```dotenv
DATABASE_URL=postgres://wsb:<writer-password>@db:5432/wsb_signals
POSTGRES_USER=wsb
POSTGRES_PASSWORD=<writer-password>
POSTGRES_DB=wsb_signals
WEB_RO_USER=wsb_web
WEB_RO_PASSWORD=<read-only-password>
NUXT_DATABASE_URL=postgres://wsb_web:<read-only-password>@db:5432/wsb_signals
```

Percent-encode URL-reserved characters in the two connection URLs. Do not place credentials in
`compose.yml`, Docker build arguments, or source control.

The following command is an operator action; it builds images and starts the services. Once the
worker starts, its normal polling loop may contact the integrations configured in `.env`.

```bash
docker compose -f deploy/v2/compose.yml up -d --build
```

Useful lifecycle commands:

```bash
docker compose -f deploy/v2/compose.yml ps
docker compose -f deploy/v2/compose.yml logs -f worker
docker compose -f deploy/v2/compose.yml logs -f web
docker compose -f deploy/v2/compose.yml down       # preserves named volumes
docker compose -f deploy/v2/compose.yml down -v    # permanently removes database and media history
```

## Networking and persistence

Compose supplies a bridge network and service DNS. Both the worker and web use the hostname `db`
to reach PostgreSQL; there is deliberately no database `ports` mapping. The only published port is:

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

This makes the board available to processes on the Docker host but not directly to the LAN. Put a
separately configured reverse proxy in front of it if remote access is required; do not expose the
database merely to access the board.

Named volumes persist across container restarts and `docker compose down`:

| Volume | Contents |
| --- | --- |
| `wsb-v2-pg` | PostgreSQL data |
| `wsb-v2-data` | Worker state, including `.last_poll` |
| `wsb-v2-media` | Captured play media; worker writes and web mounts it read-only |

Only `docker compose down -v` deletes these volumes. Treat it as an intentional history wipe.

## Startup order and roles

`db` must pass `pg_isready` before worker or web starts. The worker is the only database writer: it
runs migrations on boot, takes an advisory lock so a second worker exits rather than double-writing,
and provisions the `WEB_RO_*` PostgreSQL role. Do not scale the worker beyond one replica.

The web service never migrates and connects through `NUXT_DATABASE_URL`. Its role permits reads
only, and its media mount is read-only. On a new database, the web can briefly return a transient
failure until the worker has completed its first boot and created the role; it self-recovers after
that provisioning finishes.

The worker entrypoint attempts to build its derived ticker whitelist only when the file is absent.
A failed build (for example, because market-data credentials are absent) is non-fatal: the worker
continues in its documented cashtag-only mode. The worker's migration and media archive paths do
not depend on OAuth credentials.

## Integrations and LLM operation

`ALPACA_API_KEY` and `ALPACA_API_SECRET` are optional. When they are absent, the worker remains
usable in empirical-only/cashtag-only degraded mode. Supplying them authorizes the normal worker
runtime to use the configured market-data integration.

The base Compose file clears `CODEX_AUTH_FILE` and does **not** mount an OAuth file, so the default
stack starts without OAuth and retains capture and media work while extraction waits at `media_ready`.

`OPENAI_API_KEY` in `.env` is only a platform-key injection point. It does not switch the committed
provider by itself. Before changing the application configuration to the `openai` provider, choose
and validate the platform models, confirm every selected model has a non-zero pricing entry, and
run the appropriate evaluation. The existing pricing guard must remain fail-closed: missing or zero
prices refuse LLM dispatch.

### Optional OAuth mount

Keep optional OAuth material in two local files that match the repository's ignored `.env.*` rule;
never add either to git. Create a valid credential file by your approved authentication process at
`deploy/v2/.env.codex-auth.json`, then create this private Compose overlay at
`deploy/v2/.env.oauth.yml`:

```yaml
services:
  worker:
    environment:
      CODEX_AUTH_FILE: /app/secrets/codex-auth.json
    volumes:
      - type: bind
        source: ./.env.codex-auth.json
        target: /app/secrets/codex-auth.json
        read_only: true
```

Use the overlay only when the committed application configuration selects the OAuth provider:

```bash
docker compose \
  -f deploy/v2/compose.yml \
  -f deploy/v2/.env.oauth.yml \
  up -d --build
```

The credential file is mounted read-only and has a generic repository-relative path. The base stack
never references it, so a deployment without OAuth requires neither file nor a host-specific path.

## Health and operations

The worker healthcheck runs its freshness probe every 10 minutes. A healthy container means that
probe completed successfully; an unhealthy worker can indicate stale or unavailable ingest data, so
do not treat board output as current until the source is healthy again.

The web healthcheck queries `/api/health`, which verifies its read-only database connection. Its
container can therefore be temporarily unhealthy during first-boot role provisioning or a database
outage even if a previously cached board response remains visible.

The worker uses structured JSON logs. Follow them with:

```bash
docker compose -f deploy/v2/compose.yml logs -f worker
```

For a manual whitelist refresh after credentials are configured, an operator may run:

```bash
docker compose -f deploy/v2/compose.yml exec worker pnpm -C packages/worker build-whitelist
```

That command contacts the configured market-data integration; it is not required merely to create
or inspect the deployment configuration.
