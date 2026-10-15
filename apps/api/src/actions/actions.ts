import type { Graph } from "falkordb";
import { proposeRuleIfEarned } from "../rules/rules";
import { check, type CheckResult, type ProposedAction, type Verdict } from "../sentinel/sentinel";

// Every proposed action becomes an Action node, wired to where it came from, who it
// targets, what it uses, which agents touched it, and the entities its verdict rests on.
// The approval inbox is just "Action nodes with status pending".

export type ActionStatus = "pending" | "ready" | "blocked" | "approved" | "rejected" | "done";

const STATUS_FOR: Record<Verdict, ActionStatus> = { ALLOW: "ready", ASK: "pending", BLOCK: "blocked" };

export const ACTION_TYPES = new Set(["send_email", "share_doc", "create_event", "create_task"]);

export function isProposedAction(x: unknown): x is ProposedAction {
  const a = x as ProposedAction;
  return !!a && ACTION_TYPES.has(a.type) && typeof a.derivedFrom === "string";
}

// FalkorDB properties can't be null or nested maps: drop empties, keep primitives and arrays.
function compact(obj: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

export async function proposeAction(g: Graph, action: ProposedAction, proposedBy = "a:planner") {
  const result = await check(g, action);
  const id = `act:${crypto.randomUUID()}`;
  const now = Date.now();
  const status = STATUS_FOR[result.verdict];

  // A request typed by the user becomes a Request node, so provenance is always a graph edge.
  let source = action.derivedFrom;
  if (source === "user") {
    source = `req:${crypto.randomUUID()}`;
    await g.query("CREATE (r:Entity:Request) SET r.id = $id, r.text = $text, r.ts = $ts", {
      params: { id: source, text: action.request ?? "", ts: now },
    });
  }

  const props = compact({
    type: action.type, status, verdict: result.verdict, reason: result.reason, created_at: now,
    to: action.to, docs: action.docs, start: action.start, end: action.end,
    subject: action.subject, body: action.body, title: action.title, due: action.due,
    checks: JSON.stringify(result.checks),
  });
  await g.query("CREATE (a:Entity:Action) SET a = $props, a.id = $id", { params: { props: props as never, id } });

  const link = (cypher: string, params: Record<string, unknown>) => g.query(cypher, { params: { id, ...params } as never });
  await link("MATCH (a:Action {id: $id}), (s:Entity {id: $source}) CREATE (a)-[:DERIVED_FROM]->(s)", { source });
  if (action.to) {
    await link("MATCH (a:Action {id: $id}), (p:Person {email: $to}) CREATE (a)-[:TARGETS]->(p)", { to: action.to });
  }
  if (action.docs?.length) {
    await link("MATCH (a:Action {id: $id}) UNWIND $docs AS doc MATCH (d:Document {id: doc}) CREATE (a)-[:USES]->(d)", { docs: action.docs });
  }
  await link(
    `MATCH (a:Action {id: $id}), (p:Agent {id: $proposer}), (s:Agent {id: 'a:sentinel'})
     CREATE (p)-[:PROPOSED]->(a), (s)-[:CHECKED {verdict: $verdict}]->(a)`,
    { proposer: proposedBy, verdict: result.verdict },
  );
  const justifications = result.checks.flatMap((c) => (c.refs ?? []).map((ref) => ({ ref, check: c.check, status: c.status })));
  if (justifications.length) {
    await link(
      `MATCH (a:Action {id: $id}) UNWIND $js AS j MATCH (e:Entity {id: j.ref})
       CREATE (a)-[:JUSTIFIED_BY {check: j.check, status: j.status}]->(e)`,
      { js: justifications },
    );
  }

  return { id, status, ...result };
}

export type InboxItem = {
  id: string; type: string; reason: string; created_at: number;
  to: string | null; target: string | null; docs: string[]; subject: string | null; title: string | null;
};

export async function listInbox(g: Graph) {
  const res = await g.roQuery<InboxItem>(
    `MATCH (a:Action {status: 'pending'})
     OPTIONAL MATCH (a)-[:TARGETS]->(p:Person)
     OPTIONAL MATCH (a)-[:USES]->(d:Document)
     RETURN a.id AS id, a.type AS type, a.reason AS reason, a.created_at AS created_at,
            a.to AS to, p.name AS target, collect(d.title) AS docs, a.subject AS subject, a.title AS title
     ORDER BY created_at DESC`,
  );
  return res.data ?? [];
}

export async function getAction(g: Graph, id: string) {
  const res = await g.roQuery<{ a: { properties: Record<string, unknown> } }>("MATCH (a:Action {id: $id}) RETURN a", { params: { id } });
  const node = res.data?.[0]?.a;
  if (!node) return null;
  const { checks, ...props } = node.properties;

  const why = await g.roQuery<{ check: string; status: string; label: string; name: string }>(
    `MATCH (a:Action {id: $id})-[j:JUSTIFIED_BY]->(e)
     RETURN j.check AS check, j.status AS status, [l IN labels(e) WHERE l <> 'Entity'][0] AS label,
            coalesce(e.name, e.title, e.subject, e.id) AS name`,
    { params: { id } },
  );
  const source = await g.roQuery<{ label: string; text: string }>(
    `MATCH (a:Action {id: $id})-[:DERIVED_FROM]->(s)
     RETURN [l IN labels(s) WHERE l <> 'Entity'][0] AS label, coalesce(s.subject, s.text, s.id) AS text`,
    { params: { id } },
  );
  const decisions = await g.roQuery<{ decision: string; note: string | null; ts: number }>(
    "MATCH (ap:Approval)-[:ON]->(a:Action {id: $id}) RETURN ap.decision AS decision, ap.note AS note, ap.ts AS ts ORDER BY ts",
    { params: { id } },
  );

  return {
    ...props,
    checks: JSON.parse(String(checks ?? "[]")) as CheckResult[],
    derivedFrom: source.data?.[0] ?? null,
    justifiedBy: why.data ?? [],
    decisions: decisions.data ?? [],
  };
}

export type Decision = "approved" | "rejected";
type ProposedRule = NonNullable<Awaited<ReturnType<typeof proposeRuleIfEarned>>>;
export type DecideResult =
  | { ok: true; status: Decision; proposedRule?: ProposedRule }
  | { ok: false; code: 404 | 409; error: string };

// Only pending (ASK) actions can be decided. A BLOCK is final: the user can't approve it in-app.
export async function decide(g: Graph, id: string, decision: Decision, note?: string): Promise<DecideResult> {
  const ts = Date.now();
  const res = await g.query<{ id: string }>(
    `MATCH (a:Action {id: $id}) WHERE a.status = 'pending'
     SET a.status = $decision, a.decided_at = $ts
     CREATE (ap:Entity:Approval {id: $apId, decision: $decision, note: $note, ts: $ts})-[:ON]->(a)
     RETURN a.id AS id`,
    { params: { id, decision, note: note ?? "", ts, apId: `ap:${crypto.randomUUID()}` } },
  );
  if (res.data?.length) {
    // An approval may earn a proposed rule; it never activates one.
    const proposedRule = decision === "approved" ? await proposeRuleIfEarned(g, id) : null;
    return proposedRule ? { ok: true, status: decision, proposedRule } : { ok: true, status: decision };
  }

  const existing = await g.roQuery<{ status: string }>("MATCH (a:Action {id: $id}) RETURN a.status AS status", { params: { id } });
  const current = existing.data?.[0]?.status;
  if (!current) return { ok: false, code: 404, error: "no such action" };
  if (current === "blocked") return { ok: false, code: 409, error: "blocked actions can't be approved" };
  return { ok: false, code: 409, error: `action is already ${current}` };
}
