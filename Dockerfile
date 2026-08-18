# WSB Signals — one image, two roles (radar writer + dashboard reader), driven by docker-compose.
# Multi-stage: uv builds the locked venv in the builder; the runtime is a lean slim image with just
# the venv + app (no uv, no toolchain). Pinned to the host's uv (0.11.18) for lockfile parity.

# ---- builder: resolve + install deps and the project from uv.lock -------------------------------
FROM python:3.14-slim-trixie AS builder
COPY --from=ghcr.io/astral-sh/uv:0.11.18 /uv /uvx /bin/
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never
WORKDIR /app

# Deps first (cached unless pyproject/lock change), then the project itself.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project
COPY wsb_signals ./wsb_signals
RUN uv sync --frozen

# ---- runtime: venv + app only -------------------------------------------------------------------
FROM python:3.14-slim-trixie AS runtime
WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

COPY --from=builder /app/.venv /app/.venv
COPY wsb_signals ./wsb_signals
COPY config.toml ./config.toml
# Committed wordlists are baked in; symbols.txt is DERIVED (built at container start, see entrypoint).
COPY whitelist/stoplist.txt whitelist/ambiguous.txt ./whitelist/
COPY docker/entrypoint.sh /usr/local/bin/wsb-entrypoint
RUN chmod +x /usr/local/bin/wsb-entrypoint && mkdir -p /app/data /app/whitelist

EXPOSE 8501
# Default role = the radar. The entrypoint builds the whitelist (if missing) then execs the command.
# The dashboard service overrides the entrypoint (it only reads the JSON snapshot — no DB/whitelist).
ENTRYPOINT ["wsb-entrypoint"]
CMD ["wsb", "run"]
