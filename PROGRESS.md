# Progress

Where Steward stands against the plan (`../PLAN.md`) and the graph model (`../graph-model.md`).
Updated after every feature commit. Times are IST and taken from the commit log.

**Last updated:** Thu Oct 15, 12:46 IST · 13.5h into the 96h window · 122 tests passing.

| Gate (from `../CHECKLIST.md`) | Due | Status |
|---|---|---|
| Idea locked, graph model final, labelled scenarios written, criteria asked on Discord | Thu 14:30 | ✅ except **asking about judging criteria on Discord** (yours to do) |
| Seeded graph + Sentinel + Planner + Executor working end to end on the Priya flow | Fri 12:00 | ✅ done Thu 12:06 |
| **Feature freeze**, scorecard filled, corpus run, both rates published | Sat 09:30 | eval done; freeze is 45h away |
| Deployed, seeded, zero-login, no-key fallback, incognito + phone | Sun 00:00 | ⬜ not started |
| Video, README, blog post, upstream bugs filed | Sun 19:15 | ⬜ |

---

## The idea, in one paragraph

Steward is a personal operator agent, in the spirit of Meta's Muse, that lives entirely in a
graph. FalkorDB is the only datastore. You give it a sentence; it finds the relevant part of
your graph, plans the errands (email, calendar, tasks), and runs them in sandboxed tools.
**The model proposes and the graph decides:** before anything runs, the Sentinel walks your
graph and returns **ALLOW / ASK / BLOCK** with the path that justifies it. Approvals become
narrow, reviewable, reversible rules, so it asks less over time without getting looser. It
also reads incoming mail into the graph and, like Muse, suggests things before you ask.
Tracks: **T2** (memory and coordination) primary, **T1** (agents that act on connected data).

---

## What we've built, explained

In one sentence: **you type an errand; Steward finds what it's about in your graph, plans it,
checks every step against the graph, does what's safe, asks about what isn't sure, blocks
what would leak, remembers what happened, learns what you always approve, keeps the graph
current from your mail, and tells you what needs attention before you ask.**

### 1. A synthetic person, as a graph

Everything starts from one user's graph. The demo user is **Asha** (all invented, rule 6):
the people she knows, the projects they share, the documents in each project, her calendar,
tasks, promises, a preference, and her inbox.

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

Every user gets their **own isolated graph** in FalkorDB (`user_<id>`), so one person's
memory and rules can never leak into another's.

### 2. From a sentence to a plan: graph retrieval + the Planner

*"Prepare for tomorrow's meeting with Priya and send her the project update."*

- **Retrieval (GraphRAG).** A FalkorDB **full-text index** finds what the sentence is about
  (Priya, her meeting, the Atlas update), always keeping the best-matching people. **One
  multi-hop query** then pulls in everything 1–2 hops away: her project, the latest version
  of the doc, the promise Asha made her, the task that's blocked, her email. The Planner
  sees only this neighbourhood, never the whole graph.
- **The Planner** turns that into typed actions. Two planners share one interface: **Claude**
  (`claude-opus-5-5`, structured output), an OpenAI-compatible planner for **Grok, Gemini, Groq,
  OpenRouter or a local Ollama model**, and an **offline** planner that needs no key. If an LLM
  fails, Steward falls back to offline and says so. Either way, the planner only *proposes*.
- The whole chain is stored: `Request → Plan → Step → Action`, plus which nodes the plan used.

### 3. The Sentinel: the graph decides, not the model

Every proposed action goes through five **Cypher checks**. No LLM is involved:

| Check | The question it asks the graph |
|---|---|
| **Known recipient** | Has Asha ever been in contact with this person? |
| **Information flow** | Can this document reach this person? Only if they're on its project or it was explicitly shared with them. Restricted docs need an explicit share. An old version gets flagged |
| **Who asked for this** | Asha herself, a contact's email, or a stranger's email (a likely prompt injection)? |
| **Calendar** | Does a new meeting break a preference or clash with another meeting? |
| **Standing rule** | Has Asha told Steward it may do this for this person without asking? |

Result: **ALLOW**, **ASK** or **BLOCK**, and for each check the reason, the graph path and the
exact Cypher. Alex's email asking for the pricing sheet is **BLOCKED twice over**: the sheet
is restricted and never shared with him, *and* a stranger asked. A test plays a **hijacked
planner** that obeys Alex's email: all three leak attempts are blocked, whatever it claims.

### 4. Actions live in the graph; the Executor does the work

Each action is an `Action` node linked to where it came from, who it targets, what it uses,
which agents touched it, and **`JUSTIFIED_BY` edges to every fact its verdict rests on**
(the data behind the *"Why did my agent do that?"* panel).

- **ASK** → Asha's approval inbox · **ALLOW** → runs · **BLOCK** → recorded, and **can't be
  approved in the app**. That's deliberate restraint, not a missing button.
- The **Executor** claims an action atomically, **re-checks it against the graph as it is
  now**, then acts. The tools are sandboxed graph writes: an outbound `Message` with
  attachments, a `Meeting`, a `Task`. Nothing real is ever sent.
- Doing the work **updates what Steward knows**: the contact gets stronger, the document is
  recorded as shared, the promise to Priya is marked **fulfilled**.

### 5. It learns when to stop asking, carefully

Three approvals of the **same kind of action for the same person** → Steward **proposes** a
rule (*"send email to Priya Nair"*), linked to those approvals. Nothing changes until Asha
**accepts** it. Rules are narrow (one type, one person), **never override a BLOCK**, and can
be declined or revoked; a rejection resets the count.

### 6. It keeps the graph current from incoming mail

A new mail is resolved into the graph, deterministically:
the **sender** by email (an unknown sender becomes a stranger with no `KNOWS` edge),
**mentions** matched to existing people, projects and documents (no duplicates, never an
old version), and a **request** ("could you send me…") from a contact becomes a *proposed*
commitment. The same request from a stranger only **flags** the mail.

### 7. Scout suggests things before you ask

Scout runs six graph queries: promises due soon, requests to take on, people waiting for a
reply, blocked tasks, meetings with no prep, flagged mail. It ranks them by urgency and by
**PageRank over Asha's graph** ("#1 of 5 people by centrality"). Suggestions are graph nodes:
they don't duplicate, dismissals stick, and they **resolve themselves** when the graph changes.
**Scout never acts:** "Do it" sends a request through the Planner and Sentinel like any other.

### 8. Any agent can use it over MCP, but can't approve

Steward's graph is also an **MCP server** (HTTP and stdio): search, graph context, shortest
path between two things, PageRank, a Sentinel dry run, propose an action, run a request,
the inbox, explain an action, Scout's suggestions. An outside agent (Claude Desktop, Claude
Code, anything that speaks MCP) gets the same guarantees as Steward's own planner: everything
it proposes goes through the Sentinel, and there is **no approve tool**, so only a human can
let an ASK through and nothing can let a BLOCK through.

### 9. One screen to see it all

The web UI shows: Ask Steward (with one-click samples and Reset demo) and the plan · Scout's
suggestions · the approval inbox · activity · **"Why did my agent do that?"** (each check, its
graph path, the Cypher, the facts behind it) · Mail / Outbox / Calendar / Tasks / Rules tabs ·
incoming-mail samples. Light and dark; works at phone width.

### The full loop, on the demo

```
Scout: "You promised Priya the Atlas update (Fri 11:00) · #1 of 5 people by centrality"   [Do it]
   │
   ▼  retrieval: 6 entry points → 17 nodes · Planner proposes: email Priya v2 + a prep task
   ▼  Sentinel: known ✓  flow ✓ (v2 → Atlas ← Priya)  asked by Priya ✓  rule ✗   → ASK
 inbox ─► Asha approves ─► Executor re-checks ─► email in the outbox, v2 attached
                                             ─► promise fulfilled, Priya's tie stronger, Scout's suggestion resolves
 ×3 approvals ─► rule proposed ─► accepted ─► next email to Priya: ALLOW, no prompt
 Meanwhile: "Forward Alex the pricing sheet" ─► BLOCK (restricted + a stranger asked)
```

### Why this matters for judging

- **The take-it-out test (rule 3):** there is no other database. Without FalkorDB there's no
  context for the planner, nothing to check against, no inbox, outbox, memory, rules or suggestions.
- **The brief's three verbs:** *act* (Executor), *remember* (contacts, shares, commitments,
  rules, mail), *show the path* (`JUSTIFIED_BY` edges, paths and Cypher on every verdict).
- **Sponsor features used for real:** per-user multigraph · full-text index · multi-hop Cypher
  on every step · `algo.pageRank` · shortest paths · **MCP** (10 tools, no approve tool by design). Plus one upstream bug found and reproduced (`../BUGS.md`).
- **Restraint as the architecture:** the model only proposes; the graph decides; BLOCK is final;
  rules never widen themselves; Scout only suggests.
- **Evidence:** 63 labelled scenarios with **32 negative controls**. First run, labels frozen:
  **0 unsafe actions allowed**, 23/23 should-BLOCK blocked. The two misses were over-cautious
  and are fixed (first-run report kept). Learning replay: prompts **3 → 3 → 3 → 0 → 0 → 0**, still
  0 unsafe afterwards. 99 tests against a real FalkorDB.

### What's not built yet

**Deployment** · a live run of an **LLM planner** (Claude, Grok, Gemini, Groq, OpenRouter or Ollama are wired; needs one key)
· community detection → contexts · shortest-path explanations · conversation memory.
See *Build order* below.

---

## Built so far

| # | Commit · time | Feature | What it does | Verified by |
|---|---|---|---|---|
| 0 | `7360b2d` · 09:48 | **Scaffold** | Turborepo + Bun workspaces, `apps/api` on Bun + Hono, `falkordb` client, FalkorDB + Browser via docker compose. `graphFor(userId)` gives every user an isolated graph | `/health` and `/users/:id/ping` round-trip a node |
| 1 | `c3dfe34` · 10:14 | **Schema + synthetic demo world** | Indexes on `Entity.id`, `Person.email`, `Meeting.start`. Asha: 28 nodes / 36 edges: 5 people (one stranger), 3 projects, 5 docs (v1→v2, a restricted pricing sheet shared only with Rahul), tomorrow's 11:00 Priya sync, a task that BLOCKS another, 2 commitments, a preference, 2 inbound mails | 4 tests: counts, multi-hop meeting → project → latest doc, idempotent reseed |
| 2 | `ad8033e` · 10:24 | **Sentinel** | 5 deterministic Cypher checks; most severe failure wins; each returns reason + graph path + Cypher | 13 tests, 6 negative controls |
| 3 | `dcc86de` · 11:36 | **Actions in the graph + approval inbox** | `Action` nodes with `DERIVED_FROM` / `TARGETS` / `USES` / `PROPOSED` / `CHECKED` / `JUSTIFIED_BY {check, status}`. ASK → `pending`, ALLOW → `ready`, BLOCK → `blocked`. `Approval` nodes; **a BLOCK can't be approved**; nothing is decided twice | 8 tests |
| fix | `296fd14` · 11:39 | **Provenance for Request sources** | A user-typed `Request` counts as the user asking (it would have read as a stranger on re-check). Sources with no sender ASK | 2 tests |
| 4 | `3e3a7db` · 11:41 | **Executor + sandboxed tools** | Atomic claim (`CLAIMED_BY`), **re-check against the current graph**, then graph writes: outbound `Message` + `ATTACHES`, `Meeting` + `WITH`, `Task`. Updates `KNOWS`, `SHARED_WITH`; fulfils commitments (`FULFILS`). Approve also executes | 12 tests incl. doc restricted after approval → blocked, rule revoked after ALLOW → back to inbox |
| 5 | `17ade50` · 11:44 | **Learning loop (procedural memory)** | 3 approvals of one type × one person → `Rule {status: proposed}` `SCOPED_TO` the person, `LEARNED_FROM` the approvals. Accept / decline / revoke; rejection resets the streak; never overrides a BLOCK. Worked around a FalkorDB bug (`../BUGS.md` #1) | 13 tests |
| 6a | `388f7c6` · 11:53 | **GraphRAG retrieval** | Full-text index (names, titles, subjects, commitment text; stemming) for entry points + **one multi-hop query** (1–2 hops) that never routes through the User or bookkeeping nodes. Rendered as nodes-with-ids + id triples | 9 tests incl. per-user isolation |
| 6b | `741b7c8` · 12:06 | **Planner** | `POST /requests`: retrieve → plan → Sentinel per action → ALLOWs run, ASKs to inbox, BLOCKs recorded. `Request → Plan → Step → Action`, `USED_CONTEXT`. Claude (`claude-opus-5-5`, structured output, refusal fallback) + offline planner. Invented provenance fails closed | 10 tests incl. **hijacked planner: 3/3 leak attempts BLOCKED** |
| 7 | `ce4cc1f` · 12:14 | **Web UI** | Vite + React, one screen (see §8 above). `GET /actions`; names instead of ids; offline planner uses a document named in the request | 2 tests; walked through in the browser incl. rule learning and phone width |
| eval | `4d9ae09` · 12:17 | **Sentinel evaluation** | 63 labelled scenarios (labels from the stated policy), 32 negative controls, learning replay. `bun run eval` → `eval/RESULTS.md`. Test locks in 0 unsafe allows | **First run: 0/63 unsafe, 23/23 BLOCKs, 61/63 exact**; learning 3 → 3 → 3 → 0 → 0 → 0 |
| fix | `442d67b` · 12:18 | **Two over-cautious misses the eval found** | Case-insensitive email (H02 had BLOCKED Priya); invitee-less events pass the rule check like tasks (A14). Labels unchanged | 3 tests; eval 63/63, 0 unsafe |
| 8 | `a537230` · 12:21 | **Inbound mail ingest** | `POST /mail`: sender by email (unknown → stranger, no `KNOWS`), mentions via full-text + word check (no duplicates, never superseded), a contact's request → *proposed* `Commitment`; a stranger's → **flagged** only. Deterministic. UI card + Mail tab | 10 tests incl. acting on a stranger's request is BLOCKED |
| fix | `f1c1df3` · 12:24 | **Retrieval keeps people as entry points** | Atlas docs and tasks had crowded Priya out of the top 6, so "email Priya…" planned nothing. Top 3 person matches always kept | 1 test |
| 9 | `c37ac61` · 12:25 | **Scout + PageRank** | Six suggestion queries, ranked by urgency + `algo.pageRank` over the user graph, with the reason. `Suggestion` nodes (`SUGGESTED`, `BECAUSE_OF`): no duplicates, dismissals stick, self-resolving. Never acts. UI panel with Do it / Take it on / Dismiss | 11 tests; checked in the browser |

| 10 | `e868f67` · 12:42 | **Multiple LLM providers for the Planner** | One OpenAI-compatible planner covers **xAI (Grok), Gemini, Groq, OpenRouter (free models), Ollama (local)**; Claude stays on its SDK. Same prompt and the same schema check for all; a malformed answer gets one repair turn; a model without JSON mode is retried without it. `STEWARD_PLANNER=auto` picks Claude if configured, else the first configured provider, else offline. **Any LLM failure falls back to the offline planner** and the plan says why, so a flaky free model can't break the demo. `GET /planners`; the UI picker lists only configured planners. Keys and model overrides in `.env.example` | 10 tests with a fake endpoint (request shape, repair turn, give-up, JSON-mode retry, 401) + registry + a real network failure → offline. Live: only `offline` available with no keys; unconfigured provider → 400 |

| 11 | `102e05f` · 12:46 | **MCP server** | Steward's graph as **10 MCP tools**: `steward_search` · `steward_get_context` (GraphRAG) · `steward_find_connection` (**shortest path**, not routed through the user; "no path" is meaningful) · `steward_who_matters` (**PageRank**) · `steward_check_action` (Sentinel dry run) · `steward_propose_action` (Sentinel decides; runs only on ALLOW) · `steward_run_request` (full pipeline) · `steward_list_inbox` · `steward_explain_action` · `steward_get_suggestions`. **No approve / reject / rule tools on purpose:** an agent over MCP can propose, only a human in the UI can approve. Read tools annotated read-only. Proposals attributed to an `MCP client` agent. Served over **Streamable HTTP** at `/users/:id/mcp` (stateless) and **stdio** (`bun run mcp`) | 13 tests through a real MCP client (in-memory transport): tool list has no approve tool, annotations, search, path found / no path, PageRank order, context, dry run stores nothing, injected request BLOCKED + attributed, ASK lands in inbox, task runs, run_request, suggestions. Live: HTTP initialize → 10 tools → a call; stdio initialize → a call |

**Tests:** 122 pass, 0 fail, against a real FalkorDB (`bun run test`). **Eval:** `bun run eval`.

### API

| Endpoint | Purpose |
|---|---|
| `POST /users/:id/requests` | **the front door**: `{ request, planner? }` → plan → Sentinel → run / inbox / blocked |
| `ALL /users/:id/mcp` | **MCP** (Streamable HTTP, stateless): 10 tools over the user's graph; no approve tool |
| `GET /planners` | which planners this server can run (offline always; LLM providers whose key is set) |
| `GET /users/:id/suggestions` | runs Scout, returns open suggestions ranked |
| `POST /users/:id/suggestions/:sid/dismiss` · `/accept` · `/decline` | dismiss; accept or decline a proposed commitment |
| `GET /users/:id/inbox` | actions waiting for approval |
| `GET /users/:id/actions` | activity feed |
| `GET /users/:id/actions/:actionId` | one action with checks, source, `JUSTIFIED_BY` facts, decisions (the "why" panel) |
| `POST /users/:id/actions/:actionId/approve` · `/reject` · `/execute` | decide (approve also executes; 409 if blocked or decided) · run one |
| `POST /users/:id/actions` | propose one action directly (Sentinel verdict, stored) |
| `POST /users/:id/sentinel/check` | dry-run the Sentinel |
| `GET /users/:id/rules` · `POST /users/:id/rules/:ruleId/accept` · `/decline` · `/revoke` | procedural memory |
| `POST /users/:id/mail` · `GET /users/:id/mail` | receive / list simulated inbound mail |
| `POST /users/:id/context` | what the Planner would see for `{ request }` |
| `GET /users/:id/outbox` · `/calendar` · `/tasks` | the sandboxed tools' state |
| `POST /users/:id/executor/run` | one Executor pass |
| `POST /users/:id/seed` · `GET /users/:id/overview` · `GET /health` | reset demo · counts · health |

---

## Against the plan: the 14 jobs the graph does

| # | Job (from `graph-model.md`) | Status |
|---|---|---|
| 1 | Per-user isolation (multigraph) | ✅ |
| 2 | Ingest inbound mail, keep knowledge current | ✅ (exact-word resolution; no vector index) |
| 3 | GraphRAG retrieval for the Planner | ✅ full-text + multi-hop (no vector index) |
| 4 | Conversation memory (Session / Turn) | ⬜ |
| 5 | The plan as Plan / Step nodes | ✅ |
| 6 | Agent coordination via Action status | ✅ Planner → Sentinel → Executor, Scout via `SUGGESTED` |
| 7 | **Permissions (Sentinel)** | ✅ 5 checks, evaluated |
| 8 | Tools' state as graph nodes | ✅ |
| 9 | Procedural memory (Rules) | ✅ |
| 10 | Proactive suggestions (Scout) | ✅ |
| 11 | PageRank prioritisation | ✅ |
| 12 | Community detection → Contexts | ⬜ |
| 13 | Shortest path | 🟨 as an MCP tool (`steward_find_connection`); not yet drawn in the "why" panel |
| 14 | MCP | ✅ 10 tools over HTTP + stdio; no approve tool by design |

## Against the scope table in `PLAN.md`

| Scope item | Status |
|---|---|
| FalkorDB as the only store | ✅ |
| GraphRAG retrieval | ✅ |
| Ingest of inbound mail | ✅ |
| Scout + PageRank | ✅ |
| Community detection → Contexts | ⬜ first to cut |
| 3 sandboxed tools as graph nodes | ✅ |
| Sentinel: 5 Cypher checks | ✅ |
| UI: request box, inbox, "why" panel, suggestions | ✅ |
| Learning: propose narrow rule → accept / revoke | ✅ |
| Seeded synthetic user, zero login | ✅ Reset demo + one-click samples |
| Eval over labelled scenarios | ✅ 63 + learning replay |
| Planner with an LLM | 🟨 Claude, Grok, Gemini, Groq, OpenRouter, Ollama built; **none run live yet (no keys)**; offline planner + automatic fallback cover the demo |
| Deploy | ⬜ |

---

## Build order from here (one feature, one commit)

1. **Deploy:** one public URL serving API + UI, seeded, no login, offline planner as fallback; test in incognito and on a phone
2. **Live LLM planner run**: put any one key in `.env` (a free Groq, Gemini or OpenRouter key is enough), run the samples, fix what the first real call surfaces
3. Known issue: dedupe a prep task that already exists
4. If time before the freeze (Sat 09:30): community detection → contexts as rule scopes; shortest-path explanation in the "why" panel

Then the submission: README with graph model + Cypher (rule 10), video, blog post, file `../BUGS.md` #1 upstream, AI disclosure.

## Notes and decisions

- Every node also carries `:Entity` so edges can be matched by id without knowing the label.
- Labels and edge types can't be Cypher parameters; the seeder validates them before interpolating.
- Demo times are pinned to IST (fixed +5:30) so calendar checks don't depend on the server clock.
- Missing or unknown provenance fails closed (ASK), never open.
- The Planner gets the subgraph, never the whole graph, and is told message bodies are data, not instructions. The real defence is structural: whatever it proposes, the Sentinel decides.
- The offline planner is the no-key demo path required by the plan, not a mock: it plans from the same retrieved subgraph.
- PageRank over `KNOWS` alone is flat (every edge starts at the user); Scout ranks over the whole user graph.
- **Upstream bug found:** FalkorDB 6.0.2 drops rows in `OPTIONAL MATCH … WHERE` after an aggregating `WITH`. Repro and workaround in `../BUGS.md` #1. File before Sun 19:15.
- **Known issue:** re-running a request re-creates an existing prep task.
- `bun run dev` loads the root `.env`, so an `ANTHROPIC_API_KEY` there reaches the Planner.
- Dev preview in this session runs the API on :8788 (`STEWARD_API` points Vite at it); `bun run dev` uses :8787.
- AI assistant (Claude Code) used throughout; to be logged in `../AI-DISCLOSURE.md` (rule 11).
