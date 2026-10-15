import { Hono } from "hono";
import { db, graphFor } from "./db";
import { seedDemo } from "./seed/seed";
import { decide, getAction, isProposedAction, listInbox, proposeAction } from "./actions/actions";
import { calendarView, executeAction, outbox, runExecutor, tasksView } from "./executor/executor";
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

// The sandboxed tools' state, read straight from the graph.
app.get("/users/:id/outbox", async (c) => c.json(await outbox(graphFor(c.req.param("id")))));
app.get("/users/:id/calendar", async (c) => c.json(await calendarView(graphFor(c.req.param("id")))));
app.get("/users/:id/tasks", async (c) => c.json(await tasksView(graphFor(c.req.param("id")))));

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch,
};
