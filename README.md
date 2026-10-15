# Steward

A personal operator agent that lives entirely in a graph. FalkorDB is the only datastore.

> Work in progress for Graph Hacks (WeMakeDevs × FalkorDB), Oct 15–18 2026.
> Planning notes live one folder up: `../PLAN.md`, `../graph-model.md`.

## Layout

```
apps/api      Bun + Hono backend, talks to FalkorDB (one graph per user)
apps/web      (coming) approval inbox + "why did my agent do that?" panel
packages/     shared types, later
```

## Run locally

Requires Bun ≥ 1.4 and Docker.

```bash
bun install
cp .env.example .env
bun run db:up          # FalkorDB on :6379, FalkorDB Browser on http://localhost:3000
bun run dev            # API on http://localhost:8787
curl localhost:8787/health
curl localhost:8787/users/demo/ping
```
