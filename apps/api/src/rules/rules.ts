import type { Graph } from "falkordb";

// Procedural memory. Repeated approvals of the same action type to the same person earn a
// *proposed* Rule. The user accepts, declines or later revokes it. Rules are deliberately
// narrow (one action type x one person), never activate themselves, never widen, and never
// override a BLOCK: the Sentinel only consults them after every other check passes.

export const APPROVALS_NEEDED = 3;
// An accepted rule is a capability that lapses: 30 days, then the user is asked again.
export const RULE_TTL = 30 * 24 * 3_600_000;

export type RuleStatus = "proposed" | "active" | "declined" | "revoked";

const TRANSITIONS = {
  accept: { from: "proposed", to: "active", active: true },
  decline: { from: "proposed", to: "declined", active: false },
  revoke: { from: "active", to: "revoked", active: false },
} as const;
export type RuleDecision = keyof typeof TRANSITIONS;

// Called after every approval. Counts approvals for this (type, person) since the last
// rejection or the last declined/revoked rule, and proposes a rule once there are enough.
export async function proposeRuleIfEarned(g: Graph, actionId: string) {
  const target = (
    await g.roQuery<{ type: string; email: string; name: string }>(
      "MATCH (a:Action {id: $actionId})-[:TARGETS]->(p:Person) RETURN a.type AS type, p.email AS email, p.name AS name",
      { params: { actionId } },
    )
  ).data?.[0];
  if (!target || target.type === "create_task") return null;
  const params = { type: target.type, email: target.email };

  const open = await g.roQuery<{ c: number }>(
    `MATCH (r:Rule {action_type: $type})-[:SCOPED_TO]->(:Person {email: $email})
     WHERE r.status IN ['proposed', 'active'] RETURN count(r) AS c`,
    { params },
  );
  if (open.data?.[0]?.c) return null;

  // Two queries on purpose: on FalkorDB 6.0.2, OPTIONAL MATCH ... WHERE after an aggregating
  // WITH drops matching rows (see ../BUGS.md #1), so the combined form silently returned null.
  const rejected = await g.roQuery<{ ts: number | null }>(
    `MATCH (rj:Approval {decision: 'rejected'})-[:ON]->(:Action {type: $type})-[:TARGETS]->(:Person {email: $email})
     RETURN max(rj.ts) AS ts`,
    { params },
  );
  const ruleEnded = await g.roQuery<{ ts: number | null }>(
    `MATCH (r:Rule {action_type: $type})-[:SCOPED_TO]->(:Person {email: $email})
     WHERE r.status IN ['declined', 'revoked'] RETURN max(r.decided_at) AS ts`,
    { params },
  );
  const after = Math.max(rejected.data?.[0]?.ts ?? 0, ruleEnded.data?.[0]?.ts ?? 0);

  const approvals = await g.roQuery<{ id: string }>(
    `MATCH (ap:Approval {decision: 'approved'})-[:ON]->(:Action {type: $type})-[:TARGETS]->(:Person {email: $email})
     WHERE ap.ts > $after RETURN ap.id AS id ORDER BY ap.ts`,
    { params: { ...params, after } },
  );
  const ids = (approvals.data ?? []).map((r) => r.id);
  if (ids.length < APPROVALS_NEEDED) return null;

  const id = `rule:${crypto.randomUUID()}`;
  const description = `${target.type.replace("_", " ")} to ${target.name}`;
  await g.query(
    `MATCH (p:Person {email: $email})
     CREATE (r:Entity:Rule {id: $id, action_type: $type, status: 'proposed', active: false,
                            description: $description, created_at: $ts,
                            max_sensitivity: 'internal'})-[:SCOPED_TO]->(p)
     WITH r UNWIND $ids AS apId MATCH (ap:Approval {id: apId}) CREATE (r)-[:LEARNED_FROM]->(ap)`,
    { params: { ...params, id, description, ts: Date.now(), ids } },
  );
  return { id, description, learnedFrom: ids.length };
}

export async function decideRule(g: Graph, id: string, decision: RuleDecision) {
  const t = TRANSITIONS[decision];
  const res = await g.query<{ id: string }>(
    `MATCH (r:Rule {id: $id}) WHERE r.status = $from
     SET r.status = $to, r.active = $active, r.decided_at = $ts,
         r.expires_at = CASE WHEN $to = 'active' THEN $ts + $ttl ELSE r.expires_at END
     RETURN r.id AS id`,
    { params: { id, from: t.from, to: t.to, active: t.active, ts: Date.now(), ttl: RULE_TTL } },
  );
  if (res.data?.length) return { ok: true as const, status: t.to };

  const cur = (await g.roQuery<{ status: string }>("MATCH (r:Rule {id: $id}) RETURN r.status AS status", { params: { id } })).data?.[0];
  if (!cur) return { ok: false as const, code: 404 as const, error: "no such rule" };
  return { ok: false as const, code: 409 as const, error: `rule is ${cur.status}; can only ${decision} a ${t.from} rule` };
}

export async function listRules(g: Graph) {
  const res = await g.roQuery<{
    id: string; status: RuleStatus; description: string; action_type: string; person: string; learnedFrom: number; created_at: number;
  }>(
    `MATCH (r:Rule)-[:SCOPED_TO]->(p:Person)
     OPTIONAL MATCH (r)-[:LEARNED_FROM]->(ap:Approval)
     RETURN r.id AS id, r.status AS status, r.description AS description, r.action_type AS action_type,
            p.name AS person, count(ap) AS learnedFrom, r.created_at AS created_at
     ORDER BY created_at DESC`,
  );
  return res.data ?? [];
}
