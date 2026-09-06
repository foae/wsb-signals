# WSB Signals contributor guidance

## Project and status

WSB Signals is a TypeScript research application: a WSB attention/market radar and the WSB Plays screenshot-analysis board. Read README.md for setup and CONSERVATION.md for the retired deployment's status. No deployment or archived database is supplied. Daily outcome tracking is not implemented; do not present planned milestones as shipped functionality.

## Sources of truth

Before changing Plays behavior, read design/plays-product.md (including invariants P1–P9) and design/plays-plan.md. Radar math is specified in design/signal-framework.md; architecture §5 and design/v2-porting-spec.md define the parity contract. Agent-facing analysis contracts are in design/plays-analysis.md. Update applicable design documents when behavior changes.

## Layout and checks

- packages/shared: Drizzle schema, migrations, shared contracts.
- packages/worker: ingest, scoring, market data, single-writer persistence, Plays queue and analysis CLIs.
- packages/web: Nuxt SSR web and read-only APIs.
- fixtures: committed JSON regression data; screenshot inputs remain private.
- deploy/v2: portable Docker Compose deployment.

Use Node 24 from .nvmrc and the pnpm version in package.json:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm -C packages/worker test:it  # requires Docker
```

Never commit `.env` files, `.private/`, auth stores, database exports or unredacted screenshots. Public examples must not contain real identities, credentials or private infrastructure. Preserve necessary functional provider/model references; do not add generated-by credits or AI co-author trailers.

## Correctness invariants

- Rank on share of voice, not raw counts or cold-start z. Baselines are forward-only; components are max-normalized, not percentile-ranked.
- Use the shared total ordering (heat, share of voice, authors, mentions, ticker). Missing real prior windows produce null velocity/acceleration.
- Posts and comments have independent coverage requirements. Incomplete/stale coverage prevents scoring; retain independently usable raw data.
- Removed source content does not score. Finalization and removal repairs preserve version/provenance metadata. Published results are read back unconditionally.
- Missing whitelist fails closed to cashtags. Ambiguous symbols require trading context.
- Market return/relative volume are day-to-date, not window-aligned; lead-lag stays disabled. Quadrants require both axes and support.
- Outcomes stay per-post, never per-ticker win rates. The UI intentionally has no financial-disclaimer tagline; do not add one.
- The worker is the sole database writer. The web uses the provisioned read-only role. Recursive timers must not overlap; index.ts owns process handlers.
- Plays has dedicated queue connections, leases and no transaction spanning a network/LLM call. The analyzer seam owns provider clients. Missing credentials/pricing fail closed; spending remains bounded.

## Versioning and releases

The root and all three workspace packages share one semantic version. The historical tags `v0.0.1` and `oracle-final` retain the Python oracle; do not reuse them. New release tags are annotated `vMAJOR.MINOR.PATCH` tags and are immutable once published.

Every shipped change must include a version bump and an accurately named GitHub release. Use patch for compatible fixes/documentation, minor for compatible features, major for breaking contracts. Batch related changes into one release; do not tag unfinished intermediate commits.

1. Implement the change, update the relevant documentation and run the checks above.
2. Run `node scripts/release.mjs prepare X.Y.Z` to align package versions and the application user agent. Refresh the lockfile with `pnpm install --lockfile-only --no-frozen-lockfile`.
3. Write release notes outside the tracked tree (for example `.private/release-notes.md`) describing actual changes, verification and known limitations. Do not claim unfinished milestones are implemented.
4. Commit all release changes and push the release commit to `main` normally. Never add AI authorship trailers. Wait for the **CI** workflow on that exact commit.
5. Run `node scripts/release.mjs publish X.Y.Z "Release title" .private/release-notes.md`. The tool requires a clean main branch, matching local/remote HEAD, successful CI on that SHA, aligned versions and a new tag/release. It creates and pushes an annotated tag and publishes a stable, non-draft GitHub release, then verifies it.
6. If publishing stops after the tag was pushed, investigate first. Never delete, move or silently reuse an existing published tag. After verifying its annotation, target commit and CI, finish an interrupted publication explicitly with `gh release create ... --verify-tag`, or choose a new version. Do not force-push normal releases.

GitHub release notes are the per-release changelog. Repository history was sanitized for the initial TypeScript stable release; original private recovery copies must not be pushed back. Repository visibility is managed separately by the owner.
