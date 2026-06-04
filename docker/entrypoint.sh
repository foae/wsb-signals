#!/bin/sh
# Radar entrypoint. The ticker whitelist (whitelist/symbols.txt) is a DERIVED artifact — not baked
# into the image — so build it once per container if absent. It needs ALPACA_* in the environment;
# if the build fails (creds missing / Alpaca down) the extractor degrades to cashtag-only rather
# than crash, and the next restart retries. ticker_names persists in the DB volume regardless.
#
# The dashboard service overrides this entrypoint (it only reads the JSON snapshot — touching the
# DB here would contend with the radar's single writer lock).
set -e

if [ ! -f /app/whitelist/symbols.txt ]; then
    if wsb build-whitelist; then
        echo "entrypoint: ticker whitelist built"
    else
        echo "entrypoint: WARNING — build-whitelist failed; extractor falls back to CASHTAG-ONLY" >&2
    fi
fi

exec "$@"
