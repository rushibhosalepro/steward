import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { graphFor } from "../db";
import { planRequest } from "../planner/plan";
import type { PlannedAction, Planner } from "../planner/types";
import { seedDemo } from "../seed/seed";
import { renderContext, retrieve } from "./retrieve";

const graph = graphFor("test_memory");
const SESSION = "session-test-0001";

const fixed = (a: Partial<PlannedAction>): Planner => ({
  name: "fixed",
  plan: async () => ({
    summary: "x",
    actions: [{ type: "send_email", to: null, docs: [], subject: null, body: null, title: null, start: null, end: null, due: null, derived_from: "request", rationale: "x", ...a } as PlannedAction],
  }),
});

beforeAll(async () => {
  await seedDemo(graph);
  await planRequest(graph, "Send Priya the latest Atlas update", fixed({ to: "priya@northwind.example", docs: ["d:atlas-update-v2"] }), { sessionId: SESSION });
});

afterAll(async () => {
  await graph.delete();
});

describe("conversation memory (episodic)", () => {
  test("a request is stored as a Turn in its Session, linked to what it was about", async () => {
    const r = await graph.roQuery<{ text: string; about: string[] }>(
      `MATCH (:Session {id: $sid})-[:HAS]->(t:Turn)-[:MENTIONS]->(e)
       RETURN t.text AS text, collect(e.id) AS about`, { params: { sid: SESSION } });
    expect(r.data?.[0]?.text).toBe("Send Priya the latest Atlas update");
    expect(r.data?.[0]?.about.sort()).toEqual(["d:atlas-update-v2", "p:priya"]);
  });

  test("'send that to Rahul' starts from what the last turn was about", async () => {
    const ctx = await retrieve(graph, "Now send that to Rahul too", 6, SESSION);
    const ids = ctx.entryPoints.map((e) => e.id);
    expect(ids).toContain("d:atlas-update-v2");
    expect(ids).toContain("p:rahul");
    const text = renderContext(ctx);
    expect(text).toContain('the user said: "Send Priya the latest Atlas update"');
  });

  test("without the session, 'that' has nothing to resolve to", async () => {
    const ctx = await retrieve(graph, "Now send that to Rahul too");
    expect(ctx.entryPoints.map((e) => e.id)).not.toContain("d:atlas-update-v2");
  });

  test("a new session remembers earlier sessions about the same people, and how they ended", async () => {
    const ctx = await retrieve(graph, "What did I last send Priya?", 6, "session-next-day-0003");
    expect(ctx.conversation).toEqual([]);
    const e = ctx.earlier?.[0];
    expect(e?.text).toBe("Send Priya the latest Atlas update");
    expect(e?.about).toContain("Priya Nair");
    expect(e?.outcomes.join(" ")).toMatch(/send_email (ALLOW|ASK)/);
    expect(renderContext(ctx)).toContain("earlier sessions about the same people or documents");
  });

  test("sessions are separate, and turns never leak into another user's graph", async () => {
    expect((await retrieve(graph, "send that to Rahul", 6, "session-other-0002")).conversation).toEqual([]);
    const other = graphFor("test_memory_other");
    await seedDemo(other);
    expect((await retrieve(other, "send that to Rahul", 6, SESSION)).conversation).toEqual([]);
    await other.delete();
  });
});
