import type { Graph } from "falkordb";
import { graphFor } from "../db";
import { applySchema } from "../graph/schema";
import { retrieve } from "../retrieval/retrieve";
import { check } from "../sentinel/sentinel";

// "Fast enough to run on every step of an agent loop" (FalkorDB's own claim), measured on
// Steward's real queries: a synthetic user graph of ~50k nodes, then the Sentinel's full check
// (all 8 checks, ~15 Cypher queries) and the planner's retrieval, timed per call.
// Usage: bun run eval:scale [--people 5000]

const N = (name: string, d: number) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

async function batched<T>(g: Graph, rows: T[], cypher: string, size = 2000) {
  for (let i = 0; i < rows.length; i += size) await g.query(cypher, { params: { rows: rows.slice(i, i + size) as never } });
}

export async function buildScaleGraph(g: Graph, people = 5000) {
  const r = rng(42);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const projects = Math.max(10, Math.round(people / 10));
  const docs = people * 2;
  const messages = people * 4;
  const meetings = Math.round(people / 2);

  try { await g.delete(); } catch { /* new graph */ }
  await applySchema(g);
  await g.query("CREATE (:Entity:User {id: 'u:scale', name: 'Scale User', timezone: 'UTC'})");
  await g.query("UNWIND ['a:planner','a:sentinel','a:executor','a:scout','a:mcp'] AS id CREATE (:Entity:Agent {id: id, name: id})");

  const P = Array.from({ length: people }, (_, i) => ({ id: `p:${i}`, name: `Person ${i}`, email: `person${i}@scale.example` }));
  await batched(g, P, "UNWIND $rows AS r CREATE (:Entity:Person {id: r.id, name: r.name, email: r.email})");
  const PR = Array.from({ length: projects }, (_, i) => ({ id: `pr:${i}`, name: `Project ${i}` }));
  await batched(g, PR, "UNWIND $rows AS r CREATE (:Entity:Project {id: r.id, name: r.name, status: 'active'})");
  const sens = ["public", "internal", "internal", "internal", "restricted"];
  const D = Array.from({ length: docs }, (_, i) => ({ id: `d:${i}`, title: `Document ${i}`, sensitivity: pick(sens), project: `pr:${i % projects}` }));
  await batched(g, D, "UNWIND $rows AS r CREATE (:Entity:Document {id: r.id, title: r.title, sensitivity: r.sensitivity})");
  await batched(g, D.map((d, i) => ({ id: `f:${i}`, text: `Fact ${i}`, markers: [`marker-${i}`], sensitivity: d.sensitivity, doc: d.id })),
    "UNWIND $rows AS r CREATE (:Entity:Fact {id: r.id, text: r.text, markers: r.markers, sensitivity: r.sensitivity})");
  await batched(g, Array.from({ length: messages }, (_, i) => ({ id: `msg:${i}`, subject: `Message ${i}`, from: pick(P).id, mentions: pick(D).id })),
    "UNWIND $rows AS r CREATE (:Entity:Message {id: r.id, subject: r.subject, direction: 'inbound', status: 'received', ts: 0})");
  await batched(g, Array.from({ length: meetings }, (_, i) => ({ id: `m:${i}`, title: `Meeting ${i}` })),
    "UNWIND $rows AS r CREATE (:Entity:Meeting {id: r.id, title: r.title, start: 0, end: 1, status: 'confirmed'})");

  const edge = (rows: { a: string; b: string }[], type: string) =>
    batched(g, rows, `UNWIND $rows AS r MATCH (x:Entity {id: r.a}), (y:Entity {id: r.b}) CREATE (x)-[:${type}]->(y)`);
  await edge(P.filter((_, i) => i % 5 === 0).map((p) => ({ a: "u:scale", b: p.id })), "KNOWS");
  await g.query("MATCH (:User)-[k:KNOWS]->() SET k.count = 3, k.last_contact = 0");
  const memberships = P.flatMap((p) => [{ a: p.id, b: pick(PR).id }, { a: p.id, b: pick(PR).id }]);
  await edge(memberships, "MEMBER_OF");
  await edge(D.map((d) => ({ a: d.id, b: d.project })), "BELONGS_TO");
  await edge(D.map((d, i) => ({ a: d.id, b: `f:${i}` })), "CONTAINS");
  await edge(D.filter((_, i) => i % 5 === 0).map((d) => ({ a: d.id, b: pick(P).id })), "SHARED_WITH");
  await edge(Array.from({ length: messages }, (_, i) => ({ a: `msg:${i}`, b: pick(P).id })), "FROM");
  await edge(Array.from({ length: messages }, (_, i) => ({ a: `msg:${i}`, b: pick(D).id })), "MENTIONS");
  await edge(Array.from({ length: meetings }, (_, i) => ({ a: `m:${i}`, b: pick(P).id })), "WITH");

  const nodes = (await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c")).data![0]!.c;
  const edges = (await g.roQuery<{ c: number }>("MATCH ()-[e]->() RETURN count(e) AS c")).data![0]!.c;
  return { nodes, edges, P, D, memberships };
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

export async function runScale(people = 5000, samples = 200) {
  const g = graphFor("scale_bench");
  const t0 = Date.now();
  const { nodes, edges, P, D, memberships } = await buildScaleGraph(g, people);
  const projectsOf = new Map<string, string[]>();
  for (const m of memberships) projectsOf.set(m.a, [...(projectsOf.get(m.a) ?? []), m.b]);
  const docsOf = new Map<string, string[]>();
  for (const d of D) if (d.sensitivity !== "restricted") docsOf.set(d.project, [...(docsOf.get(d.project) ?? []), d.id]);
  const buildSeconds = Math.round((Date.now() - t0) / 100) / 10;
  const r = rng(7);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;

  const checks: number[] = [];
  const verdicts: Record<string, number> = {};
  for (let i = 0; i < samples; i++) {
    // Half legitimate (a non-restricted doc from a project the person is on, a known contact),
    // half random (usually a leak), so the timings cover ALLOW / ASK / BLOCK paths alike.
    const person = i % 2 === 0 ? P[(Math.floor(r() * (P.length / 5))) * 5]! : pick(P);
    const own = (projectsOf.get(person.id) ?? []).flatMap((pr) => docsOf.get(pr) ?? []);
    const doc = i % 2 === 0 && own.length ? pick(own) : pick(D).id;
    const action = { type: "send_email" as const, to: person.email, docs: [doc], body: i % 2 === 0 ? "here you go" : `see marker-${Math.floor(r() * D.length)}`, derivedFrom: "user" };
    const s = performance.now();
    const v = await check(g, action);
    checks.push(performance.now() - s);
    verdicts[v.verdict] = (verdicts[v.verdict] ?? 0) + 1;
  }
  const retrievals: number[] = [];
  for (let i = 0; i < Math.min(samples, 100); i++) {
    const s = performance.now();
    await retrieve(g, `Send ${pick(P).name} the ${pick(D).title}`);
    retrievals.push(performance.now() - s);
  }
  await g.delete();
  const fmt = (xs: number[]) => ({ p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), max: Math.round(Math.max(...xs)) });
  return { ranAt: new Date().toISOString(), nodes, edges, buildSeconds, samples, sentinel: fmt(checks), retrieval: fmt(retrievals), verdicts };
}

if (import.meta.main) {
  const r = await runScale(N("--people", 5000), N("--samples", 200));
  const md = [
    "# Scale: Steward's graph queries on a ~50k-node user graph",
    "",
    `Run at ${r.ranAt} on local Docker (FalkorDB, Windows host). Synthetic user graph: **${r.nodes.toLocaleString()} nodes,`,
    `${r.edges.toLocaleString()} edges** (people, projects, documents with facts, inbound mail, meetings), built in ${r.buildSeconds}s.`,
    "",
    "| Operation (per call) | p50 | p95 | max | samples |",
    "|---|---|---|---|---|",
    `| **Sentinel: all 8 checks for one proposed action** | **${r.sentinel.p50} ms** | ${r.sentinel.p95} ms | ${r.sentinel.max} ms | ${r.samples} |`,
    `| Planner retrieval (full-text entry points + multi-hop expansion + facts) | ${r.retrieval.p50} ms | ${r.retrieval.p95} ms | ${r.retrieval.max} ms | ${Math.min(r.samples, 100)} |`,
    "",
    `Verdict mix on random actions: ${Object.entries(r.verdicts).map(([k, v]) => `${k} ${v}`).join(" · ")}.`,
    "",
    "Times include the client round trips (each check is several Cypher queries, run one after another).",
    "",
  ].join("\n");
  await Bun.write(new URL("../../../../eval/SCALE.md", import.meta.url), md);
  console.log(md);
  process.exit(0);
}
