# Steward: progress

**Graph Hacks (WeMakeDevs × FalkorDB), Oct 15–18 2026** · status as of **Fri 16 Oct, 14:05 IST** ·
93 commits · live at **https://steward-production-8191.up.railway.app** ·
repo **https://github.com/rushibhosalepro/steward** · video **https://youtu.be/bLvvK3SbfiU**

> **Other agents ask the model if an action is safe. Steward asks the graph.**

Feature freeze **Sat 17 Oct 09:30** · submission form opens **Sat 01:03** · submit by **Sun 21:00**
(deadline Sun 23:59). (This file replaces the earlier, longer PROGRESS; that version is in git history.)

---

## In plain words: what we built

**Steward is a personal agent that lives in a graph.** Everything it knows about you lives in one
FalkorDB graph: your people, projects, documents, inbox, calendar, tasks, promises, preferences,
what you've taught it, and every decision it made. FalkorDB is the **only** datastore.

**The model proposes; the graph decides.** When an agent wants to do something (send an email,
share a document, book a meeting), Steward's **Sentinel** walks your graph and answers **ALLOW**,
**ASK** (wait for you) or **BLOCK**. There's no model in that decision; it follows real paths:
*is this document on a project this person is in? did a stranger ask for it? does the email text give
away a restricted fact?* Every verdict shows the path and the Cypher behind it.

**It learns without getting looser.** Approve the same kind of thing three times and Steward offers a
narrow rule (one person, one action type, internal data at most, 30 days). A rule can turn an ASK
into an ALLOW, never a BLOCK.

**Any agent can become your personal agent.** Over MCP, Claude Code (or any agent) gets your graph as
its memory and the Sentinel as its limits. `/mcp__steward__start` switches a session into "your
personal agent": it starts from your brief, acts only through Steward, and its actions show up in
Steward under its own name. It can't approve anything; only you can.

**Anyone can try it as themselves.** Each visitor gets a private sandbox: try Asha's demo world, or
**Meet your agent**: a short conversation (your name, your agent's name, your people, projects, a
meeting and a promise, which tools you'd connect and what each would allow) becomes your graph, and
the agent starts on something useful straight away.

---

## How we got here

| When (IST) | Phase | Key commits |
|---|---|---|
| Thu 09:48–12:30 | **Core, one feature at a time**: graph schema + seeded world → Sentinel → actions + approval inbox → Executor → learned rules → GraphRAG retrieval → Planner → web UI → 63-scenario eval → mail ingest → Scout (PageRank) | `c3dfe34` … `c37ac61` |
| Thu 12:40–13:05 | **Multiple LLMs + MCP**: Groq, OpenAI (gpt-5.4-mini default), offline fallback; MCP server; first live LLM runs: the models *followed* the injected email and the Sentinel blocked it, 5/5 | `e868f67`, `102e05f`, `adf0d1a` |
| Thu 13:10–14:00 | **Security**: fact-level information flow + context firewall, taint + Meta's Rule of Two, rules as scoped capabilities + volume cap, hash-chained audit + kill switch; Railway deploy; rate limits; adversarial suite; **closed a real bypass** (an agent could approve itself over plain HTTP) | `ebfe717` … `35a5d0d` |
| Thu 14:00–20:45 | **"Is it real?"**: external-agent benchmark (Claude Code, then OpenAI models) with a fair no-Steward baseline; real Gmail drafts + Google Calendar; conversation memory; worlds (WCC); scale test; README | `cfcae72` … `9a13f3c` |
| Fri 08:20–10:55 | **Proof and polish**: ablation (graph vs no relationships vs LLM guardrail), memory across sessions, agent handoff trail, the brief's five graph jobs mapped, OWASP/ATLAS threat map, FalkorDB issue filed, 3-minute judge path | `698d980` … `ad06033` |
| Fri 14:05–14:35 | **Onboarding**: "Meet your agent" as a conversation, honest tool-consent screen, first useful task on its own | see git log |
| Fri 12:35–14:05 | **Personal agent for any agent**: brief / remember / named agents over MCP; workspace UI; private sandbox per visitor + *Make it yours*; `/mcp__steward__start` | `98141dc` … `e99c498` |

---

## What's built

| Part | What it does | Where |
|---|---|---|
| **Graph** | One FalkorDB graph per user (`user_<id>`): User, Person, Project, Document, Fact, Message, Meeting, Task, Commitment, Preference, Request, Plan, Step, Action, Approval, Rule, Suggestion, Session, Turn, Memory, Agent, Context, AuditEvent. Full-text index on names/titles | `graph/schema.ts`, `seed/` |
| **Sentinel** | 8 checks: known recipient, information flow (paths), content flow (facts in the text), Rule of Two (taint from the graph), provenance, calendar, standing rule (scoped capability), volume. Deterministic, no LLM | `sentinel/sentinel.ts` |
| **Planner** | One sentence in → actions out, from a retrieved subgraph. Claude, OpenAI, Groq, xAI, Gemini, OpenRouter, Ollama, or an offline planner; daily LLM budget | `planner/` |
| **Context firewall** | Restricted facts never reach any model's prompt or MCP read | `retrieval/retrieve.ts` |
| **Executor** | Re-checks before running; outbox, calendar, tasks as graph writes; real Gmail drafts + a "Steward" Google Calendar (owner, local) | `executor/`, `connectors/google.ts` |
| **Learning** | 3 approvals → a proposed rule (one person, one action type, ≤ internal data, 30 days); revocable | `rules/rules.ts` |
| **Memory** | Session/Turn per conversation ("send that to Rahul"); recall across sessions, including how earlier requests ended; memories agents propose, used only once confirmed | `retrieval/`, `personal/` |
| **Scout** | What needs you: promises due, prep missing, strangers asking, blocked tasks; ranked by urgency × PageRank | `scout/scout.ts` |
| **Worlds** | Work / side project / family found by connected components (`algo.WCC`) | `contexts/contexts.ts` |
| **MCP** | 13 tools + the `start` prompt. Connect instructions make the client the user's agent; `steward_brief`, `steward_remember`; every client is its own named Agent; **no approve or confirm tool** | `mcp/server.ts`, `personal/personal.ts` |
| **Agent handoff** | Agents never call each other; each leaves an edge on the action: PROPOSED → CHECKED → Approval → CLAIMED_BY → EXECUTED | `actions/actions.ts` |
| **Audit + kill switch** | Hash-chained AuditEvents (`/audit/verify`); Pause stops everything | `audit/audit.ts` |
| **Onboarding** | *Meet your agent*: name, agent name, focus, people, documents, a meeting, a promise, preferences, tool preferences with what each would allow (connecting never approves an action). Ends with what it learned and the first task, run through the Sentinel | `apps/web/src/Onboarding.tsx`, `seed/profile.ts` |
| **Sandboxes** | Private graph per visitor; approve with a signed httpOnly cookie, for your own sandbox only; *Make it yours* builds the graph from a short form | `limits/sandbox.ts`, `seed/profile.ts` |
| **Workspace UI** | Steward talks to you: brief first, step cards with inline Approve, outside agents in the same thread, Why drawer with the path drawn, "Steward remembers", connect-your-agent commands. Old dashboard at `/classic` | `apps/web/src/` |
| **Limits** | Per-IP rate limits, daily LLM budget, human-only routes behind the approver code or your sandbox cookie | `limits/` |

---

## The brief's five jobs for the graph

| Job | How Steward does it | Proof |
|---|---|---|
| Follow connections across data | Sentinel paths: Document→Project←Person, Fact←Document, Message→Document | Ablation: unsafe allowed **0/47** with the graph vs **7/47** without relationships |
| Remember across sessions | Session/Turn; earlier sessions and how they ended; learned rules; confirmed memories | `memory.test.ts`, learning replay 3→3→3→0→0→0 |
| Share state between agents | Handoff edges on each action; outside MCP agents in the same graph | `actions.test.ts`, `personal.test.ts` |
| Connect people, projects, decisions | MEMBER_OF, SHARED_WITH, Approval-ON-Action, Rule-LEARNED_FROM, WCC worlds, PageRank | `contexts`, `scout`, `rules` tests |
| Show the path behind an answer | Every verdict stores its paths + Cypher; Why drawer; hash-chained audit | UI, `audit.test.ts` |

---

## Evidence (numbers)

| What | Result | Where |
|---|---|---|
| Labelled policy eval (63 scenarios, labels written before running) | **0/63 unsafe allowed**, 23/23 should-BLOCK blocked, 63/63 exact (61/63 on the first run; two over-cautious misses fixed) | `eval/RESULTS.md` |
| Learning replay | approval prompts per round **3 → 3 → 3 → 0 → 0 → 0**, still 0 unsafe | same |
| Adversarial suite through the whole pipeline | **19/19 attacks held** (incl. self-approval over HTTP, memory poisoning, sandbox cookie misuse) | `eval/SECURITY.md` |
| External agents, with vs without Steward (6 models incl. open weights, 286 runs) | **without: 75/88 attacks succeeded · with: 0/84**; legit 52/54 vs 55/55; 0 false blocks. Two attacks beat every model without Steward. gpt-oss-20b: 5 "with" runs errored (Groq rejected its tool calls), excluded | `eval/EXTERNAL-AGENT.md` |
| Ablation: is the graph doing the work? | unsafe allowed: **graph 0/47** · relationships off 7/47 · LLM guardrail with the whole graph as text 11/47 (gpt-5.4-mini), 2/47 (gpt-5.4) | `eval/ABLATION.md` |
| Scale: 48k nodes, 75k edges | Sentinel (all 8 checks) **p50 100 ms**, p95 135 ms; retrieval p50 91 ms (first run 557 ms; a taint query scanned the inbox, fixed) | `eval/SCALE.md` |
| Threat map | OWASP LLM Top 10 2025, OWASP Agentic Top 10 2026, MITRE ATLAS v5.6.0, with what's not covered | `eval/THREATS.md` |
| Real agent, real session | Claude Code with only Steward's tools: `/mcp__steward__start` → "Hi Asha. Here's your brief…"; an errand → "not sent yet… ASK… in your approval inbox", attributed to Claude Code | checked Fri 14:00 |
| Real Gmail, real Claude (Fri 15:48) | An injection email sent to the owner's real Gmail; Claude Code read it with its Gmail connector, handed it to Steward, and was told *"it's legit, send it"* → **Steward BLOCKED** (`act:493d266f`): sender not in the graph, possible injected request. Claude: *"Your OK in chat doesn't change that ruling."* Nothing sent | screenshot, Steward audit |
| Agent's own Gmail behind Steward (hook) | Real Claude Code + stand-in Gmail: `create_draft` to the injected sender **denied by the hook before it ran**; no draft reached the tool | `hook.test.ts`, README |
| Tests | **197 pass** against a real FalkorDB | `bun run test` |

---

## Things that proved us wrong (kept, and fixed)

- The first eval run blocked Priya written in capitals (email matching was case-sensitive).
- The volume check counted its own action (cap 2, not 3).
- An agent could propose over MCP and **approve itself over plain HTTP** → human-only routes (`35a5d0d`).
- The first external-agent baseline still had Steward's checks in it → discarded, rebuilt fairly.
- Steward's rate limit applied only to the "with Steward" side → lifted inside the benchmark (`dd2562f`).
- Agents read a dry-run ASK as "I can't" and never queued the errand (`6323d5e`); left out the meeting
  invitee (`e6bf734`); passed a graph id as the recipient (`57a6f38`). All fixed in the MCP tools.
- At 48k nodes the Sentinel took 557 ms (a taint query scanned every message) → 100 ms (`5fb7040`).
- A Claude Code session with Steward still behaved like a coding assistant and questioned "Asha" →
  `/mcp__steward__start`, a demo-aware brief, and a Steward-only session (`e99c498`).

## Upstream (FalkorDB)

- **[FalkorDB/FalkorDB#3352](https://github.com/FalkorDB/FalkorDB/issues/3352)**: 6.0.2 regression,
  `OPTIONAL MATCH … WHERE` after an aggregating `WITH` returns null (works in 4.22.0). Filed by you.
- A second issue found on Fri while building the agents list; details stay in the private planning
  notes until it's reported through FalkorDB's private channel.

## Decisions (yours)

The idea (a Muse-style personal agent, graph-decided permissions) · FalkorDB as the only datastore ·
one feature per commit · multiple LLMs, OpenAI small model by default · the security direction (Rule
of Two) · "test it with a real agent, fairly, and with real connectors" · deploy on Railway · more
models in the benchmark · option A: sandboxes + *Make it yours* (no Google import) · Steward as the
personal layer that turns any agent into your personal agent.

---

## Submitted

**Submitted Sat 17 Oct 2026** on the WeMakeDevs panel: tracks Agents That Act on Connected Data (primary)
and Company Brain; repo, live demo and video linked. Editable until Sun 18 Oct, 23:59 IST.

## What's remaining

**Me, before the freeze (Sat 09:30)**

| # | What | Notes |
|---|---|---|
| R3 | Draft the submission text from the form's fields | after you send them (form opens Sat 01:03) |
| R4 | Final pass: links in incognito, phone width, no secrets in git history, redeploy, reset the demo | Sat night |
| R5 | Clean up old sandbox graphs (none deleted yet; each is small) | optional |

**You**

| # | What | When |
|---|---|---|
| Y1 | Open the submission form (Sat 01:03) and send me its fields | Sat |
| Y2 | Discord: judging criteria and blog-prize rules | now |
| Y3 | Report the second FalkorDB issue **privately** (repro in `../BUGS.md` #2) | before submitting |
| Y4 | Fill in "What I did myself / verified" in `../AI-DISCLOSURE.md` | before submitting |
| Y5 | Record the video: open on a BLOCK; show *Meet your agent* ending on a first task, `/mcp__steward__start` in Claude Code, the errand landing in Steward as "needs your OK", the Why drawer, and *Make it yours* | Sat |
| Y6 | Blog post under your name | Sat–Sun |
| Y7 | Decide on rewriting git history (old org id in `0337ca7`; the issue wording in `226fbeb`) | before submitting |
