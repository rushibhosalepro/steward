import type { Graph } from "falkordb";

// The Sentinel decides whether a proposed action may run. It is deterministic: every
// verdict comes from Cypher over the user's graph plus the fixed policy below. The LLM
// only ever proposes actions; it never calls this module's verdict logic directly.

export type ActionType = "send_email" | "share_doc" | "create_event" | "create_task";

export type ProposedAction = {
  type: ActionType;
  to?: string;            // recipient / invitee email
  docs?: string[];        // Document ids attached or shared
  start?: number;         // create_event, epoch ms
  end?: number;
  derivedFrom: string;    // "user" (typed by the user) or the id of the Message that prompted it
  subject?: string;       // send_email
  body?: string;
  title?: string;         // create_event / create_task
  due?: number;           // create_task
  request?: string;       // the user's words, when derivedFrom is "user"
};

export type Status = "pass" | "ask" | "block" | "skip";
export type Verdict = "ALLOW" | "ASK" | "BLOCK";

export type CheckResult = {
  check: "known_recipient" | "information_flow" | "provenance" | "calendar" | "standing_rule";
  status: Status;
  reason: string;
  evidence: string[];     // human-readable graph paths
  cypher: string[];       // the queries that produced the evidence
  refs?: string[];        // ids of the graph entities the verdict rests on (become JUSTIFIED_BY edges)
};

export type SentinelResult = { verdict: Verdict; reason: string; checks: CheckResult[] };

// Policy: actions with an outside recipient.
const OUTBOUND: ActionType[] = ["send_email", "share_doc"];

const Q = {
  recipient: `MATCH (p:Person {email: $email})
OPTIONAL MATCH (:User)-[k:KNOWS]->(p)
RETURN p.id AS id, p.name AS name, k.count AS count`,

  docFlow: `MATCH (d:Document {id: $doc})
OPTIONAL MATCH (d)-[:SHARED_WITH]->(s:Person {email: $email})
OPTIONAL MATCH (d)-[:BELONGS_TO]->(pr:Project)<-[:MEMBER_OF]-(m:Person {email: $email})
OPTIONAL MATCH (newer:Document)-[:SUPERSEDES]->(d)
RETURN d.title AS title, d.sensitivity AS sensitivity, s.name AS sharedWith,
       pr.id AS projectId, pr.name AS project, m.name AS member, newer.title AS newer`,

  provenance: `MATCH (src:Entity {id: $id})
OPTIONAL MATCH (src)-[:FROM]->(sender:Person)
OPTIONAL MATCH (u:User)-[:KNOWS]->(sender)
RETURN 'Request' IN labels(src) AS isRequest, src.text AS text, src.subject AS subject,
       sender.name AS sender, sender.email AS senderEmail, count(u) > 0 AS known`,

  preference: `MATCH (:User)-[:PREFERS]->(p:Preference {key: 'no_meetings_before'})
MATCH (u:User) RETURN p.value AS value, u.timezone AS tz`,

  overlap: `MATCH (m:Meeting {status: 'confirmed'}) WHERE m.start < $end AND m.end > $start
RETURN m.id AS id, m.title AS title`,

  rule: `MATCH (r:Rule {active: true, action_type: $type})-[:SCOPED_TO]->(p:Person {email: $email})
RETURN r.id AS id, coalesce(r.description, r.id) AS description, p.name AS name`,
};

async function knownRecipient(g: Graph, a: ProposedAction): Promise<CheckResult> {
  const base = { check: "known_recipient" as const, cypher: [Q.recipient] };
  if (!a.to) return { ...base, status: "skip", reason: "no recipient", evidence: [] };

  const res = await g.roQuery<{ id: string; name: string; count: number | null }>(Q.recipient, { params: { email: a.to } });
  const row = res.data?.[0];
  if (!row) return { ...base, status: "ask", reason: `${a.to} is not in your graph at all`, evidence: [] };
  if (!row.count) return { ...base, status: "ask", reason: `You have never been in contact with ${row.name}`, evidence: [`${row.name} has no KNOWS edge from you`], refs: [row.id] };
  return { ...base, status: "pass", reason: `You know ${row.name}`, evidence: [`You -KNOWS {${row.count} contacts}-> ${row.name}`], refs: [row.id] };
}

async function informationFlow(g: Graph, a: ProposedAction): Promise<CheckResult> {
  const base = { check: "information_flow" as const, cypher: [Q.docFlow] };
  if (!a.docs?.length) return { ...base, status: "skip", reason: "no documents involved", evidence: [] };
  if (!a.to) return { ...base, status: "block", reason: "documents with no recipient", evidence: [] };

  let status: Status = "pass";
  const reasons: string[] = [];
  const evidence: string[] = [];
  const refs: string[] = [];

  for (const doc of a.docs) {
    const res = await g.roQuery<{
      title: string; sensitivity: string; sharedWith: string | null;
      projectId: string | null; project: string | null; member: string | null; newer: string | null;
    }>(Q.docFlow, { params: { doc, email: a.to } });
    const rows = res.data ?? [];
    if (!rows.length) {
      status = "block";
      reasons.push(`document ${doc} does not exist`);
      continue;
    }
    const d = rows[0]!;
    refs.push(doc);
    const shared = rows.find((r) => r.sharedWith);
    const viaProject = rows.find((r) => r.member);

    if (shared) {
      evidence.push(`${d.title} -SHARED_WITH-> ${shared.sharedWith}`);
    } else if (d.sensitivity === "restricted") {
      status = "block";
      reasons.push(`"${d.title}" is restricted and not shared with ${a.to}`);
    } else if (viaProject) {
      evidence.push(`${d.title} -BELONGS_TO-> ${viaProject.project} <-MEMBER_OF- ${viaProject.member}`);
      refs.push(viaProject.projectId!);
    } else if (d.sensitivity === "public") {
      evidence.push(`${d.title} is public`);
    } else {
      status = "block";
      reasons.push(`no path from "${d.title}" to ${a.to}: they are not on its project`);
    }

    if (d.newer) {
      if (status === "pass") status = "ask";
      reasons.push(`"${d.title}" is superseded by "${d.newer}"`);
    }
  }

  const reason = reasons.length ? reasons.join("; ") : "every document reaches the recipient through the graph";
  return { ...base, status, reason, evidence, refs };
}

async function provenance(g: Graph, a: ProposedAction): Promise<CheckResult> {
  const base = { check: "provenance" as const, cypher: [Q.provenance] };
  if (a.derivedFrom === "user") return { ...base, status: "pass", reason: "you asked for this directly", evidence: ["Request typed by you"] };

  const res = await g.roQuery<{
    isRequest: boolean; text: string | null; subject: string | null;
    sender: string | null; senderEmail: string | null; known: boolean;
  }>(
    Q.provenance, { params: { id: a.derivedFrom } },
  );
  const row = res.data?.[0];
  if (!row) return { ...base, status: "ask", reason: `unknown source ${a.derivedFrom}`, evidence: [] };
  const refs = [a.derivedFrom];
  if (row.isRequest) {
    return { ...base, status: "pass", reason: "you asked for this directly", evidence: [`Action -DERIVED_FROM-> Request "${row.text}"`], refs };
  }
  if (!row.sender) return { ...base, status: "ask", reason: `source ${a.derivedFrom} has no known sender`, evidence: [], refs };
  const path = `Action -DERIVED_FROM-> "${row.subject}" -FROM-> ${row.sender}`;

  if (!row.known && OUTBOUND.includes(a.type)) {
    return { ...base, status: "block", reason: `requested by ${row.sender} (${row.senderEmail}), who you don't know: possible injected request`, evidence: [path], refs };
  }
  if (!row.known) return { ...base, status: "ask", reason: `requested by ${row.sender}, who you don't know`, evidence: [path], refs };
  return { ...base, status: "pass", reason: `requested by ${row.sender}, who you know`, evidence: [path], refs };
}

function localHourMinute(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  return parts; // "HH:MM"
}

async function calendar(g: Graph, a: ProposedAction): Promise<CheckResult> {
  const base = { check: "calendar" as const, cypher: [Q.preference, Q.overlap] };
  if (a.type !== "create_event") return { ...base, status: "skip", reason: "not a calendar action", evidence: [] };
  if (a.start == null || a.end == null) return { ...base, status: "ask", reason: "event has no time", evidence: [] };

  const reasons: string[] = [];
  const evidence: string[] = [];

  const pref = (await g.roQuery<{ value: string; tz: string }>(Q.preference)).data?.[0];
  if (pref) {
    const at = localHourMinute(a.start, pref.tz);
    if (at < pref.value) {
      reasons.push(`starts at ${at}, you prefer no meetings before ${pref.value}`);
      evidence.push(`You -PREFERS-> no_meetings_before ${pref.value}`);
    }
  }
  const clashes = (await g.roQuery<{ id: string; title: string }>(Q.overlap, { params: { start: a.start, end: a.end } })).data ?? [];
  for (const c of clashes) {
    reasons.push(`overlaps "${c.title}"`);
    evidence.push(`overlaps Meeting "${c.title}"`);
  }

  return reasons.length
    ? { ...base, status: "ask", reason: reasons.join("; "), evidence, refs: clashes.map((c) => c.id) }
    : { ...base, status: "pass", reason: "fits your calendar and preferences", evidence };
}

async function standingRule(g: Graph, a: ProposedAction): Promise<CheckResult> {
  const base = { check: "standing_rule" as const, cypher: [Q.rule] };
  if (a.type === "create_task") return { ...base, status: "pass", reason: "tasks only touch your own list", evidence: [] };
  if (a.type === "create_event" && !a.to) return { ...base, status: "pass", reason: "an event with no invitee only touches your own calendar", evidence: [] };
  if (!a.to) return { ...base, status: "ask", reason: "no standing rule applies", evidence: [] };

  const res = await g.roQuery<{ id: string; description: string; name: string }>(Q.rule, { params: { type: a.type, email: a.to } });
  const row = res.data?.[0];
  if (!row) return { ...base, status: "ask", reason: `no standing rule for ${a.type} to ${a.to} yet`, evidence: [] };
  return { ...base, status: "pass", reason: `your rule "${row.description}" allows it`, evidence: [`Rule "${row.description}" -SCOPED_TO-> ${row.name}`], refs: [row.id] };
}

// Email addresses are case-insensitive; the graph stores them lower-cased.
export function normalise(a: ProposedAction): ProposedAction {
  return a.to ? { ...a, to: a.to.trim().toLowerCase() } : a;
}

export async function check(g: Graph, action: ProposedAction): Promise<SentinelResult> {
  const a = normalise(action);
  const checks = [
    await knownRecipient(g, a),
    await informationFlow(g, a),
    await provenance(g, a),
    await calendar(g, a),
    await standingRule(g, a),
  ];

  const blocked = checks.filter((c) => c.status === "block");
  if (blocked.length) return { verdict: "BLOCK", reason: blocked.map((c) => c.reason).join("; "), checks };

  const asks = checks.filter((c) => c.status === "ask");
  if (asks.length) return { verdict: "ASK", reason: asks.map((c) => c.reason).join("; "), checks };

  return { verdict: "ALLOW", reason: "every check passed", checks };
}
