# WSB Signals / WSB Plays

A self-hosted research app for exploring r/wallstreetbets attention and individual trades.

- **Radar:** ticker mentions → WSB Heat, with an optional Alpaca market overlay.
- **Plays:** Gain/Loss/YOLO posts → archived screenshots → vision-based position extraction and interpretation.
- **Browse and analyze:** Nuxt boards, filters, ticker history, read-only APIs/CLI and JSON/CSV exports.

TypeScript · Nuxt 4 · PostgreSQL · Docker Compose

**Status:** no hosted service or historical dataset is included; a new deployment collects new data. Daily outcome tracking is not implemented, and human acceptance gates remain incomplete. See [status and limitations](CONSERVATION.md).

This is observational research, not financial advice. Screenshot posts are self-selected; do not infer per-ticker win rates from them.

## Quick start

Requires Docker Engine and Compose v2; no host Node installation is needed.

```bash
git clone https://github.com/foae/wsb-signals.git
cd wsb-signals
cp deploy/v2/.env.example deploy/v2/.env
$EDITOR deploy/v2/.env
```

Before starting, replace both database passwords and update their matching connection URLs; [configuration details](deploy/v2/README.md#configure-before-starting). Keep real credentials private.

```bash
docker compose -f deploy/v2/compose.yml up -d --build
```

Open **http://localhost:3000** for Plays or **/board** for the radar. An empty board is expected initially. The web binds to loopback only.

Without optional credentials, the radar is cashtag-only with no market overlay; Plays capture/media runs, but extraction waits for LLM access. See [integrations](deploy/v2/README.md#integrations-and-llm-operation).

## Documentation

| Topic | Guide |
| --- | --- |
| Configuration, integrations, persistence and operations | [Deployment](deploy/v2/README.md) |
| Installation, repository layout, checks and releases | [Development](DEVELOPMENT.md) |
| Implementation status and known limitations | [Conservation record](CONSERVATION.md) |
| Plays behavior and remaining milestones | [Product](design/plays-product.md) · [Build plan](design/plays-plan.md) |
| Radar scoring and architecture | [Signal framework](design/signal-framework.md) · [TypeScript architecture](design/v2-plan.md) |
| Analysis APIs, CLI and exports | [Analysis guide](design/plays-analysis.md) |
| Regression fixtures and historical source | [Fixtures](fixtures/README.md) · [Parity contract](design/v2-porting-spec.md) |
| Provider references and project history | [Sources](sources/UPDATING.md) · [Roadmap](ROADMAP.md) |
| Contributor and release workflow | [CLAUDE.md](CLAUDE.md) |

## License

Original code and documentation: [MIT](LICENSE). Third-party data, screenshots and dependencies retain their own terms; fixture attribution does not grant redistribution rights.
