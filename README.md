# WSB Signals / WSB Plays

A self-hosted research application for exploring r/wallstreetbets attention and screenshot posts. It combines a ticker radar with a browseable board of individual trades:

- **Radar:** ingest posts/comments from Arctic-Shift, extract ticker mentions, calculate share-of-voice-based WSB Heat, and optionally overlay Alpaca market data as Market Heat.
- **Plays:** capture Gain/Loss/YOLO posts, archive media, extract positions with a vision model, validate the extraction, and interpret it using stored market and community evidence.
- **Web and analysis:** Nuxt server-rendered boards, filters, ticker history, read-only analysis APIs/CLI, and JSON/CSV exports.

This is observational research, not financial advice or a predictive trading system. Screenshot posts are self-selected and gains are overrepresented; outcomes must not be aggregated into per-ticker win rates.

## Status and limitations

The previous deployment was retired; **no hosted service, database or screenshot archive is included**. New deployments collect new data. The TypeScript stable release includes the implemented radar and Plays capture/extraction/interpretation/web functionality, not every planned milestone:

- Daily outcome tracking is **not implemented**; the detail page's outcome section is a placeholder.
- Human acceptance gates for extraction, interpretation and browsing remain incomplete.
- Reprocessing and some operational tooling remain unfinished.
- Arctic-Shift is the sole active source. Incomplete or stale source coverage prevents scoring.
- Market returns and relative volume are day-to-date, not window-aligned; lead-lag is disabled. Free IEX data has limited market coverage.
- LLM extraction requires your own provider access. Committed model settings record an evaluated configuration, not guaranteed availability or current API prices.

See [CONSERVATION.md](CONSERVATION.md) and [the build plan](design/plays-plan.md) for details.

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/shared` | Drizzle/PostgreSQL schema, migrations and shared contracts |
| `packages/worker` | Ingest/scoring worker, Plays queue, media/LLM processing and analysis CLIs |
| `packages/web` | Nuxt 4 SSR boards and read-only APIs |
| `config.toml` | Non-secret tunables, provider/model selection and spending limits |
| `deploy/v2` | Dockerfiles, Compose deployment and sanitized environment example |
| `fixtures` | JSON parity and extraction fixtures; screenshot images are not distributed |
| `design` | Product specifications, architecture, scoring math and analysis contracts |
| `sources` | Data-provider references and access limitations |
| `scripts/release.mjs` | Version alignment and guarded GitHub publication |

## Prerequisites

For deployment: Docker Engine with Docker Compose v2, network access to the configured data providers, and disk space for PostgreSQL and captured media. The supplied stack uses PostgreSQL 18 and Node 24 images; no host Node installation is required for Docker deployment.

For development/checks: **Node 24 LTS** (`.nvmrc`) and **pnpm 12.3.4** (pinned in `package.json`). Docker is also required for integration tests. Use your Node version manager, then install the pinned package manager:

```bash
npm install --global pnpm@12.3.4
pnpm install --frozen-lockfile
```

Dependency updates retain a **72-hour publication-age safeguard** (`minimumReleaseAge: 4320`), so very recent stable releases are intentionally deferred. Node type declarations stay on the Node 24 line. TypeScript stays on the latest release supported by the Nuxt ESLint toolchain rather than forcing an incompatible major.

Two upstream **optional-peer warnings** remain: Nuxt CLI's `@bomb.sh/tab` declares cac 6 while cac 7 is installed, and the HTML validator declares Vitest up to 3 while this workspace uses 5. Their parents still pin those older adapters; this project does not force out-of-range transitive upgrades. The documented build, lint, CLI and test paths are verified. Scoped esbuild overrides retain security fixes.

The GitHub CLI (`gh`) and push/release permission are required only for publishing releases.

## Quick start: Docker Compose

```bash
git clone https://github.com/foae/wsb-signals.git
cd wsb-signals
cp deploy/v2/.env.example deploy/v2/.env
```

Edit `deploy/v2/.env` **before starting**:

1. Replace both example database passwords with independent generated passwords.
2. Keep `POSTGRES_*` and the worker's `DATABASE_URL` consistent.
3. Keep `WEB_RO_*` and the web's `NUXT_DATABASE_URL` consistent. Percent-encode special characters in URL passwords.
4. Leave optional integration credentials empty unless you intend to use them.

```bash
docker compose -f deploy/v2/compose.yml up -d --build
docker compose -f deploy/v2/compose.yml ps
docker compose -f deploy/v2/compose.yml logs -f worker
```

Open **http://localhost:3000** for Plays, **/board** for the radar, or **/api/analysis** for analysis discovery. An empty board is expected until usable data has been collected and finalized. The worker applies migrations and creates the web's read-only database role; initial web health can briefly fail during that setup.

PostgreSQL is internal to the Compose network; the web port binds to loopback only. The web receives only its read-only database URL, not worker/provider secrets. Configure a reverse proxy and appropriate access controls yourself before exposing it remotely. This is not a multi-tenant authenticated service.

Stopping with `docker compose -f deploy/v2/compose.yml down` preserves named volumes. Adding `-v` **permanently deletes database and media history**. See [the deployment guide](deploy/v2/README.md) for persistence, optional OAuth configuration and operations.

## Configuration and integrations

Real credentials belong in ignored `.env` files or `.private/`, never tracked TOML, screenshots, logs or release notes. The public environment example lists the supported keys.

- **Arctic-Shift:** configured in `config.toml`; no API key is required. Starting the worker contacts the source. Its freshness probe reports stale/down conditions; do not treat old board data as current.
- **Alpaca (optional):** `ALPACA_API_KEY` and `ALPACA_API_SECRET` enable the market overlay and whitelist builder. Without them the radar is empirical-only and ticker extraction falls back to cashtags. The worker attempts a whitelist build on startup; failure is non-fatal.
- **LLM (optional):** the committed configuration selects OAuth. Base Compose deliberately has no auth-file mount, so capture/media can run while extraction waits at `media_ready`. Follow the optional overlay instructions in the deployment guide to supply credentials. Merely setting `OPENAI_API_KEY` does **not** change the selected provider.
- **Platform API alternative:** explicitly select `openai` and available models in `[plays.llm]`, set `OPENAI_API_KEY`, verify current non-zero model prices and `daily_budget_usd`, then rerun the extraction evaluation with redacted image inputs. Missing credentials/prices fail closed. Subscription prices are notional and must not be reused as platform billing rates without verification.

Captured media and OAuth stores may contain sensitive information. Keep them private and apply your own retention/access policy. JSON fixtures retain public source-post provenance where needed for evaluation; they do not include brokerage screenshots.

## Development and verification

From the repository root, with the pinned toolchain installed:

```bash
pnpm typecheck
pnpm test                         # unit + golden-fixture parity tests; no Docker
pnpm lint
pnpm build                       # Nuxt production SSR build
pnpm -C packages/worker test:it   # isolated PostgreSQL containers; Docker required
pnpm -C packages/worker heat-extract-eval
```

The worker consumes TypeScript through `tsx`; shared contracts are source exports, not separately built packages. To run a local worker against your own PostgreSQL instance, inject `DATABASE_URL` and optional provider variables into its environment and use `pnpm -C packages/worker dev`. Run `pnpm -C packages/web dev` with `NUXT_DATABASE_URL` pointing to the read-only role the worker provisions. Do not reuse the Compose-only `db` hostname outside its network. Environment files are not implicitly loaded by the worker CLI; export them in your shell or use your process manager's environment-file support.

Analyze an already-running local deployment:

```bash
pnpm -C packages/worker analyze -- catalog --pretty
pnpm -C packages/worker analyze -- ticker NVDA --from 2026-08-01 --to 2026-08-21 --pretty
```

`WSB_ANALYSIS_URL` overrides the default `http://localhost:3000`. Queries over dates with no stored data return no evidence. Direct exports require a database connection; see [design/plays-analysis.md](design/plays-analysis.md).

## Versioning and releases

All workspace packages share semantic versions. Each shipped change gets a version bump, an immutable annotated `vX.Y.Z` tag, and a stable GitHub release with an accurate title and notes. CI must pass on the **exact commit being tagged**.

```bash
node scripts/release.mjs prepare X.Y.Z
pnpm install --lockfile-only --no-frozen-lockfile
# Verify, commit, push main, and wait for its CI run.
node scripts/release.mjs publish X.Y.Z "Release title" .private/release-notes.md
```

The publish command checks clean state, matching remote HEAD, aligned versions, successful CI and absence of an existing tag/release. It then tags, pushes, publishes and verifies. See [CLAUDE.md](CLAUDE.md) for the full contributor/release workflow, including interrupted-publication recovery. GitHub release notes serve as the changelog.

Historical tags `v0.0.1` (Python radar) and `oracle-final` (Python plus fixture tools) are retained for reproducibility; they are not versions of the current TypeScript packages. Public preparation rewrites their history to remove private material and authorship credits. Old commit IDs may not resolve; old clones/caches cannot be erased by rewriting this remote. See [fixtures/README.md](fixtures/README.md) before regenerating fixtures.

## Design references

- [Plays product and invariants](design/plays-product.md)
- [Plays implementation plan](design/plays-plan.md)
- [Radar scoring framework](design/signal-framework.md)
- [TypeScript architecture](design/v2-plan.md) and [parity contract](design/v2-porting-spec.md)
- [Analysis API/CLI and canonical SQL](design/plays-analysis.md)
- [Historical roadmap](ROADMAP.md) and [provider documentation](sources/UPDATING.md)

## License

Original project code and documentation are [MIT licensed](LICENSE). Third-party dependencies retain their own licenses. Reddit posts, broker screenshots, market data and other third-party material are not relicensed by this project; source attribution in fixtures does not grant redistribution or commercial-use rights. Follow the relevant providers' terms and obtain any permissions your use requires.
