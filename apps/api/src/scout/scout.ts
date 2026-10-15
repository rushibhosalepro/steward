import type { Graph } from "falkordb";

// Scout: the proactive agent. It never acts. It runs graph queries for things the user
// would want to know about, ranks them by urgency and by how central the people and projects
// involved are (PageRank over the user's graph), and stores them as Suggestion nodes. A
// suggestion either carries a ready request (which goes through Planner -> Sentinel like any
// other) or is information only.

const HOUR = 3_600_000;
const SOON = 48 * HOUR;

export type Kind = "commitment_due" | "commitment_proposed" | "awaiting_reply" | "blocked_task" | "meeting_prep" | "flagged_mail";

type Candidate = {
  key: string;
  kind: Kind;
  text: string;
  request: string | null;
  refs: string[];
  due: number | null;
  focus: string | null; // the person or project whose centrality ranks this
};

const BASE: Record<Kind, number> = {
  flagged_mail: 60, commitment_due: 50, meeting_prep: 40, blocked_task: 35, commitment_proposed: 30, awaiting_reply: 20,
};

const when = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(ms);

// Centrality over the whole user graph: who and what everything else hangs off.
async function centrality(g: Graph) {
  const res = await g.roQuery<{ id: string; label: string; score: number }>(
    `CALL algo.pageRank('Entity', null) YIELD node, score
     WITH node, score WHERE node:Person OR node:Project
     RETURN node.id AS id, [l IN labels(node) WHERE l <> 'Entity'][0] AS label, score`,
  );
  const rows = res.data ?? [];
  const ranked = (label: string) => rows.filter((r) => r.label === label).sort((a, b) => b.score - a.score);
  const people = ranked("Person");
  const projects = ranked("Project");
  return {
    score: new Map(rows.map((r) => [r.id, r.score])),
    rank: new Map([...people.map((p, i) => [p.id, `#${i + 1} of ${people.length} people`] as const),
                   ...projects.map((p, i) => [p.id, `#${i + 1} of ${projects.length} projects`] as const)]),
  };
}

async function candidates(g: Graph, now: number, tz: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const q = async <T>(cypher: string, params: Record<string, unknown> = {}) =>
    (await g.roQuery<T>(cypher, { params: params as never })).data ?? [];

  for (const c of await q<{ id: string; what: string; by: number | null; pid: string; who: string; about: string[] }>(
    `MATCH (c:Commitment {status: 'open'})-[:TO]->(p:Person)
     OPTIONAL MATCH (c)-[:ABOUT]->(a)
     RETURN c.id AS id, c.what AS what, c.by_when AS by, p.id AS pid, p.name AS who, collect(a.id) AS about`,
  )) {
    if (c.by != null && c.by - now > SOON) continue;
    out.push({
      key: `commitment_due:${c.id}`, kind: "commitment_due",
      text: `You promised ${c.who}: “${c.what}”${c.by ? ` (by ${when(c.by, tz)})` : ""}.`,
      request: c.what, refs: [c.id, c.pid, ...c.about], due: c.by, focus: c.pid,
    });
  }

  for (const c of await q<{ id: string; what: string; pid: string; who: string }>(
    `MATCH (c:Commitment {status: 'proposed'})-[:TO]->(p:Person)
     RETURN c.id AS id, c.what AS what, p.id AS pid, p.name AS who`,
  )) {
    out.push({
      key: `commitment_proposed:${c.id}`, kind: "commitment_proposed",
      text: `${c.who} asked for something. Take it on? “${c.what.replace(/^[^:]+:\s*/, "")}”`,
      request: null, refs: [c.id, c.pid], due: null, focus: c.pid,
    });
  }

  // Waiting for a reply: a known contact's latest inbound mail, nothing sent to them since,
  // and no open or proposed commitment already covering them. Two plain queries, joined here.
  const inbound = await q<{ id: string; subject: string; ts: number; pid: string; who: string }>(
    `MATCH (u:User)-[:KNOWS]->(p:Person)<-[:FROM]-(m:Message {direction: 'inbound'})
     WHERE coalesce(m.flagged, false) = false
     RETURN m.id AS id, m.subject AS subject, m.ts AS ts, p.id AS pid, p.name AS who`,
  );
  const lastSent = new Map(
    (await q<{ pid: string; ts: number }>(
      "MATCH (m:Message {direction: 'outbound'})-[:TO]->(p:Person) RETURN p.id AS pid, max(m.ts) AS ts",
    )).map((r) => [r.pid, r.ts]),
  );
  const covered = new Set(
    (await q<{ pid: string }>("MATCH (c:Commitment)-[:TO]->(p:Person) WHERE c.status IN ['open', 'proposed'] RETURN DISTINCT p.id AS pid")).map((r) => r.pid),
  );
  const latest = new Map<string, (typeof inbound)[number]>();
  for (const m of inbound) if (!latest.has(m.pid) || latest.get(m.pid)!.ts < m.ts) latest.set(m.pid, m);
  for (const m of latest.values()) {
    if ((lastSent.get(m.pid) ?? 0) > m.ts || covered.has(m.pid)) continue;
    out.push({
      key: `awaiting_reply:${m.id}`, kind: "awaiting_reply",
      text: `${m.who} is waiting for a reply to “${m.subject}”.`,
      request: null, refs: [m.id, m.pid], due: null, focus: m.pid,
    });
  }

  for (const t of await q<{ id: string; title: string; due: number | null; bid: string; blocker: string; pr: string | null }>(
    `MATCH (b:Task {status: 'open'})-[:BLOCKS]->(t:Task {status: 'open'})
     OPTIONAL MATCH (t)-[:FOR]->(pr:Project)
     RETURN t.id AS id, t.title AS title, t.due AS due, b.id AS bid, b.title AS blocker, pr.id AS pr`,
  )) {
    if (t.due != null && t.due - now > SOON) continue;
    out.push({
      key: `blocked_task:${t.id}`, kind: "blocked_task",
      text: `“${t.title}”${t.due ? ` (due ${when(t.due, tz)})` : ""} is blocked by “${t.blocker}”.`,
      request: null, refs: [t.id, t.bid], due: t.due, focus: t.pr,
    });
  }

  const prepped = new Set(
    (await q<{ title: string }>("MATCH (t:Task) WHERE t.title STARTS WITH 'Prepare for ' RETURN t.title AS title")).map((r) => r.title),
  );
  for (const m of await q<{ id: string; title: string; start: number; who: string | null; pid: string | null }>(
    `MATCH (m:Meeting {status: 'confirmed'}) WHERE m.start > $now AND m.start < $soon
     OPTIONAL MATCH (m)-[:WITH]->(p:Person)
     RETURN m.id AS id, m.title AS title, m.start AS start, p.name AS who, p.id AS pid`,
    { now, soon: now + SOON },
  )) {
    if (prepped.has(`Prepare for ${m.title}`)) continue;
    out.push({
      key: `meeting_prep:${m.id}`, kind: "meeting_prep",
      text: `No prep yet for “${m.title}” (${when(m.start, tz)}).`,
      request: m.who ? `Prepare for the meeting with ${m.who.split(" ")[0]}` : null,
      refs: [m.id, ...(m.pid ? [m.pid] : [])], due: m.start, focus: m.pid,
    });
  }

  for (const m of await q<{ id: string; subject: string; who: string; pid: string; body: string }>(
    `MATCH (m:Message {direction: 'inbound', flagged: true})-[:FROM]->(p:Person)
     RETURN m.id AS id, m.subject AS subject, m.body AS body, p.name AS who, p.id AS pid`,
  )) {
    out.push({
      key: `flagged_mail:${m.id}`, kind: "flagged_mail",
      text: `⚠ ${m.who}, who you don't know, is asking for something: “${m.subject}”. Steward will block any send it prompts.`,
      request: null, refs: [m.id, m.pid], due: null, focus: null,
    });
  }

  return out;
}

export async function runScout(g: Graph, now = Date.now()) {
  const tz = (await g.roQuery<{ tz: string }>("MATCH (u:User) RETURN u.timezone AS tz")).data?.[0]?.tz ?? "UTC";
  const rank = await centrality(g);
  const found = await candidates(g, now, tz);

  const scored = found.map((c) => {
    const pr = c.focus ? rank.score.get(c.focus) ?? 0 : 0;
    const urgency = c.due != null ? Math.max(0, 24 - Math.max(0, c.due - now) / HOUR) : 0; // up to +24 in the last day
    const focusRank = c.focus ? rank.rank.get(c.focus) : undefined;
    const why = [
      c.due != null ? `due ${when(c.due, tz)}` : null,
      focusRank ? `${focusRank} by centrality in your graph` : null,
    ].filter(Boolean).join(" · ");
    return { ...c, score: Math.round((BASE[c.kind] + urgency + 200 * pr) * 10) / 10, why };
  });

  // Upsert by key: a dismissed or done suggestion stays that way; anything open that no longer
  // applies (the commitment was kept, the reply was sent) is resolved.
  for (const s of scored) {
    await g.query(
      `MERGE (s:Entity:Suggestion {key: $key})
       ON CREATE SET s.id = $id, s.status = 'open', s.created_at = $now
       SET s.kind = $kind, s.text = $text, s.request = $request, s.score = $score, s.why = $why, s.seen_at = $now
       WITH s MATCH (a:Agent {id: 'a:scout'}) MERGE (a)-[:SUGGESTED]->(s)
       WITH s UNWIND $refs AS rid MATCH (e:Entity {id: rid}) MERGE (s)-[:BECAUSE_OF]->(e)`,
      { params: { key: s.key, id: `sug:${crypto.randomUUID()}`, now, kind: s.kind, text: s.text, request: s.request, score: s.score, why: s.why, refs: s.refs } },
    );
  }
  await g.query(
    "MATCH (s:Suggestion {status: 'open'}) WHERE NOT s.key IN $keys SET s.status = 'resolved', s.resolved_at = $now",
    { params: { keys: scored.map((s) => s.key), now } },
  );
  return listSuggestions(g);
}

export type Suggestion = { id: string; kind: Kind; text: string; request: string | null; score: number; why: string; status: string; refs: string[] };

export async function listSuggestions(g: Graph) {
  const res = await g.roQuery<Suggestion>(
    `MATCH (s:Suggestion {status: 'open'})
     OPTIONAL MATCH (s)-[:BECAUSE_OF]->(e)
     RETURN s.id AS id, s.kind AS kind, s.text AS text, s.request AS request, s.score AS score, s.why AS why,
            s.status AS status, collect(e.id) AS refs
     ORDER BY score DESC`,
  );
  return res.data ?? [];
}

// Dismiss any suggestion; for a proposed commitment, accept or decline it.
export async function decideSuggestion(g: Graph, id: string, decision: "dismiss" | "accept" | "decline") {
  const s = (await g.roQuery<{ kind: Kind; key: string }>("MATCH (s:Suggestion {id: $id, status: 'open'}) RETURN s.kind AS kind, s.key AS key", { params: { id } })).data?.[0];
  if (!s) return { ok: false as const, error: "no open suggestion with that id" };
  if (decision !== "dismiss" && s.kind !== "commitment_proposed") return { ok: false as const, error: `can only ${decision} a proposed commitment` };

  if (decision !== "dismiss") {
    await g.query(
      "MATCH (:Suggestion {id: $id})-[:BECAUSE_OF]->(c:Commitment {status: 'proposed'}) SET c.status = $status, c.decided_at = $now",
      { params: { id, status: decision === "accept" ? "open" : "declined", now: Date.now() } },
    );
  }
  await g.query("MATCH (s:Suggestion {id: $id}) SET s.status = $status, s.decided_at = $now", {
    params: { id, status: decision === "dismiss" ? "dismissed" : "done", now: Date.now() },
  });
  return { ok: true as const };
}
