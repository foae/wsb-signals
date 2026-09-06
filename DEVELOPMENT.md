# Development and releases

[Project overview and Docker quick start](README.md) · [Deployment and integrations](deploy/v2/README.md)

## Prerequisites
For development/checks: **Node 24 LTS** (`.nvmrc`) and **pnpm 12.3.4** (pinned in `package.json`). Docker is also required for integration tests. Use your Node version manager, then install the pinned package manager:

```bash
npm install --global pnpm@12.3.4
pnpm install --frozen-lockfile
```

Dependency updates retain a **72-hour publication-age safeguard** (`minimumReleaseAge: 4320`), so very recent stable releases are intentionally deferred. Node type declarations stay on the Node 24 line. TypeScript stays on the latest release supported by the Nuxt ESLint toolchain rather than forcing an incompatible major.

Two upstream **optional-peer warnings** remain: Nuxt CLI's `@bomb.sh/tab` declares cac 6 while cac 7 is installed, and the HTML validator declares Vitest up to 3 while this workspace uses 5. Their parents still pin those older adapters; this project does not force out-of-range transitive upgrades. The documented build, lint, CLI and test paths are verified. Scoped esbuild overrides retain security fixes.

The GitHub CLI (`gh`) and push/release permission are required only for publishing releases.

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
