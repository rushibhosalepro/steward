import { Hono } from "hono";
import { db, graphFor } from "./db";
import { seedDemo } from "./seed/seed";

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

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: app.fetch,
};
