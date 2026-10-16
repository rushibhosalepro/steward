import type { Graph } from "falkordb";
import { worldOf } from "../contexts/contexts";

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
  selfId?: string;        // set when re-checking a stored action, so it doesn't count itself
  selfCreatedAt?: number; // ...and only counts actions created before it
};

export type Status = "pass" | "ask" | "block" | "skip";
export type Verdict = "ALLOW" | "ASK" | "BLOCK";

export type CheckResult = {
  check: "known_recipient" | "information_flow" | "content_flow" | "provenance" | "rule_of_two" | "calendar" | "standing_rule" | "volume";
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

  // Inbound mail that could taint this action: sent by the recipient, or mentioning the data
  // being sent. Both start from an index (Person.email, Entity.id), so the cost follows the
  // action, not the size of the inbox. Untrusted = a sender the user doesn't know, or flagged.
  untrustedFrom: `MATCH (s:Person {email: $to})<-[:FROM]-(m:Message {direction: 'inbound'})
OPTIONAL MATCH (u:User)-[:KNOWS]->(s)
RETURN m.id AS id, m.subject AS subject, s.name AS from, coalesce(m.flagged, false) AS flagged, count(u) AS known`,

  untrustedAbout: `MATCH (d:Entity)<-[:MENTIONS]-(m:Message {direction: 'inbound'})-[:FROM]->(s:Person)
WHERE d.id IN $ids
OPTIONAL MATCH (u:User)-[:KNOWS]->(s)
RETURN m.id AS id, m.subject AS subject, s.name AS from, coalesce(m.flagged, false) AS flagged, count(u) AS known`,

  sensitivity: `MATCH (d:Document) WHERE d.id IN $ids RETURN d.title AS title, d.sensitivity AS sensitivity`,

  facts: `MATCH (d:Document)-[:CONTAINS]->(f:Fact)
RETURN f.id AS id, f.text AS text, f.markers AS markers, d.id AS doc, d.title AS title`,

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
WHERE coalesce(r.expires_at, 9000000000000000) > $now
RETURN r.id AS id, coalesce(r.description, r.id) AS description, p.name AS name,
       coalesce(r.max_sensitivity, 'internal') AS scope`,

  outboundFromSource: `MATCH (a:Action)-[:DERIVED_FROM]->(:Entity {id: $src})
WHERE (a.type IN ['send_email', 'share_doc'] OR (a.type = 'create_event' AND a.to IS NOT NULL))
  AND a.id <> $self AND coalesce(a.created_at, 0) <= $before
RETURN count(a) AS c`,
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
      // Explanation only (the verdict above doesn't depend on it): which worlds the two are in.
      const pid = (await g.roQuery<{ id: string }>("MATCH (p:Person {email: $email}) RETURN p.id AS id", { params: { email: a.to } })).data?.[0]?.id;
      const worlds = await worldOf(g, [doc, ...(pid ? [pid] : [])]);
      if (worlds.get(doc)) {
        evidence.push(`${d.title} is in your "${worlds.get(doc)}" world; ${a.to} is ${pid && worlds.get(pid) ? `in your "${worlds.get(pid)}" world` : "in none of them"}`);
      }
    }

    if (d.newer) {
      if (status === "pass") status = "ask";
      reasons.push(`"${d.title}" is superseded by "${d.newer}"`);
    }
  }

  const reason = reasons.length ? reasons.join("; ") : "every document reaches the recipient through the graph";
  return { ...base, status, reason, evidence, refs };
}

// Ablation only (eval/ablation.ts): the same decision from per-document attributes alone, the way
// a label/ACL system would: an explicit share passes, a restricted label blocks, anything else
// goes to a known contact. No project path, no version chain.
async function attributeFlow(g: Graph, a: ProposedAction): Promise<CheckResult> {
  const base = { check: "information_flow" as const, cypher: [Q.docFlow] };
  if (!a.docs?.length) return { ...base, status: "skip", reason: "no documents involved", evidence: [] };
  if (!a.to) return { ...base, status: "block", reason: "documents with no recipient", evidence: [] };
  for (const doc of a.docs) {
    const rows = (await g.roQuery<{ title: string; sensitivity: string; sharedWith: string | null }>(Q.docFlow, { params: { doc, email: a.to } })).data ?? [];
    if (!rows.length) return { ...base, status: "block", reason: `document ${doc} does not exist`, evidence: [] };
    if (!rows.some((r) => r.sharedWith) && rows[0]!.sensitivity === "restricted") {
      return { ...base, status: "block", reason: `"${rows[0]!.title}" is restricted and not shared with ${a.to}`, evidence: [] };
    }
  }
  return { ...base, status: "pass", reason: "no restricted label in the way", evidence: [] };
}

// Leaks through the text, not the attachment: a hijacked planner can type the price into the
// email instead of attaching the pricing sheet. Every fact the text gives away is traced back
// to its document, and the same path check decides whether that document may reach the
// recipient. Anything someone else will read counts: subject, body, an invite's title.
const outgoingText = (a: ProposedAction) =>
  [a.subject, a.body, a.type === "create_event" ? a.title : undefined].filter(Boolean).join("\n").toLowerCase();

// The facts an action's outgoing text gives away, each with the marker that gave it away.
// Three checks ask; the answer is computed once per proposed action.
type FoundFact = { id: string; text: string; markers: string[]; doc: string; title: string; marker: string };
const factsCache = new WeakMap<ProposedAction, Promise<FoundFact[]>>();
function factsIn(g: Graph, a: ProposedAction) {
  let found = factsCache.get(a);
  if (!found) factsCache.set(a, (found = scanFacts(g, a)));
  return found;
}
async function scanFacts(g: Graph, a: ProposedAction): Promise<FoundFact[]> {
  const text = outgoingText(a);
  if (!a.to || !text.trim()) return [];
  const facts = (await g.roQuery<Omit<FoundFact, "marker">>(Q.facts)).data ?? [];
  return facts
    .map((f) => ({ ...f, marker: f.markers.find((m) => text.includes(m.toLowerCase())) }))
    .filter((f): f is FoundFact => !!f.marker);
}

async function contentFlow(g: Graph, a: ProposedAction): Promise<CheckResult> {
  const base = { check: "content_flow" as const, cypher: [Q.facts, Q.docFlow] };
  if (!a.to || !outgoingText(a).trim()) return { ...base, status: "skip", reason: "no text leaves your graph", evidence: [] };

  const found = await factsIn(g, a);
  if (!found.length) return { ...base, status: "pass", reason: "the text gives away nothing from your documents", evidence: [] };

  const flow = await informationFlow(g, { ...a, docs: [...new Set(found.map((f) => f.doc))] });
  const gives = found.map((f) => `“${f.marker}” → ${f.text} ← CONTAINS ← ${f.title}`);
  const reason = flow.status === "pass"
    ? `the text mentions ${found.map((f) => `“${f.marker}”`).join(", ")}; the recipient may see where that comes from`
    : `the text gives away ${found.map((f) => `“${f.text}”`).join(", ")}: ${flow.reason}`;
  return { ...base, status: flow.status, reason, evidence: [...gives, ...flow.evidence], refs: [...found.map((f) => f.id), ...(flow.refs ?? [])] };
}

// Meta's "Agents Rule of Two": an agent must not, unsupervised, combine (A) untrusted input,
// (B) private data and (C) an external effect. Taint (A) comes from the graph, not from the
// planner's claim about provenance: is a stranger, or a flagged mail, asking for the data being
// sent, or is the recipient that stranger? If A, B and C all hold, a human must approve: the
// check answers ASK, which no standing rule can turn into ALLOW.
async function ruleOfTwo(g: Graph, a: ProposedAction): Promise<CheckResult> {
  const base = { check: "rule_of_two" as const, cypher: [Q.untrustedFrom, Q.untrustedAbout, Q.sensitivity, Q.facts] };
  const external = OUTBOUND.includes(a.type) || (a.type === "create_event" && !!a.to);
  if (!external) return { ...base, status: "skip", reason: "nothing leaves your graph", evidence: [] };

  const facts = await factsIn(g, a);
  const dataIds = [...new Set([...(a.docs ?? []), ...facts.map((f) => f.doc)])];
  const sensitive = dataIds.length
    ? ((await g.roQuery<{ title: string; sensitivity: string }>(Q.sensitivity, { params: { ids: dataIds } })).data ?? [])
        .filter((d) => d.sensitivity === "internal" || d.sensitivity === "restricted")
    : [];

  type Mail = { id: string; subject: string; from: string; flagged: boolean; known: number };
  const candidates = [
    ...((await g.roQuery<Mail>(Q.untrustedFrom, { params: { to: a.to ?? "" } })).data ?? []),
    ...(dataIds.length ? (await g.roQuery<Mail>(Q.untrustedAbout, { params: { ids: dataIds } })).data ?? [] : []),
  ];
  const tainting = [...new Map(candidates.filter((m) => m.known === 0 || m.flagged).map((m) => [m.id, m])).values()];

  const legs = [
    tainting.length ? `A untrusted input: ${tainting.map((m) => `“${m.subject}” from ${m.from}`).join(", ")}` : null,
    sensitive.length ? `B private data: ${sensitive.map((d) => `${d.title} (${d.sensitivity})`).join(", ")}` : null,
    "C external effect: it leaves your graph",
  ].filter((x): x is string => !!x);
  const refs = tainting.map((m) => m.id);

  if (tainting.length && sensitive.length) {
    return { ...base, status: "ask", reason: "Rule of Two: untrusted input + private data + an external effect, so a human must approve (a standing rule can't)", evidence: legs, refs };
  }
  return { ...base, status: "pass", reason: `${legs.length} of 3 (${legs.map((l) => l[0]).join(" + ")}): safe to proceed on the other checks`, evidence: legs, refs };
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

  const res = await g.roQuery<{ id: string; description: string; name: string; scope: string }>(Q.rule, { params: { type: a.type, email: a.to, now: Date.now() } });
  const row = res.data?.[0];
  if (!row) return { ...base, status: "ask", reason: `no standing rule for ${a.type} to ${a.to} yet (or it expired)`, evidence: [] };

  // A rule is a scoped capability: it also bounds how sensitive the data it carries may be.
  // Restricted data is never in scope, so it always needs a human (if the path allows it at all).
  const facts = await factsIn(g, a);
  const dataIds = [...new Set([...(a.docs ?? []), ...facts.map((f) => f.doc)])];
  const data = dataIds.length ? (await g.roQuery<{ title: string; sensitivity: string }>(Q.sensitivity, { params: { ids: dataIds } })).data ?? [] : [];
  const over = data.filter((d) => (RANK[d.sensitivity] ?? 2) > (RANK[row.scope] ?? 1));
  const evidence = [`Rule "${row.description}" -SCOPED_TO-> ${row.name} {up to ${row.scope} data}`];
  if (over.length) {
    return { ...base, status: "ask", reason: `your rule "${row.description}" covers data up to ${row.scope}; this carries ${over.map((d) => `${d.title} (${d.sensitivity})`).join(", ")}`, evidence, refs: [row.id] };
  }
  return { ...base, status: "pass", reason: `your rule "${row.description}" allows it`, evidence, refs: [row.id] };
}

const RANK: Record<string, number> = { public: 0, internal: 1, restricted: 2 };
const MAX_OUTBOUND_PER_REQUEST = 3;

// Abuse limit: one request (or one inbound mail) can't fan out into a bulk send. From the
// fourth outbound action derived from the same source, a human decides.
async function volume(g: Graph, a: ProposedAction): Promise<CheckResult> {
  const base = { check: "volume" as const, cypher: [Q.outboundFromSource] };
  const external = OUTBOUND.includes(a.type) || (a.type === "create_event" && !!a.to);
  if (!external || a.derivedFrom === "user") return { ...base, status: "skip", reason: "not part of a multi-action request", evidence: [] };
  const n = (await g.roQuery<{ c: number }>(Q.outboundFromSource, { params: { src: a.derivedFrom, self: a.selfId ?? "", before: a.selfCreatedAt ?? Number.MAX_SAFE_INTEGER } })).data?.[0]?.c ?? 0;
  if (n >= MAX_OUTBOUND_PER_REQUEST) {
    return { ...base, status: "ask", reason: `this request already produced ${n} outbound actions; more than ${MAX_OUTBOUND_PER_REQUEST} needs you`, evidence: [`${n} Actions -DERIVED_FROM-> the same source`], refs: [a.derivedFrom] };
  }
  return { ...base, status: "pass", reason: `${n + 1} of at most ${MAX_OUTBOUND_PER_REQUEST} outbound actions for this request`, evidence: [] };
}

// Email addresses are case-insensitive; the graph stores them lower-cased.
export function normalise(a: ProposedAction): ProposedAction {
  return a.to ? { ...a, to: a.to.trim().toLowerCase() } : a;
}

// `relationships: false` is the ablation (eval/ablation.ts): the checks that follow paths through
// the graph (information flow, content flow, Rule of Two taint) are replaced by attribute lookups
// or switched off. Production never passes it.
export async function check(g: Graph, action: ProposedAction, opts: { relationships?: boolean } = {}): Promise<SentinelResult> {
  const a = normalise(action);
  const flat = opts.relationships === false;
  const off = (check: CheckResult["check"]): CheckResult => ({ check, cypher: [], status: "skip", reason: "ablated: needs relationships", evidence: [] });
  const checks = [
    await knownRecipient(g, a),
    flat ? await attributeFlow(g, a) : await informationFlow(g, a),
    flat ? off("content_flow") : await contentFlow(g, a),
    flat ? off("rule_of_two") : await ruleOfTwo(g, a),
    await provenance(g, a),
    await calendar(g, a),
    await standingRule(g, a),
    await volume(g, a),
  ];

  const blocked = checks.filter((c) => c.status === "block");
  if (blocked.length) return { verdict: "BLOCK", reason: blocked.map((c) => c.reason).join("; "), checks };

  const asks = checks.filter((c) => c.status === "ask");
  if (asks.length) return { verdict: "ASK", reason: asks.map((c) => c.reason).join("; "), checks };

  return { verdict: "ALLOW", reason: "every check passed", checks };
}
