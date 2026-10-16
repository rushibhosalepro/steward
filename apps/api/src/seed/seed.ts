import type { Graph } from "falkordb";
import { applySchema } from "../graph/schema";
import { demoWorld, type SeedEdge, type SeedNode } from "./demo";
import { profileWorld, type Profile } from "./profile";

function groupBy<T>(items: T[], key: (t: T) => string) {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

const SAFE_NAME = /^[A-Z][A-Za-z_]*$/;

// Wipes the user's graph and loads the demo world.
export async function seedDemo(graph: Graph, now = Date.now()) {
  return loadWorld(graph, demoWorld(now));
}

// Wipes the user's graph and builds it from their own profile ("Make it yours").
export async function seedProfile(graph: Graph, profile: Profile, now = Date.now()) {
  return loadWorld(graph, profileWorld(profile, now));
}

// Labels and edge types can't be Cypher parameters, so they're checked against SAFE_NAME
// before being interpolated.
async function loadWorld(graph: Graph, { nodes, edges }: { nodes: SeedNode[]; edges: SeedEdge[] }) {

  try {
    await graph.delete();
  } catch {
    // graph didn't exist yet
  }
  await applySchema(graph);

  for (const [label, group] of groupBy<SeedNode>(nodes, (n) => n.label)) {
    if (!SAFE_NAME.test(label)) throw new Error(`bad label ${label}`);
    await graph.query(
      `UNWIND $rows AS row CREATE (n:Entity:${label}) SET n = row.props, n.id = row.id`,
      { params: { rows: group.map((n) => ({ id: n.id, props: n.props })) } },
    );
  }

  for (const [type, group] of groupBy<SeedEdge>(edges, (e) => e.type)) {
    if (!SAFE_NAME.test(type)) throw new Error(`bad edge type ${type}`);
    await graph.query(
      `UNWIND $rows AS row
       MATCH (a:Entity {id: row.from}), (b:Entity {id: row.to})
       CREATE (a)-[r:${type}]->(b) SET r = row.props`,
      { params: { rows: group.map((e) => ({ from: e.from, to: e.to, props: e.props ?? {} })) } },
    );
  }

  return { nodes: nodes.length, edges: edges.length };
}
