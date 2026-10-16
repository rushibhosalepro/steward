import type { Graph } from "falkordb";
import { searchTerms } from "../retrieval/retrieve";

// Inbound mail -> the graph. Deterministic on purpose (works with no API key, and the result
// is explainable): the sender is resolved by email, mentions are found by the full-text index
// and confirmed by a word check, and a request ("could you send ...") becomes a *proposed*
// Commitment, but only from someone the user knows. A stranger's request just flags the mail.

export type InboundMail = { from: { email: string; name?: string }; subject: string; body: string };

const ASK = /\b(?:could|can|would|will) you\b[^.?!]*[.?!]?|\bplease\b[^.?!]*[.?!]?/i;
const GENERIC = new Set(["project", "update", "sheet", "document", "doc", "notes", "the", "and", "with", "for"]);

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);

type Candidate = { id: string; label: string; name: string; score: number; superseded: boolean };

// `reportedBy`: an agent (over MCP) read this email with its own tools and handed it to Steward.
// Steward can't verify who really sent it, so it is always unverified input (flagged), whatever
// sender it names: taint and the Rule of Two apply to anything it asks for.
export async function ingestMail(g: Graph, mail: InboundMail, now = Date.now(), opts: { reportedBy?: string } = {}) {
  const email = mail.from.email.trim().toLowerCase();
  const text = `${mail.subject}\n${mail.body}`;
  const present = words(text);

  // 1. Sender: existing Person by email, else a new one with no KNOWS edge (a stranger).
  const sender = (
    await g.query<{ id: string; name: string; known: boolean; created: boolean }>(
      `MERGE (p:Entity:Person {email: $email})
       ON CREATE SET p.id = $pid, p.name = $name, p.created_by = 'ingest', p.created_at = $ts
       WITH p OPTIONAL MATCH (u:User)-[:KNOWS]->(p)
       RETURN p.id AS id, p.name AS name, count(u) > 0 AS known, coalesce(p.created_at = $ts, false) AS created`,
      { params: { email, pid: `p:${crypto.randomUUID()}`, name: mail.from.name ?? email, ts: now } },
    )
  ).data![0]!;

  // 2. Mentions: full-text candidates, confirmed by the words actually present.
  const terms = searchTerms(text);
  const candidates = terms.length
    ? ((
        await g.roQuery<Candidate>(
          `CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score
           WITH node, score WHERE any(l IN labels(node) WHERE l IN ['Person', 'Project', 'Document'])
           OPTIONAL MATCH (newer:Document)-[:SUPERSEDES]->(node)
           RETURN node.id AS id, [l IN labels(node) WHERE l <> 'Entity'][0] AS label,
                  coalesce(node.name, node.title) AS name, score, count(newer) > 0 AS superseded`,
          { params: { q: terms.map((t) => `${t}|${t}*`).join("|") } },
        )
      ).data ?? [])
    : [];

  const confirmed = candidates.filter((c) => {
    if (c.id === sender.id) return false;
    const nameWords = [...words(c.name)];
    if (c.label === "Person") return nameWords.some((w) => present.has(w)); // first or last name
    if (c.label === "Project") return nameWords.every((w) => present.has(w));
    // Documents: at least two distinctive title words present, best match only.
    const distinctive = nameWords.filter((w) => w.length >= 3 && !GENERIC.has(w));
    return !c.superseded && distinctive.filter((w) => present.has(w)).length >= Math.min(2, distinctive.length);
  });
  const bestDoc = Math.max(0, ...confirmed.filter((c) => c.label === "Document").map((c) => c.score));
  const mentions = confirmed.filter((c) => c.label !== "Document" || c.score === bestDoc);

  // 3. The message itself, linked to its sender and what it mentions.
  const messageId = `msg:${crypto.randomUUID()}`;
  const ask = text.match(ASK)?.[0]?.trim() ?? null;
  const flagged = !!opts.reportedBy || (!!ask && !sender.known);
  await g.query(
    `MATCH (p:Person {id: $senderId})
     CREATE (m:Entity:Message {id: $id, direction: 'inbound', subject: $subject, body: $body, ts: $ts, status: 'received', flagged: $flagged, via: $via})-[:FROM]->(p)
     WITH m UNWIND $mentions AS mid MATCH (e:Entity {id: mid}) CREATE (m)-[:MENTIONS]->(e)`,
    { params: { senderId: sender.id, id: messageId, subject: mail.subject, body: mail.body, ts: now, flagged, via: opts.reportedBy ? "agent" : "inbox", mentions: mentions.map((m) => m.id) } },
  );
  if (opts.reportedBy) {
    await g.query("MATCH (ag:Agent {id: $agent}), (m:Message {id: $id}) CREATE (ag)-[:REPORTED]->(m)", { params: { agent: opts.reportedBy, id: messageId } });
  }

  // 4. A known contact's request becomes a proposed commitment the user can take on.
  let commitment: { id: string; what: string; about: string[] } | null = null;
  if (ask && sender.known && !opts.reportedBy) {
    const about = mentions.filter((m) => m.label === "Document" || m.label === "Project").map((m) => m.id);
    const id = `c:${crypto.randomUUID()}`;
    await g.query(
      `MATCH (p:Person {id: $senderId}), (m:Message {id: $messageId})
       CREATE (c:Entity:Commitment {id: $id, what: $what, status: 'proposed', created_at: $ts})-[:TO]->(p)
       CREATE (m)-[:ASKS_FOR]->(c)
       WITH c UNWIND $about AS aid MATCH (e:Entity {id: aid}) CREATE (c)-[:ABOUT]->(e)`,
      { params: { senderId: sender.id, messageId, id, what: `${sender.name}: ${ask}`, ts: now, about } },
    );
    commitment = { id, what: `${sender.name}: ${ask}`, about };
  }

  return {
    messageId,
    sender: { id: sender.id, name: sender.name, known: sender.known, new: sender.created },
    mentions: mentions.map(({ id, label, name }) => ({ id, label, name })),
    ask,
    flagged,
    commitment,
  };
}

// Inbound mail, newest first, with what each one was resolved to.
export async function listMail(g: Graph) {
  const res = await g.roQuery<{
    id: string; subject: string; body: string; ts: number; flagged: boolean | null;
    from: string; email: string; known: boolean; mentions: string[]; asks: string[];
  }>(
    `MATCH (m:Message {direction: 'inbound'})-[:FROM]->(p:Person)
     OPTIONAL MATCH (u:User)-[:KNOWS]->(p)
     OPTIONAL MATCH (m)-[:MENTIONS]->(e)
     OPTIONAL MATCH (m)-[:ASKS_FOR]->(c:Commitment)
     RETURN m.id AS id, m.subject AS subject, m.body AS body, m.ts AS ts, m.flagged AS flagged,
            p.name AS from, p.email AS email, count(DISTINCT u) > 0 AS known,
            collect(DISTINCT coalesce(e.name, e.title)) AS mentions, collect(DISTINCT c.what) AS asks
     ORDER BY ts DESC`,
  );
  return res.data ?? [];
}
