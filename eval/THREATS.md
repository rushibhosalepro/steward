# Threat map: OWASP and MITRE ATLAS

Each threat Steward claims to handle, the defence, and the test that proves it. IDs are from the
**OWASP Top 10 for LLM Applications 2025**, the **OWASP Top 10 for Agentic Applications 2026**, and
**MITRE ATLAS v5.6.0** (checked against MITRE's `atlas-data` on 16 Oct 2026). Where Steward does
nothing, it says so.

## Why this matters

- **EchoLeak (CVE-2025-32711, CVSS 9.3, June 2025):** an email with hidden instructions got
  Microsoft 365 Copilot to gather internal data and send it out, with no click from the user. That is
  Steward's A1 and S16 pattern: an injected inbox message steering an assistant that has your data
  and can act.
- **CoSnitch (CVE-2026-24301, patched August 2026):** a crafted link ran a prompt in a victim's Copilot
  session, queried connected-account data and sent it out, and could also write instructions into
  persistent memory. OWASP maps it to ASI01, ASI02, ASI03 and ASI06
  ([OWASP GenAI exploit roundup Q3 2026](https://genai.owasp.org/2026/10/08/genai-and-agentic-ai-exploit-roundup-q3-2026/)).

In both, the model was the only thing deciding. In Steward, the model proposes and the graph decides.

## Covered

| Threat | OWASP | ATLAS | Steward's defence | Proof |
|---|---|---|---|---|
| Instructions hidden in an email or document steer the agent | LLM01 Prompt Injection · ASI01 Agent Goal Hijack | AML.T0051.001 LLM Prompt Injection: Indirect | Provenance check (who asked, read from the graph, not the model's claim); Rule of Two: untrusted input + private data + external effect → a human must approve | S04, S05, S16 · external agents A1, A4, A5, A7: **0/40 with Steward** ([EXTERNAL-AGENT.md](EXTERNAL-AGENT.md)) |
| Private data sent to someone not cleared for it | LLM02 Sensitive Information Disclosure | AML.T0057 LLM Data Leakage | Information flow: a document reaches a person only through a path (project membership or an explicit share) | eval neg-leak group; ablation: relationships off lets **7/47** unsafe actions through, graph **0/47** ([ABLATION.md](ABLATION.md)) |
| The agent uses its send / share / invite tools to move data out | ASI02 Tool Misuse and Exploitation | AML.T0086 Exfiltration via AI Agent Tool Invocation · AML.T0053 AI Agent Tool Invocation | Every tool call is checked by the Sentinel before it runs; the Executor re-checks; content flow catches a fact typed into the text or an invite title | S01, S02, S07 · A3, A8: leaked by **every** model without Steward, 0 with |
| The agent does more than it was asked | LLM06 Excessive Agency | — | Learned rules are scoped capabilities: one person, one action type, data up to "internal", 30-day expiry; a rule never overrides a BLOCK; volume cap of 3 outbound per source | S06, S08, S09 · learning replay: still 0 unsafe after rules are earned |
| The agent approves itself or raises its own privileges | ASI03 Identity and Privilege Abuse | — | No approve tool over MCP; approve, rules, pause and reset are human-only routes behind an approver code agents never see | S12, S17 (a self-approval bypass found and closed during the build) |
| Restricted data reaches the model's context, to be leaked later | LLM02 · LLM07 System Prompt Leakage (secrets in context) | AML.T0085 Data from AI Services | Context firewall: restricted facts never enter the planner's prompt or any MCP read; provider keys never reach the model, plans, MCP output or the audit log | S03, S14 |
| Poisoned memory steers later sessions | ASI06 Memory and Context Poisoning | AML.T0080 AI Agent Context Poisoning | Memory is graph nodes with provenance: rules come only from human approvals (`LEARNED_FROM` edges); session turns record only the user's requests; nothing an email says is stored as an instruction | `rules.test.ts`, `memory.test.ts` |
| A convincing explanation gets a human to approve a leak | ASI09 Human-Agent Trust Exploitation | — | The Why panel shows the graph paths and Cypher, not the model's argument; should-BLOCK actions are blocked, not left for a human to approve | eval: **23/23 should-BLOCK blocked, 0 softened to ASK** |
| Multi-agent handoffs are spoofed or skipped | ASI07 Insecure Inter-Agent Communication | — | Agents never message each other: each leaves an edge on the action (PROPOSED, CHECKED, CLAIMED_BY, EXECUTED), and the Executor runs only a claimed, re-checked action | `actions.test.ts`, `executor.test.ts`, S09, S10 |
| One mistake spreads, or the agent keeps going | ASI08 Cascading Failures · ASI10 Rogue Agents | — | Kill switch (nothing runs while paused); hash-chained audit trail, verifiable at `/users/:id/audit/verify` | S11, S13 |
| Someone spends the model budget through the public demo | LLM10 Unbounded Consumption | — | Per-IP rate limits, a daily LLM budget | `limits.test.ts` |

## Not covered

| Threat | Why not |
|---|---|
| LLM03 Supply Chain · ASI04 Agentic Supply Chain (AML.T0010) | Steward trusts its npm dependencies, FalkorDB and the LLM provider |
| LLM04 Data and Model Poisoning | Steward doesn't train models |
| LLM05 Improper Output Handling · ASI05 Unexpected Code Execution | Steward has no tool that runs code or shell; model output is parsed into a typed action, never executed |
| LLM08 Vector and Embedding Weaknesses | No vector index (full-text and graph traversal only) |
| LLM09 Misinformation | Steward checks where data may go, not whether the model's text is true |
| A fact paraphrased so no marker matches ("forty-eight thousand") | Content flow matches recorded markers, not meaning |
| An attacker with database or server access | Out of scope: the Sentinel runs in the same process as the API |
