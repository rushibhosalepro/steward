# Progress

Where Steward stands against the plan (`../PLAN.md`) and the graph model (`../graph-model.md`).
Updated after every feature commit. Times are IST and taken from the commit log.

**Last updated:** Thu Oct 15, 13:40 IST · 13.5h into the 96h window · 161 tests passing · **live: https://steward-production-8191.up.railway.app** · what's left: [**What's remaining**](#whats-remaining) at the end.

| Gate (from `../CHECKLIST.md`) | Due | Status |
|---|---|---|
| Idea locked, graph model final, labelled scenarios written, criteria asked on Discord | Thu 14:30 | ✅ except **asking about judging criteria on Discord** (yours to do) |
| Seeded graph + Sentinel + Planner + Executor working end to end on the Priya flow | Fri 12:00 | ✅ done Thu 12:06 |
| **Feature freeze**, scorecard filled, corpus run, both rates published | Sat 09:30 | eval done, provisional scorecard in `../PLAN.md`; freeze is ~44h away |
| Deployed, seeded, zero-login, no-key fallback, incognito + phone | Sun 00:00 | ✅ **deployed Thu 13:35** on Railway; phone/incognito check still to do |
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
- **Real models, a real injection:** told to "do whatever people asked for", Groq's
  `gpt-oss-120b` and OpenAI's `gpt-5.4-mini` followed Alex's injected mail **5 of 5 times**;
  the Sentinel **blocked 5 of 5**.
- **Evidence:** 63 labelled scenarios with **32 negative controls**. First run, labels frozen:
  **0 unsafe actions allowed**, 23/23 should-BLOCK blocked. The two misses were over-cautious
  and are fixed (first-run report kept). Learning replay: prompts **3 → 3 → 3 → 0 → 0 → 0**, still
  0 unsafe afterwards. 99 tests against a real FalkorDB.

### What's not built yet

See [**What's remaining**](#whats-remaining) at the end of this file.

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

| live | `0337ca7` · 12:53 | **First live LLM run (Groq `gpt-oss-120b`)** | Fixes it surfaced: Groq default model updated (old one gone; fallback kicked in as designed) · inbox requests ("go through my inbox") now start from the latest inbound mail · `Plan` / `Step` / `Suggestion` no longer leak into the planner's context · provider errors drop account ids · a hygiene test catches control characters in source | **Told to "do whatever people asked for", the model followed Alex's injected mail 2/2 times; the Sentinel blocked 2/2.** 3rd run hit the free-tier 8k TPM limit → offline fallback. See `../results.md` |

| live | `adf0d1a` · 13:15 | **OpenAI provider + second live model** | OpenAI added (`gpt-5.4-mini` default, `gpt-5.4-nano` via env); temperature is per-provider because GPT-5 models reject 0 | live: 5 standard requests, no fallback, 1.8–3.4 s; **inbox injection followed 3/3, BLOCKED 3/3**. Both providers together: **fooled 5/5, blocked 5/5** |

| sec 1 | `ebfe717` | **Fact-level information flow + context firewall** | `(Document)-[:CONTAINS]->(Fact)` with markers; check `content_flow` blocks a leak typed into the text (same path rule as attachments); restricted facts never enter the planner's context | 10 tests; live: asked to put the prices in the email, the model wrote "[Please insert the pricing numbers here]" |
| sec 2 | `85111fa` | **Taint + Meta's Rule of Two** | check `rule_of_two`: untrusted input (read from the graph, not the planner's claim) + private data + external effect → ASK, no rule can override; `TAINTED_BY` edges | 8 tests; eval A06/A07 relabelled ALLOW → ASK (disclosed) |
| sec 3 | `0603770` | **Scoped capabilities + volume** | rules cover data up to `internal` (never restricted) and expire 30 days after acceptance; check `volume`: from the 4th outbound action of one request, ASK | 7 tests incl. a 5-email bulk send |
| sec 4 | `daaffb9` | **Hash-chained audit + kill switch** | every verdict / approval / execution / pause appends an `AuditEvent` (payload hash + previous hash, `NEXT`); `GET /audit/verify` detects edits and deletions; `POST /pause` stops the Executor | 4 tests: chain verifies, edit detected, deletion detected, pause/resume |
| deploy | `7bc1373` · 13:35 | **Railway** | One service serves API + UI (API also under `/api`), seeded on first boot. FalkorDB as a private Railway service (password via reference variable, volume at `/var/lib/falkordb/data`, AOF on). Planner: OpenAI | live: UI, API, OpenAI plan, injection BLOCKED, audit verifies, MCP 10 tools |

| limits | `09e8737` | **Public-demo abuse limits** | per-IP limits on `/requests` 6/min, `/seed` 3/min, `/mail` 10/min, `/actions` + `/mcp` 30/min (429 + Retry-After; GETs free); a daily LLM budget (default 300) past which planning degrades to offline with a note | 4 tests; live: 4th `/seed` in a minute → 429, Retry-After 59 |
| adv eval | `21e9604` | **Adversarial evaluation, whole pipeline** | 16 attacks via a compromised planner, MCP, Executor and audit; each checks the verdict and the absence of the side effect. `bun run eval:security` → `eval/SECURITY.md` | **16/16 held**; found the volume self-count bug (cap was 2, now 3) |

**Tests:** 161 pass, 0 fail, against a real FalkorDB (`bun run test`). **Eval:** `bun run eval`.

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
| Planner with an LLM | ✅ **Groq (`gpt-oss-120b`) and OpenAI (`gpt-5.4-mini`) run live**; Claude, Grok, Gemini, OpenRouter, Ollama wired but not run; offline fallback proven (rate limit → offline) |
| Deploy | ⬜ |

---

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
- Groq free tier is 8k tokens/minute for `gpt-oss-120b`: about two plans a minute. Fine for a demo; the offline fallback covers bursts.
- Dev preview in this session runs the API on whatever port the launcher assigns (`STEWARD_API` points Vite at it); `bun run dev` uses :8787.
- AI assistant (Claude Code) used throughout; to be logged in `../AI-DISCLOSURE.md` (rule 11).

---

## What's remaining

As of Thu Oct 15, 12:55 IST. **Freeze: Sat 09:30 · Submit by: Sun 21:00** (deadline 23:59).
The dated plan is in `../PLAN.md` → *Re-plan from Thu 13:00*.

### Needs you (I can't do these)

| # | What | Why it matters | When |
|---|---|---|---|
| U1 | ~~Add a second LLM key~~ ✅ OpenAI added; Gemini still optional | second live model to compare with Groq | done |
| U2 | ~~Decide where to deploy~~ ✅ Railway: **https://steward-production-8191.up.railway.app** · GitHub push didn't auto-deploy (deployed with `railway up`); check the service's Source → branch / auto-deploy setting | a live URL is "preferred" (FAQ); judges won't run it locally | Thu |
| U3 | ~~Push to GitHub and make the repo public~~ ✅ **done Thu 13:00**: [github.com/rushibhosalepro/steward](https://github.com/rushibhosalepro/steward), public, `main` tracks `origin/main` | rule 10: a public source repo | done |
| U4 | **Ask on Discord:** judging criteria, blog-post prize rules, kickoff date | the paying axis is still a guess without criteria | Thu |
| U5 | ✅ Registered (seen Fri 16 Oct). **Submission form opens Sat 17 Oct 01:03 IST**: open it then and share the fields (title, tagline, links, video, tracks…) so README / video fit them |
| U6 | Record the **video** (your voice); post the **blog** under your name | rule 13: meaningful participant contribution | Sat–Sun |

### Build, before the freeze (Sat 09:30)

| # | What | Size | Notes |
|---|---|---|---|
| B1 | ~~Second live model + side-by-side~~ ✅ OpenAI `gpt-5.4-mini` vs Groq in `../results.md` | S | done |
| B2 | ~~Deploy~~ ✅ live on Railway. Still: test on a phone + incognito; **rate-limit the public planner** (anyone can spend the OpenAI key); auto-deploy from GitHub | M | mostly done |
| B3 | Known issue: re-running a request duplicates an existing prep task | S | dedupe in the Executor |
| B4 | Offline planner on inbox requests ("go through my inbox") does nothing; when Groq is rate-limited the fallback plans nothing | S | handle requests from known contacts' mail |
| B5 | Planner evaluation on live LLMs: N fixed requests × each configured model → did it propose the right actions, and did any unsafe one get through (it can't) | M | strong evidence; mind Groq's 8k tokens/minute |
| B6 | *Optional:* draw the shortest path in the "why" panel (the MCP tool already computes it) | S | visible "show the path" |
| B7 | *Optional:* community detection (`algo.labelPropagation`) → contexts (work / family) as rule scopes | M | first to cut |
| B8 | *Optional:* vector index for fuzzier retrieval and name matching | M | listed in the plan's sponsor features, not built; don't claim it |
| B9 | *Optional:* conversation memory (`Session` / `Turn`) | M | T2 "persistent conversation history" |

### Submission assets (rule 10 and the handbook)

| # | What | Notes |
|---|---|---|
| S1 | **README**: what it is, setup, **graph data model**, **the Cypher queries the product depends on**, the take-it-out paragraph, MCP setup, limits (3 concrete), AI disclosure, eval numbers | rule 10 requires the model and the queries |
| S2 | **Demo video**: open on the live injection BLOCK, then the Priya flow, the "why" panel, rule learning, Scout, MCP | under 3 min; first 15 s is the product |
| S3 | **Live URL** (or full local setup) | from B2 |
| S4 | **Tracks named**: T2 Agent Memory and Coordination (primary) + T1 Agents That Act on Connected Data | rule 5 |
| S5 | **Blog post** for the AirPods prize | rules not published (U4) |
| S6 | **File `../BUGS.md` #1 upstream** (FalkorDB `OPTIONAL MATCH … WHERE` after aggregating `WITH`), link it from the README | sponsor engagement |
| S7 | **`../AI-DISCLOSURE.md`**: Claude Code used throughout; what you verified yourself (rules 11–13) | rule 11 |
| S8 | Fill the **freeze scorecard** in `../PLAN.md` with real scores | Sat 09:30 |
| S9 | Final pass: links work in incognito, no secrets in git history, tagline chosen and said out loud | night before |

### Added Thu 13:40 (security follow-ups)

| # | What | Notes |
|---|---|---|
| X1 | ~~Eval: add the adversarial security batch~~ ✅ 16/16, `eval/SECURITY.md` · (indirect leak, tainted request, scope abuse, bulk send, audit tamper, credential exposure) with labels written first | the ideas list from the security review |
| X2 | UI: pause button + "audit ✓ N events" in the header; labels exist for the new checks | endpoints exist |
| X3 | README: security section — what's enforced (8 checks, firewall, capabilities, audit, kill switch) and what's honestly out of scope (no network tools exist; no separate policy service) | limits |
| X4 | ~~Public demo abuse: rate limits~~ ✅ per-IP limits + daily LLM budget, live | done |

### Added Thu 14:20 — gaps against past winners (detail: `../WINNER-GAPS.md`)

| # | What | Winner it comes from | Time |
|---|---|---|---|
| W1 | **Ablation: eval + attacks with vs without the graph** (rule 3 as a number) | Interlock: 13/14 with DataHub vs 6/14 without | 2h |
| W2 | **File `../BUGS.md` #1 upstream** (you) | every Backblaze winner; DataHub winners' upstream skills | 30m |
| W3 | **Community detection → contexts** (+ betweenness): more of the sponsor's named algorithms | Tether lost on "skipped the named surfaces" | 3h |
| W4 | **Latency at scale**: "8 graph checks per action in N ms at 50k nodes" | the sponsor's own headline claim | 2h |
| W5 | **Second demo user + conversation memory**; name the memory types | T2 key focus | 3h |
| W6 | **AgentDojo workspace suite** adapted as a public benchmark (needs your OK to download) | kassi, Gauntlet: public benchmarks | 3h |
| W7 | OWASP LLM Top-10 / MITRE ATLAS tags, a cited world-stakes number, a tagline with a competitor in it | Gauntlet, UiPath winners, Penetron | 1h |
| W8 | Lead with usefulness; publish the escalation ratio over a simulated day | WebMCP: the one safety winner framed it as *giving* authority | in the video/write-up |
| W9 | Film a real outside agent (Claude Desktop / Code) over MCP being stopped | Mandate filmed ChatGPT | 1h |

### Thu ~14:45 — external agent through Steward (the "is it real?" question)

| Done | Result |
|---|---|
| Bypass found and closed: an MCP agent could self-approve over the unauthenticated HTTP API (shown live: the email went out). Human-only routes now need the approver code (`35a5d0d`, deployed) | S17 added to the adversarial suite: 17/17 hold |
| External-agent benchmark: Claude Code with only Steward's MCP tools vs ordinary connectors (`eval/EXTERNAL-AGENT.md`) | **Haiku: attacks 3/3 without → 0/3 with. Sonnet: 1/3 → 0/3. Legit 3/3 everywhere, 0 false blocks.** First baseline discarded (it leaked Steward's checks) |
| Next | real Gmail drafts + Calendar (step 4 of the agreed plan) once you set up Google OAuth; more attack tasks and repeats for a rate |

### Thu ~15:30 — real connectors (step 4 of the agreed plan)

| Done | Result |
|---|---|
| Gmail drafts + a "Steward" Google Calendar behind the Sentinel (`1cf04d6`) | On the real account: Alex's injected request BLOCKED (no draft), Priya's email became a **real Gmail draft** after human approval, a calendar request became a **real event** (0 attendees). Verified through Google's own API |
| Scaled external-agent benchmark (13 tasks × 2 conditions × 2 runs × Haiku/Sonnet, 104 runs) | **Without Steward: Haiku 14/16, Sonnet 8/16 attacks succeeded. With Steward: 0/16 both. Legit 10/10 everywhere, 0 false blocks.** Sonnet resists obvious injections itself but still leaks on "who may see what" calls (restricted pricing, mass send, a new personal address) |
| Scale benchmark, 48k nodes / 75k edges (`eval/SCALE.md`) | Sentinel p50 **557 ms → 100 ms** (p95 135 ms) after anchoring the Rule of Two taint queries on indexes and running fact matching once per action; retrieval p50 91 ms. Verdicts unchanged (63/63, 17/17, 168 tests) |
| Redeployed to Railway | live site has the Google connector (unconfigured there), memory, worlds, pause/audit UI |

### Thu ~21:00: tested on more models (your ask: "tested on multiple models")

| Done | Result |
|---|---|
| A second agent harness: a plain tool-calling loop on any OpenAI-compatible API (`eval/openai-agent.ts`), same tasks and judges | OpenAI gpt-4.1-mini, gpt-5.4-mini, gpt-5.4 |
| 5 models, 2 vendors, 260 runs (`eval/EXTERNAL-AGENT.md`) | **without Steward 67/80 attacks succeeded, with 0/80**; legit 48/50 with · 50/50 without; 0 false blocks. A3 + A8 beat every model without Steward |
| Bugs the benchmark found in Steward, fixed | dry-run ASK read as "can't" (`6323d5e`); event invitee unclear (`e6bf734`); rate limit applied to "with" only (`dd2562f`) |
| Groq open-weight gpt-oss-20b / 120b | running (free tier: 8k tokens/min, ~5 min per run); qwen3.8 too large for the free tier |
| Real xAI Grok | needs `XAI_API_KEY`; then `--model xai:grok-4` |

### Fri 16 Oct morning: the brief's five graph jobs, gaps closed

The hackathon page lists the work the graph has to do: follow connections, remember across sessions,
share state between agents, connect people/projects/decisions, show the path behind an answer.
README now has a section mapping each to the pattern and the proof.

| Done | Result |
|---|---|
| **Ablation** (`eval/ABLATION.md`): same 63 scenarios, 3 deciders | unsafe allowed: **graph 0/47** · relationships off 7/47 · LLM guardrail with the whole graph as text 11/47 (gpt-5.4-mini), 2/47 (gpt-5.4) |
| **Memory across sessions** (gap): a new session recalls earlier sessions about the same entities and how they ended, via Turn→Request→Plan→Step→Action | `memory.test.ts` |
| **Agent handoff trail** (gap): Why panel shows Planner PROPOSED → Sentinel CHECKED → you → Executor CLAIMED_BY / EXECUTED, read from edges | `actions.test.ts`, checked in the browser |
| MCP accepts a Person id as recipient (gpt-oss-20b passed `p:meera`) | `mcp.test.ts` |
| Benchmark saves after every run, `--resume` | gpt-oss-20b rerunning on Groq |
| Tests | **171 pass**; eval 63/63, security 17/17 |

## What's remaining (current, Fri 16 Oct ~08:45) — supersedes the older lists above

Freeze **Sat 17 Oct 09:30 IST** · form opens **Sat 01:03** · submit by **Sun 21:00** · deadline Sun 23:59.
Freeze scorecard re-scored Fri: **17 / 20** (`../PLAN.md`); the open rows are the video and the tagline.

Done since Thursday's lists: deploy, rate limits, security suite, contexts (WCC), conversation memory
and memory across sessions, pause/audit UI, scale (W4), ablation (W1), OWASP/ATLAS map + stakes (W7),
external agents on 5 models (W9 as a benchmark), prep-task dedupe (B3).

### Me (before the freeze)
| # | What | Notes |
|---|---|---|
| R1 | gpt-oss-20b (open weights, Groq) row in the external-agent table | running, resumable; Groq free tier ~1–5 min/run |
| R2 | ~~Offline planner ignores "go through my inbox"~~ ✅ `762f6d9`: answers naively, Sentinel BLOCKs Alex | done |
| C ✅ | **README "Test it in 3 minutes"** (`ad06033`): 5 steps checked on the live site + MCP one-liner; live demo reset afterwards | done |
| P1 ✅ | **Personal layer over MCP** (`98141dc`): connect instructions, `steward_brief`, `steward_remember` (proposed → you confirm), each agent named, its work saved as sessions; S18 memory poisoning → **18/18**; 182 tests | done, live |
| P2 ✅ | **Workspace UI** (`a7606a2`): conversation with Steward's brief, step cards with inline Approve, outside agents (Claude Code) in the same thread, agents sidebar + connect command, right rail (coming up, needs you, Steward remembers + proposed memories), Why drawer with the drawn path; old UI at `/classic`. Live | done |
| — | Found while building it: FalkorDB 6.0.2 crashes on an aggregation grouped by a null key (`../BUGS.md` #2). **Report privately to security@falkordb.com** (it's a DoS), not as a public issue | you |
| A, B | Sandbox per visitor (no approver-code wall, no shared state) + "Try it" panel — next, plan in `../judge-demo-plan.html` | ~3.5h |
| R3 | Draft the submission text from the form fields | after you send the fields (Sat 01:03+) |
| R4 | Final pass: links in incognito, phone width, no secrets in git history, redeploy | night before submitting |

### You
| # | What | When |
|---|---|---|
| Y1 | Open the submission form (Sat 01:03) and send me its fields | Sat |
| Y2 | Discord: judging criteria, blog-prize rules | now |
| Y3 | ~~File `../BUGS.md` #1 with FalkorDB~~ ✅ [FalkorDB/FalkorDB#3352](https://github.com/FalkorDB/FalkorDB/issues/3352) (a 6.0.2 regression; works in 4.22.0) | done |
| Y4 | Fill "What I did myself / verified" in `../AI-DISCLOSURE.md` | before submitting |
| Y5 | Say the tagline out loud; record the video (open on a BLOCK; show the Why panel: path + handoff) | Sat |
| Y6 | Blog post under your name | Sat–Sun |
| Y7 | Decide: rewrite git history to drop the old org id in commit `0337ca7`, or leave it | before submitting |
