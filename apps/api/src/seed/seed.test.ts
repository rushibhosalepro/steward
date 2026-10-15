import { afterAll, beforeAll, expect, test } from "bun:test";
import { graphFor } from "../db";
import { demoWorld } from "./demo";
import { seedDemo } from "./seed";

const graph = graphFor("test_seed");

beforeAll(async () => {
  await seedDemo(graph);
});

afterAll(async () => {
  await graph.delete();
});

test("loads every node and edge of the demo world", async () => {
  const { nodes, edges } = demoWorld();
  const n = await graph.roQuery<{ c: number }>("MATCH (n:Entity) RETURN count(n) AS c");
  const e = await graph.roQuery<{ c: number }>("MATCH ()-[r]->() RETURN count(r) AS c");
  expect(n.data?.[0]?.c).toBe(nodes.length);
  expect(e.data?.[0]?.c).toBe(edges.length);
});

test("multi-hop: tomorrow's meeting with Priya leads to the latest Atlas update", async () => {
  const res = await graph.roQuery<{ doc: string }>(
    `MATCH (:Person {name: 'Priya Nair'})<-[:WITH]-(:Meeting)-[:ABOUT]->(p:Project)<-[:BELONGS_TO]-(d:Document)
     WHERE NOT ()-[:SUPERSEDES]->(d) AND d.sensitivity <> 'restricted'
     RETURN d.title AS doc`,
  );
  expect(res.data?.map((r) => r.doc)).toEqual(["Atlas project update (v2)"]);
});

test("Alex is not someone Asha knows", async () => {
  const res = await graph.roQuery<{ c: number }>(
    "MATCH (:User)-[:KNOWS]->(p:Person {email: 'alex.chen@unknown.example'}) RETURN count(p) AS c",
  );
  expect(res.data?.[0]?.c).toBe(0);
});

test("reseeding is idempotent", async () => {
  await seedDemo(graph);
  const n = await graph.roQuery<{ c: number }>("MATCH (n:Entity) RETURN count(n) AS c");
  expect(n.data?.[0]?.c).toBe(demoWorld().nodes.length);
});
