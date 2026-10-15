# Scale: Steward's graph queries on a ~50k-node user graph

Run at 2026-10-15T14:08:33.186Z on local Docker (FalkorDB, Windows host). Synthetic user graph: **48,006 nodes,
75,500 edges** (people, projects, documents with facts, inbound mail, meetings), built in 4.3s.

| Operation (per call) | p50 | p95 | max | samples |
|---|---|---|---|---|
| **Sentinel: all 8 checks for one proposed action** | **100 ms** | 135 ms | 203 ms | 200 |
| Planner retrieval (full-text entry points + multi-hop expansion + facts) | 91 ms | 101 ms | 112 ms | 100 |

Verdict mix on random actions: ASK 100 · BLOCK 100.

Times include the client round trips (each check is several Cypher queries, run one after another).

**Why no ALLOW:** these are emails, and outbound mail is ASK until the user has approved the same kind
of send three times (a standing rule). Half the samples are legitimate (ASK), half leak (BLOCK).

**Found by this benchmark.** The first run at this size gave a Sentinel p50 of **557 ms**. Profiling
each query showed the Rule of Two taint check scanning *every* inbound message (~380 ms), and the
fact scan running up to three times per action. Fixed: the taint queries now start from the indexed
recipient and the data being sent, and fact matching runs once per action. Same verdicts afterwards
(policy eval 63/63 exact, adversarial suite 17/17, 168 tests). What's left is mostly the one full
scan over Facts for content flow (~45 ms at 10k facts); an indexed marker lookup would remove it.
