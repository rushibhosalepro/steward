import type { Graph } from "falkordb";
import { appendAudit, isPaused } from "../audit/audit";
import { check, type ProposedAction } from "../sentinel/sentinel";

// The Executor runs actions the Sentinel allowed (ready) or the user approved (approved).
// The sandboxed tools are graph writes: the outbox is outbound Message nodes, the calendar
// is Meeting nodes, the task list is Task nodes. Nothing leaves the graph.

export type ExecResult =
  | { ok: true; id: string; status: "done"; produced: string; fulfilled: string[] }
  | { ok: false; id: string; status: string; error: string };

type ActionProps = ProposedAction & { status: string; id: string };

// Claim atomically so two executors can't run the same action: status moves to "executing"
// in the same query that checks it, and the claim is a CLAIMED_BY edge.
async function claim(g: Graph, id: string) {
  const res = await g.query<{ a: { properties: ActionProps }; source: string | null }>(
    `MATCH (a:Action {id: $id}) WHERE a.status IN ['ready', 'approved']
     SET a.claimed_from = a.status, a.status = 'executing'
     WITH a MATCH (x:Agent {id: 'a:executor'}) CREATE (a)-[:CLAIMED_BY]->(x)
     WITH a OPTIONAL MATCH (a)-[:DERIVED_FROM]->(s)
     RETURN a, s.id AS source`,
    { params: { id } },
  );
  const row = res.data?.[0];
  return row ? { props: row.a.properties as ActionProps & { claimed_from: string }, source: row.source } : null;
}

async function setStatus(g: Graph, id: string, status: string, reason: string) {
  await g.query("MATCH (a:Action {id: $id}) SET a.status = $status, a.reason = $reason", { params: { id, status, reason } });
}

async function perform(g: Graph, a: ActionProps, ts: number): Promise<string> {
  const produced = `${a.type === "create_event" ? "mtg" : a.type === "create_task" ? "task" : "msg"}:${crypto.randomUUID()}`;
  const params = { id: a.id, produced, ts };

  if (a.type === "send_email" || a.type === "share_doc") {
    // Sending makes the recipient a contact (or strengthens the tie): knowledge stays current.
    await g.query(
      `MATCH (a:Action {id: $id}), (u:User)
       MERGE (p:Entity:Person {email: $to}) ON CREATE SET p.id = $pid, p.name = $to
       MERGE (u)-[k:KNOWS]->(p) ON CREATE SET k.count = 0
       SET k.count = k.count + 1, k.last_contact = $ts
       CREATE (m:Entity:Message {id: $produced, direction: 'outbound', subject: $subject, body: $body, ts: $ts, status: 'sent'})-[:TO]->(p)
       CREATE (a)-[:PRODUCED]->(m)`,
      { params: { ...params, to: a.to!, pid: `p:${crypto.randomUUID()}`, subject: a.subject ?? (a.type === "share_doc" ? "Shared with you" : ""), body: a.body ?? "" } },
    );
    if (a.docs?.length) {
      // Once a document has gone to someone, that's a fact in the graph.
      await g.query(
        `MATCH (m:Message {id: $produced})-[:TO]->(p:Person)
         UNWIND $docs AS doc MATCH (d:Document {id: doc})
         CREATE (m)-[:ATTACHES]->(d)
         MERGE (d)-[:SHARED_WITH]->(p)`,
        { params: { produced, docs: a.docs } },
      );
    }
    return produced;
  }

  if (a.type === "create_event") {
    await g.query(
      `MATCH (a:Action {id: $id})
       CREATE (m:Entity:Meeting {id: $produced, title: $title, start: $start, end: $end, status: 'confirmed'})
       CREATE (a)-[:PRODUCED]->(m)`,
      { params: { ...params, title: a.title ?? "Meeting", start: a.start!, end: a.end! } },
    );
    if (a.to) {
      await g.query("MATCH (m:Meeting {id: $produced}), (p:Person {email: $to}) CREATE (m)-[:WITH]->(p)", { params: { produced, to: a.to } });
    }
    return produced;
  }

  await g.query(
    `MATCH (a:Action {id: $id})
     CREATE (t:Entity:Task {id: $produced, title: $title, status: 'open'})
     SET t.due = $due
     CREATE (a)-[:PRODUCED]->(t)`,
    { params: { ...params, title: a.title ?? "Untitled task", due: a.due ?? null } },
  );
  return produced;
}

// An open commitment to this person about one of the documents just sent is now kept.
async function fulfilCommitments(g: Graph, a: ActionProps, ts: number) {
  if (!a.to || !a.docs?.length) return [];
  const res = await g.query<{ what: string }>(
    `MATCH (a:Action {id: $id})-[:USES]->(:Document)<-[:ABOUT]-(c:Commitment {status: 'open'})-[:TO]->(:Person {email: $to})
     SET c.status = 'fulfilled', c.fulfilled_at = $ts
     CREATE (a)-[:FULFILS]->(c)
     RETURN c.what AS what`,
    { params: { id: a.id, to: a.to, ts } },
  );
  return (res.data ?? []).map((r) => r.what);
}

// EVALUATION BASELINE ONLY: what an agent's tools would do with no Sentinel in front of them.
// Used by the "without Steward" condition of the external-agent benchmark, through an MCP
// endpoint that exists only when STEWARD_ALLOW_UNGUARDED=1 (never set in production).
export async function performUnguarded(g: Graph, action: ProposedAction) {
  const id = `act:${crypto.randomUUID()}`;
  const props = Object.fromEntries(Object.entries({
    type: action.type, to: action.to, docs: action.docs, subject: action.subject, body: action.body,
    title: action.title, start: action.start, end: action.end, due: action.due,
    status: "done", verdict: "UNGUARDED", created_at: Date.now(),
  }).filter(([, v]) => v !== undefined && v !== null));
  await g.query("CREATE (a:Entity:Action) SET a = $props, a.id = $id", { params: { props: props as never, id } });
  const a = { ...action, id, status: "done" } as ActionProps;
  const produced = await perform(g, a, Date.now());
  await fulfilCommitments(g, a, Date.now());
  return { id, produced };
}

export async function executeAction(g: Graph, id: string): Promise<ExecResult> {
  if (await isPaused(g)) return { ok: false, id, status: "paused", error: "Steward is paused by the user; nothing runs until they resume" };
  const claimed = await claim(g, id);
  if (!claimed) {
    const r = await g.roQuery<{ status: string }>("MATCH (a:Action {id: $id}) RETURN a.status AS status", { params: { id } });
    const status = r.data?.[0]?.status;
    return { ok: false, id, status: status ?? "missing", error: status ? `action is ${status}, not ready or approved` : "no such action" };
  }
  const a = claimed.props;

  // Re-check against the graph as it is now: it may have changed since the verdict.
  const recheck = await check(g, { ...a, derivedFrom: claimed.source ?? "unknown", selfId: a.id, selfCreatedAt: (a as { created_at?: number }).created_at });
  if (recheck.verdict === "BLOCK") {
    await setStatus(g, id, "blocked", `graph changed since the verdict: ${recheck.reason}`);
    await appendAudit(g, "execution", id, { status: "blocked", reason: recheck.reason });
    return { ok: false, id, status: "blocked", error: recheck.reason };
  }
  if (recheck.verdict === "ASK" && a.claimed_from === "ready") {
    await setStatus(g, id, "pending", `needs approval now: ${recheck.reason}`);
    await appendAudit(g, "execution", id, { status: "pending", reason: recheck.reason });
    return { ok: false, id, status: "pending", error: recheck.reason };
  }

  const ts = Date.now();
  try {
    const produced = await perform(g, a, ts);
    const fulfilled = await fulfilCommitments(g, a, ts);
    await g.query(
      `MATCH (a:Action {id: $id}), (x:Agent {id: 'a:executor'})
       SET a.status = 'done', a.done_at = $ts
       CREATE (x)-[:EXECUTED]->(a)`,
      { params: { id, ts } },
    );
    await appendAudit(g, "execution", id, { status: "done", produced, fulfilled });
    return { ok: true, id, status: "done", produced, fulfilled };
  } catch (err) {
    await setStatus(g, id, "failed", String(err));
    await appendAudit(g, "execution", id, { status: "failed", error: String(err) });
    return { ok: false, id, status: "failed", error: String(err) };
  }
}

// One executor pass: run everything that's ready or approved, oldest first.
export async function runExecutor(g: Graph) {
  const res = await g.roQuery<{ id: string }>(
    "MATCH (a:Action) WHERE a.status IN ['ready', 'approved'] RETURN a.id AS id ORDER BY a.created_at",
  );
  const results: ExecResult[] = [];
  for (const { id } of res.data ?? []) results.push(await executeAction(g, id));
  return results;
}

// Views over the sandboxed tools' state.
export async function outbox(g: Graph) {
  const res = await g.roQuery(
    `MATCH (m:Message {direction: 'outbound'})-[:TO]->(p:Person)
     OPTIONAL MATCH (m)-[:ATTACHES]->(d:Document)
     RETURN m.id AS id, m.subject AS subject, m.body AS body, p.name AS to, p.email AS email,
            collect(d.title) AS attachments, m.ts AS ts
     ORDER BY ts DESC`,
  );
  return res.data ?? [];
}

export async function calendarView(g: Graph) {
  const res = await g.roQuery(
    `MATCH (m:Meeting)
     OPTIONAL MATCH (m)-[:WITH]->(p:Person)
     OPTIONAL MATCH (m)-[:ABOUT]->(pr:Project)
     RETURN m.id AS id, m.title AS title, m.start AS start, m.end AS end, m.status AS status,
            collect(DISTINCT p.name) AS with, pr.name AS project
     ORDER BY start`,
  );
  return res.data ?? [];
}

export async function tasksView(g: Graph) {
  const res = await g.roQuery(
    `MATCH (t:Task)
     OPTIONAL MATCH (b:Task)-[:BLOCKS]->(t)
     OPTIONAL MATCH (t)-[:FOR]->(pr:Project)
     RETURN t.id AS id, t.title AS title, t.due AS due, t.status AS status,
            collect(DISTINCT b.title) AS blockedBy, pr.name AS project
     ORDER BY due`,
  );
  return res.data ?? [];
}
