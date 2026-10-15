import type { Graph } from "falkordb";
import { createHash } from "node:crypto";

// A tamper-evident audit trail in the graph. Every verdict, approval, execution and pause is
// appended as an AuditEvent holding a hash of its payload and of the previous event, linked
// by NEXT into one chain per user. verifyAudit() recomputes it: editing or deleting any past
// event breaks the chain at that point. Nothing in the API or MCP updates or deletes events.

export const POLICY_VERSION = "2026-10-15.s4"; // bump when the Sentinel's policy changes

export type AuditKind = "verdict" | "approval" | "execution" | "pause" | "resume";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Stable JSON: keys sorted, undefined dropped, so the same payload always hashes the same.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const eventHash = (e: { seq: number; kind: string; action_id: string; payload_hash: string; policy_version: string; prev_hash: string; ts: number }) =>
  sha256([e.seq, e.kind, e.action_id, e.payload_hash, e.policy_version, e.prev_hash, e.ts].join("|"));

export async function appendAudit(g: Graph, kind: AuditKind, actionId: string | null, payload: unknown) {
  const last = (await g.roQuery<{ seq: number; hash: string }>("MATCH (e:AuditEvent) RETURN e.seq AS seq, e.hash AS hash ORDER BY e.seq DESC LIMIT 1")).data?.[0];
  const body = canonical(payload);
  const event = {
    seq: (last?.seq ?? 0) + 1,
    kind,
    action_id: actionId ?? "",
    payload_hash: sha256(body),
    policy_version: POLICY_VERSION,
    prev_hash: last?.hash ?? "genesis",
    ts: Date.now(),
  };
  const hash = eventHash(event);
  await g.query(
    `CREATE (e:Entity:AuditEvent {id: $id, seq: $seq, kind: $kind, action_id: $action_id, payload: $payload,
       payload_hash: $payload_hash, policy_version: $policy_version, prev_hash: $prev_hash, hash: $hash, ts: $ts})
     WITH e OPTIONAL MATCH (p:AuditEvent {seq: $prevSeq}) FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | CREATE (p)-[:NEXT]->(e))
     WITH e OPTIONAL MATCH (a:Action {id: $action_id}) FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | CREATE (e)-[:ABOUT]->(a))`,
    { params: { id: `audit:${event.seq}`, ...event, payload: body, hash, prevSeq: event.seq - 1 } },
  );
  return { seq: event.seq, hash };
}

export async function verifyAudit(g: Graph) {
  const rows = (await g.roQuery<{
    seq: number; kind: string; action_id: string; payload: string; payload_hash: string;
    policy_version: string; prev_hash: string; hash: string; ts: number;
  }>(
    `MATCH (e:AuditEvent)
     RETURN e.seq AS seq, e.kind AS kind, e.action_id AS action_id, e.payload AS payload, e.payload_hash AS payload_hash,
            e.policy_version AS policy_version, e.prev_hash AS prev_hash, e.hash AS hash, e.ts AS ts
     ORDER BY e.seq`,
  )).data ?? [];

  let prev = "genesis";
  for (const [i, e] of rows.entries()) {
    const fail = (reason: string) => ({ ok: false as const, length: rows.length, brokenAt: e.seq, reason });
    if (e.seq !== i + 1) return fail(`event ${i + 1} is missing`);
    if (sha256(e.payload) !== e.payload_hash) return fail("payload was changed after it was recorded");
    if (e.prev_hash !== prev) return fail("chain link to the previous event is broken");
    if (eventHash(e) !== e.hash) return fail("event fields were changed after it was recorded");
    prev = e.hash;
  }
  return { ok: true as const, length: rows.length, head: prev };
}

// The kill switch. While paused, the Executor runs nothing; planning, checks and the inbox
// keep working, and queued actions run once the user resumes.
export async function setPaused(g: Graph, paused: boolean) {
  await g.query("MATCH (u:User) SET u.paused = $paused", { params: { paused } });
  await appendAudit(g, paused ? "pause" : "resume", null, { paused });
  return { paused };
}

export async function isPaused(g: Graph) {
  return (await g.roQuery<{ p: boolean }>("MATCH (u:User) RETURN coalesce(u.paused, false) AS p")).data?.[0]?.p ?? false;
}
