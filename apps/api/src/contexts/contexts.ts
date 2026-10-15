import type { Graph } from "falkordb";

// Contexts ("your worlds"): the separate parts of the user's life, found by FalkorDB's
// connected-components algorithm over people, projects and documents (MEMBER_OF, BELONGS_TO),
// leaving the user out because they connect everything. Each world is named after its
// projects; a component with no project is "Outside contacts".
//
// Why WCC and not community detection: label propagation (algo.labelPropagation) was tried on
// the same subgraph and fragmented it (a project landed in a different community from its own
// members); on a graph this small, connected components are the exact answer.

export type World = { id: string; name: string; people: string[]; documents: string[] };

export async function computeContexts(g: Graph): Promise<World[]> {
  const rows = (await g.roQuery<{ component: number; id: string; label: string; name: string }>(
    `CALL algo.WCC({nodeLabels: ['Person', 'Project', 'Document'], relationshipTypes: ['MEMBER_OF', 'BELONGS_TO']})
     YIELD node, componentId
     RETURN componentId AS component, node.id AS id, [l IN labels(node) WHERE l <> 'Entity'][0] AS label,
            coalesce(node.name, node.title) AS name`,
  )).data ?? [];

  const byComponent = new Map<number, typeof rows>();
  for (const r of rows) byComponent.set(r.component, [...(byComponent.get(r.component) ?? []), r]);

  const worlds: (World & { members: string[] })[] = [];
  const outside: typeof rows = [];
  for (const members of byComponent.values()) {
    const projects = members.filter((m) => m.label === "Project").map((m) => m.name).sort();
    if (!projects.length) {
      outside.push(...members);
      continue;
    }
    worlds.push({
      id: `ctx:${projects.join("+").toLowerCase().replace(/[^a-z0-9+]+/g, "-")}`,
      name: projects.join(" + "),
      people: members.filter((m) => m.label === "Person").map((m) => m.name).sort(),
      documents: members.filter((m) => m.label === "Document").map((m) => m.name).sort(),
      members: members.map((m) => m.id),
    });
  }
  if (outside.length) {
    worlds.push({
      id: "ctx:outside", name: "Outside contacts",
      people: outside.filter((m) => m.label === "Person").map((m) => m.name).sort(),
      documents: outside.filter((m) => m.label === "Document").map((m) => m.name).sort(),
      members: outside.map((m) => m.id),
    });
  }

  // Persist as graph facts: (Person|Document)-[:IN_CONTEXT]->(Context). Recomputed in full.
  await g.query("MATCH (c:Context) DETACH DELETE c");
  for (const w of worlds) {
    await g.query(
      `CREATE (c:Entity:Context {id: $id, name: $name})
       WITH c UNWIND $members AS mid MATCH (n:Entity {id: mid}) WHERE n:Person OR n:Document CREATE (n)-[:IN_CONTEXT]->(c)`,
      { params: { id: w.id, name: w.name, members: w.members } },
    );
  }
  return worlds.map(({ members: _m, ...w }) => w);
}

// The world an entity belongs to, for explanations ("Orbit roadmap is in your Orbit world").
export async function worldOf(g: Graph, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = (await g.roQuery<{ id: string; world: string }>(
    "MATCH (n:Entity)-[:IN_CONTEXT]->(c:Context) WHERE n.id IN $ids RETURN n.id AS id, c.name AS world",
    { params: { ids } },
  )).data ?? [];
  return new Map(rows.map((r) => [r.id, r.world]));
}
