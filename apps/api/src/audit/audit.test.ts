import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decide, proposeAction } from "../actions/actions";
import { graphFor } from "../db";
import { executeAction, runExecutor } from "../executor/executor";
import { seedDemo } from "../seed/seed";
import { setPaused, verifyAudit } from "./audit";

const graph = graphFor("test_audit");

beforeAll(async () => {
  await seedDemo(graph);
});

afterAll(async () => {
  await graph.delete();
});

describe("the audit chain", () => {
  test("verdicts, approvals and executions are appended and verify", async () => {
    const p = await proposeAction(graph, { type: "send_email", to: "priya@northwind.example", derivedFrom: "user", subject: "hi" });
    await decide(graph, p.id, "approved");
    await executeAction(graph, p.id);
    const kinds = (await graph.roQuery<{ kind: string }>("MATCH (e:AuditEvent) RETURN e.kind AS kind ORDER BY e.seq")).data!.map((r) => r.kind);
    expect(kinds).toEqual(["verdict", "approval", "execution"]);
    expect(await verifyAudit(graph)).toMatchObject({ ok: true, length: 3 });
  });

  test("editing a recorded verdict is detected", async () => {
    await graph.query("MATCH (e:AuditEvent {seq: 1}) SET e.payload = replace(e.payload, 'ASK', 'ALLOW')");
    expect(await verifyAudit(graph)).toMatchObject({ ok: false, brokenAt: 1, reason: "payload was changed after it was recorded" });
  });

  test("deleting an event is detected", async () => {
    const g2 = graphFor("test_audit_delete");
    await seedDemo(g2);
    for (let i = 0; i < 3; i++) await proposeAction(g2, { type: "create_task", title: `t${i}`, derivedFrom: "user" });
    await g2.query("MATCH (e:AuditEvent {seq: 2}) DETACH DELETE e");
    expect(await verifyAudit(g2)).toMatchObject({ ok: false, reason: "event 2 is missing" });
    await g2.delete();
  });
});

describe("the kill switch", () => {
  test("while paused, nothing runs; on resume, queued actions run", async () => {
    const g3 = graphFor("test_audit_pause");
    await seedDemo(g3);
    await setPaused(g3, true);
    const p = await proposeAction(g3, { type: "create_task", title: "while paused", derivedFrom: "user" });
    expect(p.verdict).toBe("ALLOW");
    expect(await executeAction(g3, p.id)).toMatchObject({ ok: false, status: "paused" });
    await setPaused(g3, false);
    expect((await runExecutor(g3)).some((r) => r.ok)).toBe(true);
    expect(await verifyAudit(g3)).toMatchObject({ ok: true });
    await g3.delete();
  });
});
