#!/bin/sh
set -e

# The extractor fails CLOSED to cashtag-only without whitelist/symbols.txt (derived, gitignored).
# Build it on first start if missing. Non-fatal: a failure (e.g. missing ALPACA creds) leaves the
# worker in the documented cashtag-only degraded mode rather than refusing to start.
if [ ! -f /app/whitelist/symbols.txt ]; then
  echo "[entrypoint] whitelist/symbols.txt missing — building from the Alpaca universe…"
  pnpm -C packages/worker build-whitelist || echo "[entrypoint] build-whitelist failed — running CASHTAG-ONLY until it succeeds"
fi

exec "$@"
