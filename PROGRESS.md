# Progress

Where Steward stands against the plan (`../PLAN.md`) and the graph model (`../graph-model.md`).
Updated after every feature commit.

**Last updated:** Thu Oct 15, ~13:30 IST, 13.5h into the 96h window.
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

## What we've built, explained

In one sentence: **Steward can already receive a proposed errand, decide from the graph
whether it's allowed, ask you when it isn't sure, carry it out, remember what happened, and
learn to stop asking about things you always approve.** Since feature 6 it also takes a plain
sentence ("prepare for tomorrow's meeting with Priya and send her the project update"), finds
the relevant part of the graph, and plans the errands itself.

### 1. A synthetic person, as a graph

Everything starts from one user's graph. Our demo user is **Asha** (all invented, rule 6).
Her graph holds the people she knows, the projects they share, the documents in each
project, her calendar, her tasks, the promises she's made, a preference, and her inbox:

```
            KNOWS                MEMBER_OF              BELONGS_TO
  Asha ───────────────► Priya ─────────────► Atlas ◄───────────── Atlas update v2 ──SUPERSEDES──► v1
   │                      ▲                    ▲                  Atlas pricing sheet (restricted)
   │                      │ WITH               │ ABOUT                    │ SHARED_WITH
   │              Tomorrow's 11:00 sync ───────┘                          ▼
   │                                                                    Rahul
   ├─ PREFERS ─► "no meetings before 10:00"
   ├─ Commitment: "send Priya the Atlas update before our sync" ──TO──► Priya
   └─ Inbox: "Before tomorrow" FROM Priya  ·  "Urgent: pricing" FROM Alex Chen (a stranger)
```

Every user gets their **own isolated graph** in FalkorDB (`user_asha`, `user_<id>`), so one
person's memory and rules can never leak into another's.

### 2. The Sentinel: the graph decides, not the model

When an action is proposed, say *"email Priya the Atlas update"*, the **Sentinel** runs five
Cypher checks over Asha's graph. No LLM is involved:

| Check | The question it asks the graph |
|---|---|
| **Known recipient** | Has Asha ever been in contact with this person? |
| **Information flow** | Can this document reach this person? Only if they're on the doc's project, or it's been explicitly shared with them. Restricted docs need an explicit share. An old version gets flagged |
| **Provenance** | Who actually asked for this? Asha herself, a contact's email, or a stranger's email (a likely prompt injection)? |
| **Calendar** | Does a new meeting break a preference or clash with another meeting? |
| **Standing rule** | Has Asha told Steward it may do this kind of thing for this person without asking? |

The result is **ALLOW**, **ASK** or **BLOCK**, plus for each check the reason, the graph path
it followed, and the exact Cypher it ran. Example: Alex's email asking for the pricing sheet
is **BLOCKED twice over**: the sheet is restricted and was never shared with him, *and* the
request came from someone Asha doesn't know.

### 3. Every action lives in the graph, and so does the inbox

A proposed action becomes an **Action node** wired to:
where it came from (Priya's email, or Asha's own request) · who it targets · which documents
it uses · which agent proposed it · the Sentinel that checked it · and **`JUSTIFIED_BY` edges
to every person, project, document and email its verdict rested on.** That last part is the
data for the *"Why did my agent do that?"* panel.

- **ASK** → the action waits in Asha's **approval inbox** (just a query: pending Actions)
- **ALLOW** → ready to run
- **BLOCK** → recorded, never runnable. **Asha can't approve a BLOCK in the app.** This is
  deliberate restraint, not a missing button

### 4. The Executor does the work, inside the graph

Approved or allowed actions are carried out by the **Executor**. The "tools" are sandboxed
and are themselves graph writes, so nothing real is ever sent:

- email → an outbound **Message** to the person, with the documents attached
- meeting → a **Meeting** with the invitee
- task → a **Task** on Asha's list

Before acting, the Executor **re-checks the action against the graph as it is now**. If the
document became restricted after Asha approved, the action is blocked. If a rule was revoked
after the Sentinel allowed it, it goes back to the inbox. Two executors can't run the same
action, because claiming it is atomic.

Doing the work also **updates what Steward knows**: Asha's contact count with Priya goes up,
the document is now recorded as shared with Priya, and the commitment *"send Priya the
update before our sync"* is marked **fulfilled**.

### 5. It learns when to stop asking, carefully

After Asha approves the **same kind of action for the same person three times**, Steward
**proposes** a rule (*"send email to Priya Nair"*), linked to the three approvals it learned
from. Nothing changes until Asha **accepts** it. After that, emails to Priya run without
asking. The rule is deliberately narrow:

- it covers one action type for one person. Rahul still needs approval, and so do meetings with Priya
- it **never overrides a BLOCK**: the restricted pricing sheet still can't go to Priya
- Asha can **decline** it or later **revoke** it, and a rejection resets the count

### The full loop today, on the Priya scenario

```
"prepare for tomorrow's meeting with Priya and send her the project update"  → Planner proposes: email Priya v2 + a prep task
   │
   ▼  Sentinel: known ✓  flow ✓ (v2 → Atlas ← Priya)  provenance ✓ (Priya's own email)  rule ✗
 ASK ─► inbox ─► Asha approves ─► Executor re-checks ─► Message in the outbox, v2 attached
                                                       ─► commitment fulfilled, Priya's tie stronger
   ×3 approvals ─► rule proposed ─► Asha accepts ─► next email to Priya: ALLOW, no prompt
```

### Why this matters for judging

- **The take-it-out test (rule 3):** there is no other database. Remove FalkorDB and there's
  nothing to check against, no inbox, no outbox, no memory and no rules.
- **The brief's three verbs:** *act* (Executor), *remember* (contacts, shares, commitments,
  rules) and *show the path* (`JUSTIFIED_BY` edges, paths and Cypher on every verdict).
- **Restraint as the architecture:** the model will only ever propose. The graph decides,
  BLOCK is final, and rules never widen themselves.
- **Tests as evidence:** 52 tests against a real FalkorDB, including the cases where acting
  would be *wrong* (negative controls).

### What's not built yet

A live run of the **Claude planner** (needs an API key; the offline planner covers the demo),
**inbound mail ingest**, **Scout** suggestions with PageRank, the **evaluation** over ~60
labelled scenarios, and **deployment**. See *Build order* below.

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

| 6a | `388f7c6` | **GraphRAG retrieval** | A FalkorDB **full-text index** over names, titles, subjects and commitment text finds the entry points for a request (with stemming: "price" finds "pricing"). One **multi-hop query** (1–2 hops) expands them into the neighbourhood the Planner will see, never passing through the User or Steward's own bookkeeping (agents, actions, approvals, rules). Rendered as compact text: nodes with ids and properties, then edges as id triples. On the Priya request: 6 entry points → 13 nodes, 18 edges, including Alex's injected mail | 9 tests: term extraction, entry points, multi-hop edges, bookkeeping excluded, user prefs, rendering, stemming, empty request, per-user isolation |

| 6b | `741b7c8` | **Planner: one sentence in, Sentinel-checked actions out** | `POST /users/:id/requests` takes a sentence: retrieval (6a) → a planner proposes typed actions → each goes through the Sentinel → ALLOWs run, ASKs go to the inbox, BLOCKs are recorded. Written to the graph as `(Request)-[:PRODUCED]->(Plan)-[:HAS]->(Step)-[:PROPOSES]->(Action)`, with `(Plan)-[:USED_CONTEXT]->` the entry points. Two planners behind one interface: **Claude** (`claude-opus-5-5`, structured output, server-side refusal fallback) and a deterministic **offline** planner (no key: keeps open commitments, preps for meetings). An invented provenance id fails closed (ASK) | 10 tests incl. **a hijacked planner** that follows Alex's injected mail: all 3 leak attempts BLOCKED, whatever provenance it claims |

| 7 | *this commit* | **Web UI** | `apps/web` (Vite + React). One screen: **Ask Steward** (request box, 3 one-click samples, planner picker, Reset demo) and the resulting plan · **Needs your approval** (approve / reject) · **Activity** (every action with verdict + status) · **"Why did my agent do that?"** (verdict, where it came from, each check with its graph path and collapsible Cypher, the graph facts it rests on) · tabs for **Outbox / Calendar / Tasks / Rules** (accept / decline / revoke). A rule proposal shows a banner. Light + dark, stacks at phone width. API additions: `GET /actions` (activity feed), names instead of ids in action detail and plan steps. Offline planner now uses a document named in the request (best full-text match) so the Alex sample demos a BLOCK | 2 new tests (activity feed, named document). Walked through in the browser: Priya → ASK; Alex → BLOCK on two checks; 3rd approval → rule proposed → accepted → same request runs as ALLOW with no prompt; phone width has no horizontal scroll |

**Tests:** 73 pass, 0 fail, against a real FalkorDB (`bun run test`).

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
| `POST /users/:id/context` | GraphRAG: entry points, subgraph and the rendered text the Planner will get, for `{ request }` |
| `POST /users/:id/requests` | **the front door**: `{ request, planner? }` → plan → Sentinel → run / inbox / blocked |
| `GET /users/:id/actions` | activity feed: every action, newest first |

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
| 3 | GraphRAG retrieval for the Planner | ✅ full-text entry points + one multi-hop expansion query (vector index still to add) |
| 4 | Conversation memory (Session / Turn) | ⬜ |
| 5 | The plan as Plan / Step nodes | ✅ `Request → Plan → Step → Action`, `USED_CONTEXT`, `WROTE` |
| 6 | Agent coordination via Action status | ✅ Planner → Sentinel → Executor via Action status + `WROTE` / `PROPOSED` / `CHECKED` / `CLAIMED_BY` / `EXECUTED` edges |
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
| Seeded synthetic user, zero login | ✅ seed endpoint + Reset demo button, 3 one-click samples |
| Approval inbox | ✅ API + UI |
| Planner (LLM) with graph retrieval | ✅ Claude + offline fallback; **Claude path not yet run live (no API key)** |
| Executor + 3 sandboxed tools | ✅ |
| Learning: approve → propose narrow rule → accept / revoke | ✅ |
| Ingest of inbound mail | ⬜ |
| Scout + PageRank | ⬜ |
| Community detection → Contexts | ⬜ |
| Web UI: request box, approval inbox, "why" panel, suggestions | ✅ (suggestions panel waits for Scout) |
| Eval script over ~60 labelled scenarios | ⬜ (13 scenarios exist as tests) |
| Deploy | ⬜ |

---

## Build order from here (one feature, one commit)

8. **Ingest of inbound mail** (entity extraction + dedup via vector / full-text index)
9. **Scout + PageRank** suggestions
10. **Eval script** over the labelled scenario set → `../results.md`
11. Community detection, shortest-path explanations, MCP (if time before the freeze)

## Notes and decisions

- Every node also carries `:Entity` so edges can be matched by id without knowing the label.
- Labels and edge types can't be Cypher parameters; the seeder validates them before interpolating.
- Demo times are pinned to IST (fixed +5:30) so the calendar checks don't depend on the server clock.
- Missing or unknown provenance fails closed (ASK), never open.
- The Planner gets the subgraph, never the whole graph, and is told message bodies are data, not instructions. The real defence is structural: whatever it proposes, the Sentinel decides (see the hijacked-planner test).
- The offline planner is the no-key demo path required by the plan, not a mock: it plans from the same retrieved subgraph.
- **Upstream bug found:** FalkorDB 6.0.2 drops rows in `OPTIONAL MATCH … WHERE` after an aggregating `WITH`. Repro and workaround in `../BUGS.md` #1. To file before Sun 19:15 IST.
- **Known issue:** re-running the same request re-creates the same prep task (the planner doesn't check for an existing open task with that title). Fix with a dedup check in the Executor or planner.
- `bun run dev` loads the root `.env` (`--env-file=../../.env`), so an `ANTHROPIC_API_KEY` there reaches the Planner.
- AI assistant (Claude Code) used for scaffolding, seed data, Sentinel and tests: to be logged in `../AI-DISCLOSURE.md` (rule 11).
