"""Settings: config.toml (tunables) + .env (secrets), loaded into one object.

config.toml holds non-secret tunables (cadence, regex, weights). .env holds API
keys and is gitignored — NEVER commit it. See architecture §4 (Config).
"""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # wsb-signals/


def load_env(path: Path) -> dict[str, str]:
    """Tiny .env reader (KEY=VALUE, # comments, optional quotes). No dep on python-dotenv."""
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


@dataclass(frozen=True)
class Settings:
    cfg: dict   # parsed config.toml
    env: dict   # parsed .env
    root: Path

    @classmethod
    def load(cls, root: Path | None = None) -> "Settings":
        root = root or ROOT
        with open(root / "config.toml", "rb") as f:
            cfg = tomllib.load(f)
        env = load_env(root / ".env")
        # Container-native secrets: let the process environment (docker compose env_file /
        # environment, k8s secrets, etc.) supply or override ALPACA_* creds, so no .env file
        # needs to live in the image. The file still works for local/dev runs; env vars win.
        env.update({k: v for k, v in os.environ.items() if k.startswith("ALPACA_")})
        return cls(cfg=cfg, env=env, root=root)

    # --- hot-path accessors ---
    @property
    def ingest(self) -> dict:
        return self.cfg["ingest"]

    @property
    def extract(self) -> dict:
        return self.cfg["extract"]

    @property
    def arctic_base(self) -> str:
        return self.cfg["sources"]["arctic_shift"]["base_url"]

    @property
    def db_path(self) -> Path:
        return self.root / self.cfg["storage"]["db_path"]

    @property
    def data_dir(self) -> Path:
        return self.root / self.cfg["storage"]["data_dir"]

    @property
    def stoplist_path(self) -> Path:
        return self.root / self.extract["stoplist_path"]

    @property
    def whitelist_path(self) -> Path | None:
        p = self.extract.get("whitelist_path")
        return (self.root / p) if p else None

    @property
    def ambiguous_path(self) -> Path | None:
        p = self.extract.get("ambiguous_path")
        return (self.root / p) if p else None

    def alpaca_creds(self) -> tuple[str | None, str | None, str]:
        """(key, secret, data_url) — used by the market funnel in Phase 2."""
        return (
            self.env.get("ALPACA_API_KEY"),
            self.env.get("ALPACA_API_SECRET"),
            self.env.get("ALPACA_DATA_URL", "https://data.alpaca.markets").rstrip("/"),
        )
