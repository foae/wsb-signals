# Deploy — continuous operation

The radar is only "near-live" if `wsb run` is **always on**: SoV/velocity/accel and the `z`
baselines all assume an uninterrupted 5-min cadence (gaps null out momentum and stall baseline
warming). Two supported ways to keep it running, **Docker Compose (recommended)** or systemd.

---

## Docker Compose (recommended)

One image, two roles, one persisted volume — defined in [`../docker-compose.yml`](../docker-compose.yml).

| Service | Role |
|---|---|
| `radar` | the **single DuckDB writer** — `wsb run`; `restart: unless-stopped`; healthcheck = `wsb heartbeat` |
| `dashboard` | a **reader** — Streamlit over the JSON snapshot (never opens the DB); volume mounted `:ro` |

- **Persistence:** a named volume `wsb-data` holds `data/` (DB + `leaderboard.json` + `.last_poll`).
  It survives `restart`, `down`, and `up` — verified: a `down`/`up` cycle keeps the accumulating DB.
  **Only `docker compose down -v` deletes it** (don't, unless you mean to wipe history).
- **Secrets:** creds come from `./.env` via `env_file` and are read from the process environment
  (`config.py` overlays `os.environ` for `ALPACA_*`) — nothing secret is baked into the image.
- **Whitelist:** `whitelist/symbols.txt` is a derived artifact, rebuilt by the radar entrypoint on
  first start of a fresh container (the committed `stoplist.txt`/`ambiguous.txt` are baked in). To
  refresh the universe later: `docker compose restart radar`.

```bash
cd /home/your-user/Projects/scratch/_random/wsb-signals
cp .env.example .env            # fill ALPACA_API_KEY / ALPACA_API_SECRET
docker compose up -d --build    # build + start radar + dashboard
docker compose logs -f radar    # live cycle logs
docker compose ps               # status (radar shows `healthy` once the heartbeat passes)
docker compose down             # stop; the wsb-data volume (and its data) survives
```

Dashboard: `http://<host>:8501`.

### Networking note (this Incus/LXC host)

Docker-inside-Incus has **no egress on the default bridge** (NAT through the nested netns fails), so
the committed compose uses `network_mode: host` for both services and `build.network: host` for the
image build — the radar needs egress (Arctic-Shift + Alpaca + heartbeat) and the dashboard then binds
`0.0.0.0:8501` on the host directly. **On a normal Docker host:** drop the `network_mode: host` lines
+ `build.network`, and uncomment the bridge `ports: ["8501:8501"]` on the dashboard.

---

## systemd user units (bare-metal alternative)

Templates: `wsb-signals.service` (radar), `wsb-signals-heartbeat.{service,timer}` (watchdog),
`wsb-signals-dashboard.service` (optional). `install.sh` substitutes the project path, points
`ExecStart` at the venv entry points, and enables them.

> **Currently disabled** — we cut over to Docker. To go back to bare-metal, stop Docker
> (`docker compose down`) first to avoid two writers, then:

```bash
uv sync                       # build .venv (the units run .venv/bin/wsb)
./deploy/install.sh           # add --with-dashboard to also serve the board
sudo loginctl enable-linger "$USER"   # survive logout/reboot
systemctl --user status wsb-signals
journalctl --user -u wsb-signals -f
```

---

## Runbook — Arctic-Shift stale/down

Arctic-Shift is the **sole** live tap (PullPush frozen, Reddit API excluded) — **no free fallback**.
When the radar goes `unhealthy` (Docker) / the heartbeat unit fails (systemd), or cycle logs show
`STALE`/`NO-DATA`:

1. The radar keeps polling but **do not trust** signals while stale — the SoV denominator is biased.
2. Re-test: `docker compose exec radar wsb heartbeat` (or `uv run wsb heartbeat`); check if PullPush
   has un-frozen.
3. If down for long, stop the radar rather than publish stale signals. Threshold:
   `heartbeat.max_staleness_seconds` in `config.toml`.

## Notes / caveats

- **Single writer:** DuckDB allows one writer — run exactly one `radar`. The dashboard reads the JSON
  snapshot, never the DB, so it runs alongside safely (mounted `:ro`).
- **Self-healing:** partial polls are discarded + retried; any per-cycle exception is logged and the
  loop continues; `SIGTERM` (Docker stop / systemd stop) shuts down gracefully (clean DB close).
- **Redundant fetching (known):** each 5-min cycle re-pulls the full trailing 1h window (~12×
  overlap) — idempotent and within rate limits, but a smaller incremental poll is a future optimization.
