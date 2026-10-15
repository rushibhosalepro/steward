import type { Graph } from "falkordb";

// GraphRAG retrieval: the Planner never sees the whole graph or a vector dump. It sees the
// neighbourhood of what the request is about, found in two graph steps:
//   1. entry points: full-text search over names, titles, subjects and commitments
//   2. expansion: every path of 1-2 hops out from those entry points, in one query
// Paths don't pass through the User (it connects to everything) or through Steward's own
// bookkeeping (agents, actions, approvals, rules, requests).

const STOPWORDS = new Set(
  ("a an and are as at be but by can could do for from has have her him his how i if in into is it its me my " +
    "of on or our please she should so that the their them then there they this to up was we what when " +
    "which who will with would you your about before after send prepare make get tomorrow today").split(" "),
);

const NOT_CONTEXT = ["User", "Agent", "Action", "Approval", "Rule", "Request", "Plan", "Step", "Suggestion"];

export type ContextNode = { id: string; label: string; name: string; props: Record<string, unknown> };
export type ContextEdge = { from: string; rel: string; to: string };
export type Context = {
  terms: string[];
  entryPoints: { id: string; label: string; name: string; score: number }[];
  nodes: ContextNode[];
  edges: ContextEdge[];
  user: { name: string; timezone: string; preferences: { key: string; value: string }[] } | null;
  cypher: string[];
};

// "Go through my inbox" names nobody: requests about mail start from the latest inbound messages.
const INBOX = /\b(inbox|mail|mails|emails?|messages?)\b/i;

export function searchTerms(request: string) {
  const words = request.toLowerCase().replace(/'s\b/g, "").match(/[a-z0-9]+/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

const Q = {
  entry: `CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score
WITH node, score WHERE none(l IN labels(node) WHERE l IN $exclude)
RETURN node.id AS id, [l IN labels(node) WHERE l <> 'Entity'][0] AS label,
       coalesce(node.name, node.title, node.subject, node.what) AS name, score
ORDER BY score DESC LIMIT $k`,

  recentMail: `MATCH (m:Message {direction: 'inbound'})
RETURN m.id AS id, 'Message' AS label, m.subject AS name, 0 AS score
ORDER BY m.ts DESC LIMIT 5`,

  people: `CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score
WITH node, score WHERE node:Person
RETURN node.id AS id, 'Person' AS label, node.name AS name, score
ORDER BY score DESC LIMIT 3`,

  expand: `MATCH p = (e:Entity)-[*1..2]-(n:Entity)
WHERE e.id IN $ids AND none(x IN nodes(p)[1..] WHERE any(l IN labels(x) WHERE l IN $exclude))
UNWIND relationships(p) AS r
WITH DISTINCT r
RETURN startNode(r).id AS from, type(r) AS rel, endNode(r).id AS to`,

  nodes: `MATCH (n:Entity) WHERE n.id IN $ids
RETURN n.id AS id, [l IN labels(n) WHERE l <> 'Entity'][0] AS label,
       coalesce(n.name, n.title, n.subject, n.what, n.text, n.id) AS name, properties(n) AS props`,

  facts: `MATCH (d:Document)-[r:CONTAINS]->(f:Fact) WHERE d.id IN $docs AND f.sensitivity IN ['public', 'internal']
RETURN d.id AS from, type(r) AS rel, f.id AS to`,

  user: `MATCH (u:User) OPTIONAL MATCH (u)-[:PREFERS]->(p:Preference)
RETURN u.name AS name, u.timezone AS timezone, collect({key: p.key, value: p.value}) AS preferences`,
};

export async function retrieve(g: Graph, request: string, k = 6): Promise<Context> {
  const terms = searchTerms(request);
  const cypher = [Q.entry, Q.people, Q.recentMail, Q.expand, Q.nodes, Q.user];

  const userRow = (await g.roQuery<NonNullable<Context["user"]>>(Q.user)).data?.[0];
  const user = userRow ? { ...userRow, preferences: userRow.preferences.filter((p) => p.key) } : null;

  const mail = INBOX.test(request) ? (await g.roQuery<Context["entryPoints"][number]>(Q.recentMail)).data ?? [] : [];
  if (!terms.length && !mail.length) return { terms, entryPoints: [], nodes: [], edges: [], user, cypher };

  // Each term matches as itself or as a prefix ("pric" finds "pricing"), OR'd together.
  const q = terms.map((t) => `${t}|${t}*`).join("|");
  const top = terms.length ? (await g.roQuery<Context["entryPoints"][number]>(Q.entry, { params: { q, k, exclude: NOT_CONTEXT } })).data ?? [] : [];
  // Errands are about people: always keep the best-matching people as entry points, even when
  // documents and tasks that share a word ("Atlas") outscore them.
  const people = terms.length ? (await g.roQuery<Context["entryPoints"][number]>(Q.people, { params: { q } })).data ?? [] : [];
  const entryPoints: Context["entryPoints"] = [];
  for (const e of [...top, ...people, ...mail]) if (!entryPoints.some((x) => x.id === e.id)) entryPoints.push(e);
  if (!entryPoints.length) return { terms, entryPoints, nodes: [], edges: [], user, cypher };

  const ids = entryPoints.map((e) => e.id);
  const edges = (await g.roQuery<ContextEdge>(Q.expand, { params: { ids, exclude: NOT_CONTEXT } })).data ?? [];

  // What the documents in context say, so the planner can write a real update...
  const docIds = [...new Set(edges.flatMap((e) => [e.from, e.to]).concat(ids))].filter((id) => id.startsWith("d:"));
  const factEdges = (await g.roQuery<ContextEdge>(Q.facts, { params: { docs: docIds } })).data ?? [];

  const nodeIds = [...new Set([...ids, ...edges.flatMap((e) => [e.from, e.to]), ...factEdges.map((e) => e.to)])];
  const rows = (await g.roQuery<ContextNode>(Q.nodes, { params: { ids: nodeIds } })).data ?? [];

  // ...except restricted ones. The context firewall: a restricted fact never reaches the model,
  // however it was reached, so a hijacked planner has nothing to leak. (The Sentinel's
  // content_flow check is the second line: it blocks the text if the fact gets out anyway.)
  const withheld = new Set(rows.filter((n) => n.label === "Fact" && n.props.sensitivity !== "public" && n.props.sensitivity !== "internal").map((n) => n.id));
  const nodes = rows.filter((n) => !withheld.has(n.id)).map((n) => {
    const { id: _id, ...props } = n.props;
    return { ...n, props };
  });
  const allEdges = [...edges, ...factEdges.filter((f) => !edges.some((e) => e.from === f.from && e.to === f.to && e.rel === f.rel))];

  return { terms, entryPoints, nodes, edges: allEdges.filter((e) => !withheld.has(e.from) && !withheld.has(e.to)), user, cypher: [...cypher, Q.facts] };
}

// The compact text form the Planner gets in its prompt: nodes with their ids and key
// properties, then edges as id triples. Ids let the Planner reference docs and people exactly.
export function renderContext(ctx: Context, now = Date.now()) {
  const fmt = (v: unknown) => (typeof v === "number" && v > 1e12 ? new Date(v).toISOString() : String(v));
  const lines = [`now: ${new Date(now).toISOString()}`];
  if (ctx.user) {
    lines.push(`user: ${ctx.user.name} (timezone ${ctx.user.timezone})`);
    for (const p of ctx.user.preferences) lines.push(`user preference: ${p.key} = ${p.value}`);
  }
  lines.push("", "nodes:");
  for (const n of ctx.nodes) {
    const props = Object.entries(n.props)
      .filter(([k]) => !["name", "title", "text", "markers"].includes(k))
      .map(([k, v]) => `${k}=${fmt(v)}`)
      .join(", ");
    const withheld = n.label === "Document" && n.props.sensitivity === "restricted" ? " [contents withheld: restricted]" : "";
    lines.push(`- [${n.id}] ${n.label} "${n.name}"${props ? ` (${props})` : ""}${withheld}`);
  }
  lines.push("", "edges:");
  for (const e of ctx.edges) lines.push(`- ${e.from} -${e.rel}-> ${e.to}`);
  return lines.join("\n");
}
