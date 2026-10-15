import type { Graph } from "falkordb";
import { proposeAction } from "../actions/actions";
import { executeAction, type ExecResult } from "../executor/executor";
import { renderContext, retrieve } from "../retrieval/retrieve";
import type { ProposedAction } from "../sentinel/sentinel";
import { ClaudePlanner } from "./claude";
import { OfflinePlanner } from "./offline";
import type { PlannedAction, Planner } from "./types";

// Request -> retrieve the subgraph -> planner proposes -> every action through the Sentinel
// -> anything ALLOWed runs. The whole chain is written to the graph:
//   (Request)-[:PRODUCED]->(Plan)-[:HAS]->(Step)-[:PROPOSES]->(Action)
//   (Plan)-[:USED_CONTEXT]->(entry points)   (Agent planner)-[:WROTE]->(Plan)

export function choosePlanner(name?: string): Planner {
  const wanted = name ?? process.env.STEWARD_PLANNER;
  if (wanted === "offline") return new OfflinePlanner();
  if (wanted === "claude") return new ClaudePlanner();
  return process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN ? new ClaudePlanner() : new OfflinePlanner();
}

const toMs = (iso: string | null) => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

export function toProposed(a: PlannedAction, requestId: string, requestText: string): ProposedAction {
  return {
    type: a.type,
    to: a.to ?? undefined,
    docs: a.docs.length ? a.docs : undefined,
    subject: a.subject ?? undefined,
    body: a.body ?? undefined,
    title: a.title ?? undefined,
    start: toMs(a.start),
    end: toMs(a.end),
    due: toMs(a.due),
    // A cited id we can't resolve is kept as-is: the Sentinel then ASKs (unknown source), fail closed.
    derivedFrom: a.derived_from === "request" ? requestId : a.derived_from,
    request: requestText,
  };
}

export async function planRequest(g: Graph, request: string, planner: Planner) {
  const now = Date.now();
  const requestId = `req:${crypto.randomUUID()}`;
  const planId = `plan:${crypto.randomUUID()}`;
  await g.query("CREATE (:Entity:Request {id: $id, text: $text, ts: $ts})", { params: { id: requestId, text: request, ts: now } });

  const ctx = await retrieve(g, request);
  const plan = await planner.plan(request, ctx, renderContext(ctx, now));

  await g.query(
    `MATCH (r:Request {id: $requestId}), (a:Agent {id: 'a:planner'})
     CREATE (r)-[:PRODUCED]->(p:Entity:Plan {id: $planId, summary: $summary, planner: $planner, ts: $ts})
     CREATE (a)-[:WROTE]->(p)
     WITH p UNWIND $entries AS eid MATCH (e:Entity {id: eid}) CREATE (p)-[:USED_CONTEXT]->(e)`,
    { params: { requestId, planId, summary: plan.summary, planner: planner.name, ts: now, entries: ctx.entryPoints.map((e) => e.id) } },
  );

  const nameOf = new Map(ctx.nodes.map((n) => [n.id, n.name]));
  const personByEmail = new Map(ctx.nodes.filter((n) => n.label === "Person").map((n) => [String(n.props.email), n.name]));
  const steps = [];
  for (const [i, planned] of plan.actions.entries()) {
    const proposed = await proposeAction(g, toProposed(planned, requestId, request), "a:planner");
    await g.query(
      `MATCH (p:Plan {id: $planId}), (a:Action {id: $actionId})
       CREATE (p)-[:HAS]->(s:Entity:Step {id: $stepId, order: $order, rationale: $rationale})-[:PROPOSES]->(a)`,
      { params: { planId, actionId: proposed.id, stepId: `step:${crypto.randomUUID()}`, order: i + 1, rationale: planned.rationale } },
    );
    const execution: ExecResult | null = proposed.status === "ready" ? await executeAction(g, proposed.id) : null;
    steps.push({
      order: i + 1,
      rationale: planned.rationale,
      action: {
        id: proposed.id, type: planned.type, to: planned.to, docs: planned.docs, title: planned.title, subject: planned.subject,
        target: planned.to ? personByEmail.get(planned.to) ?? null : null,
        docTitles: planned.docs.map((d) => nameOf.get(d) ?? d),
      },
      verdict: proposed.verdict,
      reason: proposed.reason,
      status: execution?.ok ? "done" : execution ? execution.status : proposed.status,
      execution,
    });
  }

  return {
    requestId,
    planId,
    planner: planner.name,
    summary: plan.summary,
    context: { entryPoints: ctx.entryPoints.map((e) => e.id), nodes: ctx.nodes.length, edges: ctx.edges.length },
    steps,
  };
}
