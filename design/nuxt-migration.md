# Storage + Frontend Migration Guide — SUPERSEDED

> **This plan is abandoned.** It described a **hybrid** (keep the Python radar, swap DuckDB→Postgres,
> add a Nuxt SSR frontend). v2 was instead chosen as a **full-stack TypeScript rewrite** — the whole
> worker moves to TS too.
>
> See instead:
> - [`v2-plan.md`](./v2-plan.md) — the authoritative v2 plan (full-stack TS, monorepo, build order, deploy).
> - [`v2-porting-spec.md`](./v2-porting-spec.md) — the Python→TS parity contract.
>
> The original hybrid content is preserved in git history (this file before this commit) if needed.
