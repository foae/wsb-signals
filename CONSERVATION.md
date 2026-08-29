# Conservation record

The original deployment was retired on 2026-08-29. Its database and media volumes were deleted without an export. No hosted service or historical dataset is provided by this repository. A new deployment starts with an empty database and captures new data.

## Implementation status

- The TypeScript radar, scoring, market overlay, persistence and web board are implemented.
- Plays capture, media processing, extraction, interpretation and browsing are implemented.
- The original extraction evaluation passed its machine gate; the owner review was not completed. Interpretation and browsing acceptance gates also remain incomplete.
- Daily outcome tracking (P5) is not implemented. The schema and pure marking helper are not a running outcome service.
- Read-only analysis API, CLI and exports are implemented; reprocessing and operational polish remain incomplete.

A stable repository release describes the shipped code, not completion of every planned Plays milestone. See [the build plan](design/plays-plan.md) and the open GitHub issues for remaining work.

## Restarting

Use the portable setup in [README.md](README.md) and [deploy/v2/README.md](deploy/v2/README.md). Historical machine provisioning instructions are intentionally not part of the public repository.

1. Install the pinned Node/pnpm toolchain and run the documented checks.
2. Copy the deployment environment example and generate independent database passwords. Keep real configuration in ignored `.env` files or `.private/`.
3. Start PostgreSQL, worker and web with Docker Compose. The worker applies migrations and provisions the web's read-only role.
4. Verify source freshness. Arctic-Shift is the only active source; incomplete or stale source coverage prevents radar publication by design.
5. Configure optional Alpaca credentials for market data and the ticker whitelist. Without a whitelist, extraction deliberately falls back to cashtags only.
6. Enable LLM extraction only after selecting an available provider/model, establishing fresh credentials, verifying the configured prices and budget, and rerunning the labeled evaluation with appropriately redacted images.

No credential or OAuth session from the retired deployment should be assumed valid. OAuth model references and notional subscription prices in `config.toml` record the evaluated configuration; they are not a promise of provider access or current platform pricing. Missing credentials or prices fail closed.

## Historical source and fixtures

- `v0.0.1` preserves the original Python radar.
- `oracle-final` preserves the Python radar and fixture-generation tools.
- [fixtures/README.md](fixtures/README.md) explains regeneration. Committed JSON fixtures support Docker-free parity checks; screenshot inputs are not distributed.

Public-preparation history rewriting sanitizes both historical snapshots. Old commit IDs, signatures and links may no longer resolve. Recovery copies containing the original private history must remain private; rewriting cannot erase other clones or provider caches.
