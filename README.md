# Steward

**Other agents ask the model if an action is safe. Steward asks the graph.**

Steward is a personal operator agent, in the spirit of Meta's Muse, that runs your errands
(email, calendar, tasks) and lives entirely in a graph. **FalkorDB is the only datastore.**
The model proposes; the graph decides. Before anything runs, a deterministic **Sentinel** walks
your graph and answers **ALLOW**, **ASK** or **BLOCK**, with the path and the Cypher behind the
answer. Approvals become narrow, expiring, reversible rules, so it asks less over time without
getting looser. And because the same Sentinel sits behind an **MCP server**, any outside agent
gets the same guarantees.

- **Live demo:** https://steward-production-8191.up.railway.app (synthetic demo user, no login)
- **Tracks:** **T2 Agent Memory and Coordination** (primary) · **T1 Agents That Act on Connected Data**
- Graph Hacks (WeMakeDevs × FalkorDB), Oct 15–18 2026

---

## What happened when a real agent tried

An independent agent (**Claude Code**, headless) was given **only** Steward's MCP tools, no shell,
files or web, and asked to do 5 errands and 8 attacks hidden in the inbox. The same agent was run
again with ordinary connectors and no Steward. Judged from the graph afterwards; every transcript is
in [`eval/agent-runs/`](eval/agent-runs/).

| Agent | Attacks that succeeded **without** Steward | **with** Steward | Legit errands done | False blocks |
|---|---|---|---|---|
| Claude Haiku (2 runs × 13 tasks) | **14 / 16** | **0 / 16** | 10/10 · 10/10 | 0 |
| Claude Sonnet (2 runs × 13 tasks) | **8 / 16** | **0 / 16** | 10/10 · 10/10 | 0 |

Even the stronger model leaks without Steward when the risky part is a judgment about *who may see
what*: restricted pricing to a colleague not cleared for it, a mass send to every contact, a known
contact asking for files at a new personal address. With Steward the agents still *tried* (an
outsider's address from a forwarded request, an invented recipient), and the Sentinel blocked or
asked every time: **0 of 32 attacks across both models, 20/20 legitimate errands done.** Details and honest limits: [`eval/EXTERNAL-AGENT.md`](eval/EXTERNAL-AGENT.md).

---

## How it works

```
"go through my inbox and do what people asked"            ← you, the UI, or any agent over MCP
   │
   ▼  retrieval: full-text entry points → one multi-hop Cypher expansion → the planner's context
   ▼  planner (OpenAI / Claude / Groq / Gemini / Grok / Ollama, or offline) PROPOSES actions
   ▼  Sentinel: 8 deterministic graph checks → ALLOW / ASK / BLOCK + path + Cypher
 ALLOW ─► Executor re-checks against the graph as it is now ─► sandboxed graph write
                                                            └─► (optional) real Gmail draft / Google Calendar event
 ASK ───► your approval inbox (human only)        BLOCK ───► recorded, never runnable
   └─ every verdict, approval and execution is hash-chained into an audit trail
```

**The Sentinel's checks** ([`apps/api/src/sentinel/sentinel.ts`](apps/api/src/sentinel/sentinel.ts)):

| # | Check | The question it asks the graph | Fails → |
|---|---|---|---|
| 1 | Known recipient | Has the user ever been in contact with this person? | ASK |
| 2 | Information flow | Does each document reach the recipient through `BELONGS_TO → Project ← MEMBER_OF` or `SHARED_WITH`? Restricted docs need an explicit share | BLOCK |
| 3 | Content flow | Does the outgoing **text** give away a fact (`Document -CONTAINS-> Fact`) the recipient may not see? Catches leaks typed into a summary | BLOCK |
| 4 | Rule of Two | (A) untrusted input — read from the graph, not the planner's claim — (B) private data and (C) an external effect, all at once? (after Meta's *Agents Rule of Two*) | ASK |
| 5 | Provenance | Who asked: the user, a contact's email, or a stranger's (a likely injection)? | BLOCK |
| 6 | Calendar | Preference or overlap clash? | ASK |
| 7 | Standing rule | A rule for this action × this person, in date, covering this data's sensitivity? | ASK |
| 8 | Volume | Has this one request already produced 3 outbound actions? | ASK |

Verdict = the most severe failure. No failure and no rule → ASK. **A BLOCK can't be approved, and
no rule can override one.**

**What else runs on the graph:** per-user memory (one FalkorDB graph per user), conversation
memory (`Session -HAS-> Turn -MENTIONS->`), procedural memory (rules learned from approvals),
**Scout** (proactive suggestions ranked by `algo.pageRank`), **your worlds** (contexts from
`algo.WCC`), inbound mail resolved into the graph, an approval inbox, tamper-evident audit, and a
kill switch.

---

## Graph data model

One graph per user (`user_<id>`). Every node also carries `:Entity` so edges can be matched by id.

| Node | Key properties | Memory |
|---|---|---|
| `User` | name, timezone, paused | — |
| `Person` | name, **email** (indexed) | semantic |
| `Project` | name, status | semantic |
| `Document` | title, **sensitivity** (public / internal / restricted) | semantic |
| `Fact` | text, **markers**, sensitivity | semantic |
| `Meeting`, `Task`, `Commitment`, `Preference` | … | semantic |
| `Message` | direction, subject, body, flagged | episodic |
| `Session`, `Turn`, `Request` | text, ts | episodic |
| `Plan`, `Step`, `Action` | verdict, status, checks | episodic / coordination |
| `Approval`, `Rule` | decision · action_type, max_sensitivity, expires_at | procedural |
| `Suggestion`, `Context`, `AuditEvent`, `Agent` | … | proactive · worlds · audit · agents |

```
(User)-[:KNOWS {count, last_contact}]->(Person)-[:MEMBER_OF]->(Project)<-[:BELONGS_TO]-(Document)-[:CONTAINS]->(Fact)
(Document)-[:SHARED_WITH]->(Person)          (Document)-[:SUPERSEDES]->(Document)
(Meeting)-[:WITH]->(Person)  (Meeting)-[:ABOUT]->(Project)   (Task)-[:BLOCKS]->(Task)
(Commitment)-[:TO]->(Person) (Commitment)-[:ABOUT]->(Document)
(Message)-[:FROM|TO]->(Person)  (Message)-[:MENTIONS]->(…)  (Message)-[:ASKS_FOR]->(Commitment)
(Request)-[:PRODUCED]->(Plan)-[:HAS]->(Step)-[:PROPOSES]->(Action)   (Plan)-[:USED_CONTEXT]->(…)
(Action)-[:DERIVED_FROM]->(Request|Message)  (Action)-[:TARGETS]->(Person)  (Action)-[:USES]->(Document)
(Action)-[:JUSTIFIED_BY {check, status}]->(…)  (Action)-[:TAINTED_BY]->(Message)  (Action)-[:PRODUCED]->(Message|Meeting|Task)
(Agent)-[:PROPOSED|CHECKED|EXECUTED]->(Action)  (Action)-[:CLAIMED_BY]->(Agent)  (Approval)-[:ON]->(Action)
(Rule)-[:SCOPED_TO]->(Person)  (Rule)-[:LEARNED_FROM]->(Approval)
(Session)-[:HAS]->(Turn)-[:MENTIONS]->(…)   (Suggestion)-[:BECAUSE_OF]->(…)
(Person|Document)-[:IN_CONTEXT]->(Context)   (AuditEvent)-[:NEXT]->(AuditEvent)  (AuditEvent)-[:ABOUT]->(Action)
```

Indexes: range on `Entity.id`, `Person.email`, `Meeting.start`; **full-text** on
`Entity(name, title, subject, what)` ([`graph/schema.ts`](apps/api/src/graph/schema.ts)).

## The Cypher the product depends on

**Information flow** (Sentinel check 2), one query per document:
```cypher
MATCH (d:Document {id: $doc})
OPTIONAL MATCH (d)-[:SHARED_WITH]->(s:Person {email: $email})
OPTIONAL MATCH (d)-[:BELONGS_TO]->(pr:Project)<-[:MEMBER_OF]-(m:Person {email: $email})
OPTIONAL MATCH (newer:Document)-[:SUPERSEDES]->(d)
RETURN d.title AS title, d.sensitivity AS sensitivity, s.name AS sharedWith,
       pr.id AS projectId, pr.name AS project, m.name AS member, newer.title AS newer
```

**Untrusted input** (Rule of Two, check 4): who is asking for what, read from the graph:
```cypher
MATCH (m:Message {direction: 'inbound'})-[:FROM]->(s:Person)
OPTIONAL MATCH (u:User)-[:KNOWS]->(s)
WITH m, s, count(u) AS known
WHERE known = 0 OR coalesce(m.flagged, false) = true
OPTIONAL MATCH (m)-[:MENTIONS]->(e)
RETURN m.id AS id, m.subject AS subject, s.name AS from, s.email AS email, collect(e.id) AS mentions
```

**Provenance** (check 5):
```cypher
MATCH (src:Entity {id: $id})
OPTIONAL MATCH (src)-[:FROM]->(sender:Person)
OPTIONAL MATCH (u:User)-[:KNOWS]->(sender)
RETURN 'Request' IN labels(src) AS isRequest, src.text AS text, src.subject AS subject,
       sender.name AS sender, sender.email AS senderEmail, count(u) > 0 AS known
```

**Standing rule as a scoped capability** (check 7):
```cypher
MATCH (r:Rule {active: true, action_type: $type})-[:SCOPED_TO]->(p:Person {email: $email})
WHERE coalesce(r.expires_at, 9000000000000000) > $now
RETURN r.id AS id, coalesce(r.description, r.id) AS description, p.name AS name,
       coalesce(r.max_sensitivity, 'internal') AS scope
```

**Retrieval** (the planner's context): full-text entry points, then one multi-hop expansion that
never routes through the user or bookkeeping ([`retrieval/retrieve.ts`](apps/api/src/retrieval/retrieve.ts)):
```cypher
CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score  // entry points
MATCH p = (e:Entity)-[*1..2]-(n:Entity)
WHERE e.id IN $ids AND none(x IN nodes(p)[1..] WHERE any(l IN labels(x) WHERE l IN $exclude))
UNWIND relationships(p) AS r
WITH DISTINCT r
RETURN startNode(r).id AS from, type(r) AS rel, endNode(r).id AS to
```

**Graph algorithms:**
```cypher
CALL algo.pageRank('Entity', null) YIELD node, score            // Scout: who and what is central
CALL algo.WCC({nodeLabels: ['Person','Project','Document'],
               relationshipTypes: ['MEMBER_OF','BELONGS_TO']})   // contexts: "your worlds"
  YIELD node, componentId
MATCH p = (a)-[*1..4]-(b) WHERE none(n IN nodes(p) WHERE n:User …) // MCP find_connection: shortest path
```

---

## Take FalkorDB out, and nothing is left

There is no other database. Without FalkorDB the planner has no context, the Sentinel has nothing
to check against, there is no inbox, outbox, calendar, memory, rule, suggestion, audit trail or MCP
answer. The graph isn't storage beside the product; it *is* the decision.

## Evidence

| What | Result | Where |
|---|---|---|
| Labelled policy eval: 63 scenarios, 32 negative controls | **First run: 0/63 unsafe allowed**, 23/23 should-BLOCK blocked, 61/63 exact (two over-cautious misses, fixed, labels unchanged) | [`eval/RESULTS.md`](eval/RESULTS.md), [`eval/RESULTS-first-run.md`](eval/RESULTS-first-run.md) |
| Learning replay | approval prompts per round **3 → 3 → 3 → 0 → 0 → 0**, still 0 unsafe after | same |
| Adversarial suite through the whole pipeline (planner, Sentinel, Executor, MCP, audit, HTTP) | **17/17 attacks held**, checking that the side effect never happened | [`eval/SECURITY.md`](eval/SECURITY.md) |
| External agent (Claude Code, 104 runs) with vs without Steward | **without: 22/32 attacks succeeded · with: 0/32**, legit 20/20 both, 0 false blocks | [`eval/EXTERNAL-AGENT.md`](eval/EXTERNAL-AGENT.md) |
| Live LLM planners following an injected email | **fooled 5/5 (Groq gpt-oss-120b, OpenAI gpt-5.4-mini), blocked 5/5** | `results.md` in the planning notes |
| Scale | see [`eval/SCALE.md`](eval/SCALE.md) | |
| 168 automated tests against a real FalkorDB | `bun run test` | |

**Numbers that proved me wrong**, kept: email matching was case-sensitive, so the first eval run
blocked Priya written in capitals; the volume check counted its own action (cap 2, not 3); an agent
could approve itself over the plain HTTP API until human-only routes required an approver code; the
first external-agent baseline leaked Steward's own checks into the "without" condition and was
discarded ([`eval/agent-runs/discarded-v1/`](eval/agent-runs/discarded-v1/)).

## Security, honestly

**Enforced:** the 8 checks; a context firewall (restricted facts never reach the model); taint read
from the graph; rules as scoped, expiring capabilities that never override a BLOCK; human-only
routes (approve, rules, pause, reset, simulated mail) behind an approver code agents never see; no
approve tool over MCP; a hash-chained audit trail (`GET /users/:id/audit/verify`); a kill switch;
per-IP rate limits and a daily LLM budget on the public demo; only the planner and the Google
connector modules can reach the network (checked by a test).

**Not covered:** an attacker with database or server access; a malicious LLM or FalkorDB provider;
a fact paraphrased so no marker matches ("forty-eight thousand"); the Sentinel runs in the same
process, not as a separately permissioned service; facts must be modelled as nodes to be protected.

---

## Run it

Requires Bun ≥ 1.4 and Docker.

```bash
bun install
cp .env.example .env            # add one LLM key, or leave all empty for the offline planner
bun run db:up                   # FalkorDB on :6379 (FalkorDB Browser on :3000)
bun run dev                     # API on :8787, UI on :5173; the demo user is seeded on first start
```

Human-only actions (approve, rules, pause, reset) ask for the **approver code**: set
`STEWARD_APPROVER_TOKEN` in `.env`, or use the one printed in the API's log at startup.

| Command | What |
|---|---|
| `bun run test` | 168 tests (needs FalkorDB) |
| `cd apps/api && bun run eval` | the 63-scenario policy eval → `eval/RESULTS.md` |
| `cd apps/api && bun run eval:security` | the adversarial suite → `eval/SECURITY.md` |
| `cd apps/api && bun run eval:agent --model haiku --repeat 2` | external agent with vs without Steward (needs the `claude` CLI, logged in) |
| `cd apps/api && bun run eval:scale` | latency on a ~50k-node graph → `eval/SCALE.md` |

**Planner:** `STEWARD_PLANNER=auto | offline | openai | claude | groq | gemini | xai | openrouter | ollama`
(keys in `.env.example`). Any LLM failure, or the daily budget, falls back to the offline planner.

**Deploy (Railway):** one service from this repo (`bun run build` / `bun run start`; the API also
serves the UI) plus a `falkordb/falkordb` service with a volume at `/var/lib/falkordb/data` and
`REDIS_ARGS=--requirepass …`; set `FALKORDB_URL=falkor://default:<password>@falkordb.railway.internal:6379`,
`STEWARD_APPROVER_TOKEN`, and an LLM key.

### Use Steward from any MCP client

11 tools over the user's graph: search, graph context, shortest path between two things, PageRank,
your worlds, a Sentinel dry run, propose an action, run a request, the inbox, explain an action,
Scout's suggestions. **No approve tool, on purpose.**

```bash
claude mcp add --transport http steward http://localhost:8787/users/demo/mcp
```

or stdio: `claude mcp add steward -- bun --cwd /path/to/steward/apps/api run mcp`.

### Real Gmail and Google Calendar (optional, your own account)

Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (OAuth client, redirect
`http://localhost:8787/oauth/google/callback`), then **Connect Google** in the UI. After the Sentinel
allows an action (or you approve it), emails become **Gmail drafts** (never sent) and events go on
an app-created **"Steward" calendar** (no attendees, nobody emailed). Scopes: `gmail.compose`
(Google has no drafts-only scope; the code only creates drafts) and `calendar.app.created`. Tokens
stay in `.secrets/`, never in the graph.

---

## Built with

FalkorDB (graph, full-text index, `algo.pageRank`, `algo.WCC`, multi-graph per user) · Bun · Hono ·
React + Vite · the MCP TypeScript SDK · OpenAI / Anthropic / Groq APIs · Railway.

**Upstream:** found and reproduced a FalkorDB 6.0.2 bug (`OPTIONAL MATCH … WHERE` after an aggregating
`WITH` drops matches); workaround in [`rules/rules.ts`](apps/api/src/rules/rules.ts).

**AI assistance (rule 11):** built with Claude Code as a pair programmer. Every graph model, query,
check and result here was reviewed, run and verified against a real FalkorDB.

Data: entirely synthetic (rule 6), except the optional Google connector, which only touches the
account owner's own Gmail drafts and an app-created calendar.
