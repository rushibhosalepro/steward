import { FalkorDB } from "falkordb";

const url = process.env.FALKORDB_URL ?? "falkor://localhost:6379";

export const db = await FalkorDB.connect({ url });

const owner = new WeakMap<object, string>();

// One isolated graph per user: memory, rules and actions never cross users.
export function graphFor(userId: string) {
  if (!/^[a-z0-9_-]+$/i.test(userId)) throw new Error(`invalid user id: ${userId}`);
  const graph = db.selectGraph(`user_${userId}`);
  owner.set(graph, userId);
  return graph;
}

// Which Steward user a graph handle belongs to (e.g. to decide whether a connector applies).
export const userOf = (graph: object) => owner.get(graph);
