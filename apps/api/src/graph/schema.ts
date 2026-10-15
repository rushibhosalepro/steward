import type { Graph } from "falkordb";

// Every node also carries :Entity so edges can be matched by id without knowing the label.
export const SCHEMA = [
  "CREATE INDEX FOR (e:Entity) ON (e.id)",
  "CREATE INDEX FOR (p:Person) ON (p.email)",
  "CREATE INDEX FOR (m:Meeting) ON (m.start)",
  // Full-text entry points for retrieval: names, titles, subjects and commitment text.
  "CREATE FULLTEXT INDEX FOR (e:Entity) ON (e.name, e.title, e.subject, e.what)",
];

export async function applySchema(graph: Graph) {
  for (const stmt of SCHEMA) {
    try {
      await graph.query(stmt);
    } catch (err) {
      if (!String(err).includes("already indexed")) throw err;
    }
  }
}
