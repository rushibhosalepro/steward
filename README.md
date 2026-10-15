# Steward

A personal operator agent that lives entirely in a graph. FalkorDB is the only datastore.

> Work in progress for Graph Hacks (WeMakeDevs × FalkorDB), Oct 15–18 2026.
> Planning notes live one folder up: `../PLAN.md`, `../graph-model.md`.

## Layout

```
apps/api      Bun + Hono backend, talks to FalkorDB (one graph per user)
apps/web      Vite + React UI: request box, approval inbox, activity, "why did my agent do that?" panel, outbox / calendar / tasks / rules
packages/     shared types, later
```

## Run locally

Requires Bun ≥ 1.4 and Docker.

```bash
bun install
cp .env.example .env
bun run db:up          # FalkorDB on :6379, FalkorDB Browser on http://localhost:3000
bun run dev            # API on http://localhost:8787 + UI on http://localhost:5173 (turbo runs both)
curl localhost:8787/health
curl localhost:8787/users/demo/ping
curl -X POST localhost:8787/users/demo/seed   # load the synthetic demo world
curl localhost:8787/users/demo/overview       # node and edge counts
bun run test                                  # needs FalkorDB running
```
