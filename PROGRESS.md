# Progress

Where Steward stands against the plan (`../PLAN.md`) and the graph model (`../graph-model.md`).
Updated after every feature commit.

**Last updated:** Thu Oct 15, ~11:50 IST, 12h into the 96h window.
**Next gate:** idea locked + scenario set written by **Thu Oct 15, 14:30 IST**.
**Feature freeze:** Sat Oct 17, 09:30 IST.

---

## The idea, in one paragraph

Steward is a personal operator agent, in the spirit of Meta's Muse, that lives entirely in a
graph. FalkorDB is the only datastore. It runs routine errands (email, calendar, tasks)
through sandboxed tools. **The LLM proposes and the graph decides:** before any action
runs, the Sentinel walks the user's graph and returns **ALLOW / ASK / BLOCK** with the
path that justifies it. Approvals become narrow, reviewable, reversible rules, so it asks
less over time without getting looser. Tracks: **T2** (memory and coordination) primary,
**T1** (agents that act on connected data) secondary.

---

## Built so far

| # | Commit | Feature | What it does | Verified by |
|---|---|---|---|---|
| 0 | `7360b2d` | **Scaffold** | Turborepo + Bun workspaces, `apps/api` on Bun + Hono, `falkordb` client, FalkorDB + Browser via docker compose. `graphFor(userId)` gives every user an isolated graph | `/health` and `/users/:id/ping` round-trip a node |
| 1 | `c3dfe34` | **Schema + synthetic demo world** | Indexes on `Entity.id`, `Person.email`, `Meeting.start`. Demo user Asha: 28 nodes / 36 edges: 5 people (one stranger, Alex), 3 projects, 5 docs (v1→v2 of the Atlas update, a restricted pricing sheet shared only with Rahul), tomorrow's 11:00 Priya sync, a task that BLOCKS another, 2 commitments, a no-meetings-before-10 preference, and 2 inbound mails (Priya's real request, Alex's injected one) | 4 tests: counts, multi-hop Priya → meeting → Atlas → latest doc, idempotent reseed |
| 2 | `ad8033e` | **Sentinel** | 5 deterministic Cypher checks: known recipient · information flow · provenance · calendar · standing rule. Most severe failure wins. Each check returns reason + graph path + the exact Cypher | 13 tests, 6 of them negative controls. Live endpoint blocks Alex's request on two grounds |

| 3 | `dcc86de` | **Actions in the graph + approval inbox** | Every proposed action becomes an `Action` node: `DERIVED_FROM` its source (inbound `Message`, or a `Request` node for things the user typed), `TARGETS` the person, `USES` the docs, `PROPOSED` by the Planner, `CHECKED` by the Sentinel, and `JUSTIFIED_BY {check, status}` edges to every entity its verdict rests on. ASK → `pending` (the inbox), ALLOW → `ready`, BLOCK → `blocked`. Approve/reject creates an `Approval` node; **a BLOCK can't be approved in-app**, and nothing is decided twice | 8 tests: graph wiring, inbox, why-panel data, approve, double-decide 409, blocked can't be approved, Request provenance, reject + 404 |

| fix | `296fd14` | **Provenance for Request sources** | User-typed actions derive from a `Request` node; the Sentinel now treats that as the user asking (it would have read as a stranger and blocked on re-check). Sources with no sender ASK | 2 tests |
| 4 | `3e3a7db` | **Executor + sandboxed tools** | Runs `ready` / `approved` actions. Claims atomically (`status → executing` + `CLAIMED_BY` edge), **re-checks against the current graph** (BLOCK → blocked; a once-allowed action that now needs approval → back to the inbox), then acts as graph writes: email → outbound `Message` `TO` the person `ATTACHES` the docs; event → `Meeting` `WITH` the invitee; task → `Task`. Sending makes the recipient a contact (`KNOWS` count +1) and records `SHARED_WITH`. Open commitments the action keeps are marked `fulfilled` with a `FULFILS` edge. Approving now also executes | 12 tests: end-to-end Priya flow, commitment kept, contact memory, claim/execute edges, no double run, pending/blocked refused, doc turned restricted after approval → blocked, rule revoked after ALLOW → back to inbox, calendar, executor pass, task blocking |

| 5 | `17ade50` | **Learning loop (procedural memory)** | After **3 approvals** of the same action type to the same person, a `Rule {status: proposed}` is created, `SCOPED_TO` the person and `LEARNED_FROM` those `Approval` nodes. It does nothing until the user **accepts**; it can be **declined** or later **revoked**. A rejection, decline or revoke restarts the streak. Rules are narrow (one type × one person) and **never override a BLOCK**: the Sentinel consults them only after every other check passes | 13 tests: no early proposal, proposal on 3rd, proposed rule changes nothing, no duplicates, accepted → ALLOW, narrowness (other person / other type still ASK), BLOCK still wins, revoke → ASK, illegal transitions, fresh streak after revoke, rejection resets, decline |

**Tests:** 52 pass, 0 fail, against a real FalkorDB (`bun run test`).

### API so far

| Endpoint | Purpose |
|---|---|
| `GET /health` | lists graphs in FalkorDB |
| `GET /users/:id/ping` | smoke test: writes and reads a User node |
| `POST /users/:id/seed` | resets the user's graph to the demo world |
| `GET /users/:id/overview` | node and edge counts by label and type |
| `POST /users/:id/sentinel/check` | dry-runs the Sentinel on a proposed action |
| `POST /users/:id/actions` | proposes an action: Sentinel verdict + stored as an `Action` node |
| `GET /users/:id/inbox` | pending (ASK) actions awaiting approval |
| `GET /users/:id/actions/:actionId` | one action with checks, source, `JUSTIFIED_BY` entities and decisions (the "why" panel's data) |
| `POST /users/:id/actions/:actionId/approve` · `/reject` | records an `Approval`; approve also executes; 409 if blocked or already decided |
| `POST /users/:id/actions/:actionId/execute` | run one ready/approved action (re-checked first) |
| `POST /users/:id/executor/run` | one Executor pass over everything ready or approved |
| `GET /users/:id/outbox` · `/calendar` · `/tasks` | the sandboxed tools' state, read from the graph |
| `GET /users/:id/rules` | proposed / active / declined / revoked rules, with how many approvals each was learned from |
| `POST /users/:id/rules/:ruleId/accept` · `/decline` · `/revoke` | the only way a rule changes state |

### What the Sentinel decides on the demo world today

| Proposed action | Verdict | Why (from the graph) |
|---|---|---|
| Email Priya the Atlas update v2 (from her mail) | **ASK** | all checks pass, but no standing rule for Priya yet |
| …same, with a rule for Priya | **ALLOW** | `Rule -SCOPED_TO-> Priya Nair` |
| Email Priya the superseded v1 | **ASK** | v1 is superseded by v2 |
| Forward the pricing sheet to Alex (from Alex's mail) | **BLOCK** | restricted + not shared, *and* requested by a stranger |
| Email the pricing sheet to Priya | **BLOCK** | restricted, not shared with her, even though she's on Atlas |
| Share the Orbit roadmap with Priya | **BLOCK** | no path from the doc to her |
| Share the pricing sheet with Rahul | flow **passes** | `Atlas pricing sheet -SHARED_WITH-> Rahul Mehta` |
| Email an address not in the graph | **ASK** | not in your graph at all |
| Meeting tomorrow at 08:00 | **ASK** | breaks the no-meetings-before-10 preference |
| Meeting tomorrow at 11:30 | **ASK** | overlaps "Atlas sync with Priya" |
| Create a task | **ALLOW** | tasks only touch your own list |

---

## Against the plan: the 14 jobs the graph does

| # | Job (from `graph-model.md`) | Status |
|---|---|---|
| 1 | Per-user isolation (multigraph) | ✅ `graphFor(userId)` → `user_<id>` |
| 2 | Ingest inbound mail, keep knowledge current | 🟨 outbound side done: sending updates `KNOWS`, `SHARED_WITH`, commitments. Inbound ingest not yet |
| 3 | GraphRAG retrieval for the Planner | ⬜ (the multi-hop query exists in tests) |
| 4 | Conversation memory (Session / Turn) | ⬜ |
| 5 | The plan as Plan / Step nodes | ⬜ |
| 6 | Agent coordination via Action status | ✅ Planner → Sentinel → Executor via Action status + `PROPOSED` / `CHECKED` / `CLAIMED_BY` / `EXECUTED` edges (Planner itself not built yet) |
| 7 | **Permissions (Sentinel)** | ✅ 5 checks |
| 8 | Tools' state as graph nodes (outbox, calendar, tasks) | ✅ Executor writes them; views read them |
| 9 | Procedural memory (Rules) | ✅ learned from approvals, accepted / declined / revoked by the user |
| 10 | Proactive suggestions (Scout) | ⬜ |
| 11 | PageRank prioritisation | ⬜ |
| 12 | Community detection → Contexts | ⬜ (first cut if behind) |
| 13 | Shortest path for the "why" panel | 🟨 `JUSTIFIED_BY` edges + text paths; no algorithm yet |
| 14 | MCP | ⬜ |

## Against the scope table in `PLAN.md`

| Scope item | Status |
|---|---|
| FalkorDB as the only store | ✅ so far: no other datastore exists |
| Sentinel: 5 Cypher checks | ✅ |
| Seeded synthetic user, zero login | ✅ seed endpoint; no UI yet |
| Approval inbox | ✅ API (no UI yet) |
| Planner (LLM) with graph retrieval | ⬜ |
| Executor + 3 sandboxed tools | ✅ |
| Learning: approve → propose narrow rule → accept / revoke | ✅ |
| Ingest of inbound mail | ⬜ |
| Scout + PageRank | ⬜ |
| Community detection → Contexts | ⬜ |
| Web UI: request box, approval inbox, "why" panel, suggestions | ⬜ |
| Eval script over ~60 labelled scenarios | ⬜ (13 scenarios exist as tests) |
| Deploy | ⬜ |

---

## Build order from here (one feature, one commit)

6. **Planner (LLM) + GraphRAG retrieval:** request → subgraph → structured actions → Sentinel
7. **Web UI:** request box, approval inbox, "why" panel
8. **Ingest of inbound mail** (entity extraction + dedup via vector / full-text index)
9. **Scout + PageRank** suggestions
10. **Eval script** over the labelled scenario set → `../results.md`
11. Community detection, shortest-path explanations, MCP (if time before the freeze)

## Notes and decisions

- Every node also carries `:Entity` so edges can be matched by id without knowing the label.
- Labels and edge types can't be Cypher parameters; the seeder validates them before interpolating.
- Demo times are pinned to IST (fixed +5:30) so the calendar checks don't depend on the server clock.
- Missing or unknown provenance fails closed (ASK), never open.
- **Upstream bug found:** FalkorDB 6.0.2 drops rows in `OPTIONAL MATCH … WHERE` after an aggregating `WITH`. Repro and workaround in `../BUGS.md` #1. To file before Sun 19:15 IST.
- AI assistant (Claude Code) used for scaffolding, seed data, Sentinel and tests: to be logged in `../AI-DISCLOSURE.md` (rule 11).
