import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { isPaused, setPaused, verifyAudit } from "./audit/audit";
import { db, graphFor } from "./db";
import { seedDemo } from "./seed/seed";
import { decide, getAction, isProposedAction, listActions, listInbox, proposeAction } from "./actions/actions";
import { calendarView, executeAction, outbox, runExecutor, tasksView } from "./executor/executor";
import { decideRule, listRules } from "./rules/rules";
import { ingestMail, listMail, type InboundMail } from "./ingest/ingest";
import { createMcpServer } from "./mcp/server";
import { availablePlanners, choosePlanner, planRequest } from "./planner/plan";
import { renderContext, retrieve } from "./retrieval/retrieve";
import { decideSuggestion, runScout } from "./scout/scout";
import { check } from "./sentinel/sentinel";

const app = new Hono();

app.get("/health", async (c) => {
  const graphs = await db.list();
  return c.json({ ok: true, graphs });
});

// Smoke test: proves the API can read and write a user's graph.
app.get("/users/:id/ping", async (c) => {
  const graph = graphFor(c.req.param("id"));
  const res = await graph.query<{ at: number }>(
    "MERGE (u:User {id: $id}) SET u.last_seen = timestamp() RETURN u.last_seen AS at",
    { params: { id: c.req.param("id") } },
  );
  return c.json({ ok: true, last_seen: res.data?.[0]?.at });
});

// Reset the user's graph to the synthetic demo world.
app.post("/users/:id/seed", async (c) => {
  const counts = await seedDemo(graphFor(c.req.param("id")));
  return c.json({ ok: true, ...counts });
});

// What's in the user's graph, by label and by edge type.
app.get("/users/:id/overview", async (c) => {
  const graph = graphFor(c.req.param("id"));
  const labels = await graph.roQuery<{ label: string; count: number }>(
    "MATCH (n:Entity) UNWIND labels(n) AS label WITH label WHERE label <> 'Entity' RETURN label, count(*) AS count ORDER BY label",
  );
  const edges = await graph.roQuery<{ type: string; count: number }>(
    "MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY type",
  );
  return c.json({ nodes: labels.data ?? [], edges: edges.data ?? [] });
});

const BAD_ACTION = { error: "need { type, derivedFrom, to?, docs?, start?, end?, subject?, body?, title?, due?, request? }" };

// Dry-run the Sentinel on a proposed action: verdict + every check with its path and Cypher.
app.post("/users/:id/sentinel/check", async (c) => {
  const action = await c.req.json().catch(() => null);
  if (!isProposedAction(action)) return c.json(BAD_ACTION, 400);
  return c.json(await check(graphFor(c.req.param("id")), action));
});

// Propose an action: the Sentinel checks it and it's stored in the graph with its verdict.
app.post("/users/:id/actions", async (c) => {
  const action = await c.req.json().catch(() => null);
  if (!isProposedAction(action)) return c.json(BAD_ACTION, 400);
  return c.json(await proposeAction(graphFor(c.req.param("id")), action), 201);
});

// The approval inbox: every action the Sentinel answered with ASK.
app.get("/users/:id/inbox", async (c) => c.json(await listInbox(graphFor(c.req.param("id")))));

// The activity feed: every action, newest first.
app.get("/users/:id/actions", async (c) => c.json(await listActions(graphFor(c.req.param("id")))));

// One action with everything the "why" panel needs.
app.get("/users/:id/actions/:actionId", async (c) => {
  const action = await getAction(graphFor(c.req.param("id")), c.req.param("actionId"));
  return action ? c.json(action) : c.json({ error: "no such action" }, 404);
});

// Approving an action also runs it; rejecting just records the decision.
for (const [path, decision] of [["approve", "approved"], ["reject", "rejected"]] as const) {
  app.post(`/users/:id/actions/:actionId/${path}`, async (c) => {
    const graph = graphFor(c.req.param("id"));
    const actionId = c.req.param("actionId");
    const body = await c.req.json<{ note?: string }>().catch(() => ({ note: undefined }));
    const r = await decide(graph, actionId, decision, body.note);
    if (!r.ok) return c.json({ error: r.error }, r.code);
    if (decision === "rejected") return c.json(r);
    return c.json({ ...r, execution: await executeAction(graph, actionId) });
  });
}

app.post("/users/:id/actions/:actionId/execute", async (c) => {
  const r = await executeAction(graphFor(c.req.param("id")), c.req.param("actionId"));
  return c.json(r, r.ok ? 200 : r.status === "missing" ? 404 : 409);
});

// One Executor pass over everything ready or approved.
app.post("/users/:id/executor/run", async (c) => c.json(await runExecutor(graphFor(c.req.param("id")))));

// Procedural memory: proposed, active, declined and revoked rules.
app.get("/users/:id/rules", async (c) => c.json(await listRules(graphFor(c.req.param("id")))));

for (const decision of ["accept", "decline", "revoke"] as const) {
  app.post(`/users/:id/rules/:ruleId/${decision}`, async (c) => {
    const r = await decideRule(graphFor(c.req.param("id")), c.req.param("ruleId"), decision);
    return r.ok ? c.json(r) : c.json({ error: r.error }, r.code);
  });
}

// GraphRAG retrieval: what the Planner will see for a request (entry points, subgraph, rendered text).
app.post("/users/:id/context", async (c) => {
  const body = await c.req.json<{ request?: string }>().catch(() => ({ request: undefined }));
  if (typeof body.request !== "string" || !body.request.trim()) return c.json({ error: "need { request }" }, 400);
  const ctx = await retrieve(graphFor(c.req.param("id")), body.request);
  return c.json({ ...ctx, rendered: renderContext(ctx) });
});

// Which planners this server can run (offline always; LLM providers when their key is set).
app.get("/planners", (c) => c.json({ available: availablePlanners(), default: process.env.STEWARD_PLANNER || "auto" }));

// The front door: a sentence in, a plan of Sentinel-checked actions out. ALLOWed actions run;
// ASKs land in the inbox; BLOCKs are recorded. { planner?: "claude" | "offline" } overrides the default.
app.post("/users/:id/requests", async (c) => {
  const body = await c.req.json<{ request?: string; planner?: string }>().catch(() => ({ request: undefined, planner: undefined }));
  if (typeof body.request !== "string" || !body.request.trim()) return c.json({ error: "need { request }" }, 400);
  let planner;
  try {
    planner = choosePlanner(body.planner);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  try {
    return c.json(await planRequest(graphFor(c.req.param("id")), body.request, planner), 201);
  } catch (err) {
    return c.json({ error: `planning failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
});

// Inbound mail: resolve sender and mentions, extract a request (simulated mailbox, synthetic data).
app.post("/users/:id/mail", async (c) => {
  const m = await c.req.json<Partial<InboundMail>>().catch(() => null);
  if (!m?.from?.email || typeof m.subject !== "string" || typeof m.body !== "string") {
    return c.json({ error: "need { from: { email, name? }, subject, body }" }, 400);
  }
  return c.json(await ingestMail(graphFor(c.req.param("id")), m as InboundMail), 201);
});
app.get("/users/:id/mail", async (c) => c.json(await listMail(graphFor(c.req.param("id")))));

// Scout: proactive suggestions, ranked by urgency and PageRank. GET runs a fresh pass
// (in production this would be on a schedule). Scout never acts on its own.
app.get("/users/:id/suggestions", async (c) => c.json(await runScout(graphFor(c.req.param("id")))));

for (const decision of ["dismiss", "accept", "decline"] as const) {
  app.post(`/users/:id/suggestions/:sid/${decision}`, async (c) => {
    const r = await decideSuggestion(graphFor(c.req.param("id")), c.req.param("sid"), decision);
    return r.ok ? c.json(r) : c.json({ error: r.error }, 409);
  });
}

// MCP over Streamable HTTP, stateless: a fresh server + transport per request, scoped to the user.
app.all("/users/:id/mcp", async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await createMcpServer(c.req.param("id")).connect(transport);
  return transport.handleRequest(c.req.raw);
});

// Kill switch and audit trail. Pausing stops the Executor; the audit chain is append-only and
// verifiable. Deliberately not exposed over MCP.
app.get("/users/:id/pause", async (c) => c.json({ paused: await isPaused(graphFor(c.req.param("id"))) }));
app.post("/users/:id/pause", async (c) => {
  const body = await c.req.json<{ paused?: boolean }>().catch(() => ({ paused: undefined }));
  if (typeof body.paused !== "boolean") return c.json({ error: "need { paused: boolean }" }, 400);
  return c.json(await setPaused(graphFor(c.req.param("id")), body.paused));
});
app.get("/users/:id/audit/verify", async (c) => c.json(await verifyAudit(graphFor(c.req.param("id")))));

// The sandboxed tools' state, read straight from the graph.
app.get("/users/:id/outbox", async (c) => c.json(await outbox(graphFor(c.req.param("id")))));
app.get("/users/:id/calendar", async (c) => c.json(await calendarView(graphFor(c.req.param("id")))));
app.get("/users/:id/tasks", async (c) => c.json(await tasksView(graphFor(c.req.param("id")))));

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch,
};
