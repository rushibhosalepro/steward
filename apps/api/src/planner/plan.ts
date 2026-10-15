import type { Graph } from "falkordb";
import { proposeAction } from "../actions/actions";
import { executeAction, type ExecResult } from "../executor/executor";
import { renderContext, retrieve } from "../retrieval/retrieve";
import type { ProposedAction } from "../sentinel/sentinel";
import { ClaudePlanner } from "./claude";
import { OfflinePlanner } from "./offline";
import { OpenAICompatiblePlanner, PROVIDERS } from "./openai-compatible";
import type { PlannedAction, Planner, PlanOutcome } from "./types";
import type { Context } from "../retrieval/retrieve";

// Request -> retrieve the subgraph -> planner proposes -> every action through the Sentinel
// -> anything ALLOWed runs. The whole chain is written to the graph:
//   (Request)-[:PRODUCED]->(Plan)-[:HAS]->(Step)-[:PROPOSES]->(Action)
//   (Plan)-[:USED_CONTEXT]->(entry points)   (Agent planner)-[:WROTE]->(Plan)

type Env = Record<string, string | undefined>;
const AUTO_ORDER = ["xai", "gemini", "groq", "openrouter", "ollama"];

const hasClaude = (env: Env) => !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);

// Every planner that can run with the current environment. "offline" always can.
export function availablePlanners(env: Env = process.env) {
  return [
    "offline",
    ...(hasClaude(env) ? ["claude"] : []),
    ...Object.entries(PROVIDERS).filter(([, make]) => make(env)).map(([name]) => name),
  ];
}

// An LLM planner wrapped so that any failure (bad key, network, output that won't validate)
// falls back to the offline planner instead of failing the request. The plan says so.
class WithFallback implements Planner {
  constructor(private primary: Planner, private fallback: Planner = new OfflinePlanner()) {}
  get name() {
    return this.primary.name;
  }
  async plan(request: string, ctx: Context, rendered: string): Promise<PlanOutcome> {
    try {
      return { ...(await this.primary.plan(request, ctx, rendered)), by: this.primary.name };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const plan = await this.fallback.plan(request, ctx, rendered);
      return { ...plan, by: this.fallback.name, note: `${this.primary.name} failed (${why.slice(0, 200)}); used the ${this.fallback.name} planner` };
    }
  }
}

// name: "auto" | "offline" | "claude" | a PROVIDERS key. Default from STEWARD_PLANNER, else auto:
// Claude if configured, else the first configured provider, else offline.
export function choosePlanner(name?: string, env: Env = process.env): Planner {
  const wanted = name || env.STEWARD_PLANNER || "auto";
  if (wanted === "offline") return new OfflinePlanner();
  if (wanted === "claude") {
    if (!hasClaude(env)) throw new Error("claude is not configured: set ANTHROPIC_API_KEY");
    return new WithFallback(new ClaudePlanner(env.STEWARD_MODEL ?? "claude-opus-5-5"));
  }
  if (wanted === "auto") {
    if (hasClaude(env)) return choosePlanner("claude", env);
    const first = AUTO_ORDER.find((p) => PROVIDERS[p]!(env));
    return first ? choosePlanner(first, env) : new OfflinePlanner();
  }
  const make = PROVIDERS[wanted];
  if (!make) throw new Error(`unknown planner "${wanted}"; use one of: auto, ${availablePlanners(env).join(", ")}`);
  const cfg = make(env);
  if (!cfg) throw new Error(`${wanted} is not configured: set its API key (see .env.example)`);
  return new WithFallback(new OpenAICompatiblePlanner(cfg));
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
     CREATE (r)-[:PRODUCED]->(p:Entity:Plan {id: $planId, summary: $summary, planner: $planner, note: $note, ts: $ts})
     CREATE (a)-[:WROTE]->(p)
     WITH p UNWIND $entries AS eid MATCH (e:Entity {id: eid}) CREATE (p)-[:USED_CONTEXT]->(e)`,
    { params: { requestId, planId, summary: plan.summary, planner: plan.by ?? planner.name, note: plan.note ?? "", ts: now, entries: ctx.entryPoints.map((e) => e.id) } },
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
    planner: plan.by ?? planner.name,
    note: plan.note ?? null,
    summary: plan.summary,
    context: { entryPoints: ctx.entryPoints.map((e) => e.id), nodes: ctx.nodes.length, edges: ctx.edges.length },
    steps,
  };
}
