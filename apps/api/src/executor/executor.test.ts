import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decide, proposeAction } from "../actions/actions";
import { graphFor } from "../db";
import { tomorrowAt } from "../seed/demo";
import { seedDemo } from "../seed/seed";
import { calendarView, executeAction, outbox, runExecutor, tasksView } from "./executor";

const graph = graphFor("test_executor");
const now = Date.now();
const PRIYA = "priya@northwind.example";
const RAHUL = "rahul@example.com";

beforeAll(async () => {
  await seedDemo(graph, now);
});

afterAll(async () => {
  await graph.delete();
});

const one = async <T>(cypher: string, params: Record<string, string> = {}) =>
  (await graph.roQuery<T>(cypher, { params })).data?.[0];

describe("the Priya flow, end to end", () => {
  let id = "";

  test("approve then execute: the email lands in the outbox with the doc attached", async () => {
    const p = await proposeAction(graph, {
      type: "send_email", to: PRIYA, docs: ["d:atlas-update-v2"], derivedFrom: "msg:priya-1",
      subject: "Atlas update", body: "Hi Priya, the latest update is attached.",
    });
    id = p.id;
    await decide(graph, id, "approved");

    const r = await executeAction(graph, id);
    expect(r.ok).toBe(true);
    const sent = (await outbox(graph)) as { subject: string; to: string; attachments: string[] }[];
    expect(sent[0]).toMatchObject({ subject: "Atlas update", to: "Priya Nair", attachments: ["Atlas project update (v2)"] });
  });

  test("it keeps the commitment to Priya and records it", async () => {
    const c = await one<{ status: string; kept: number }>(
      "MATCH (c:Commitment {id: 'c:priya-update'}) OPTIONAL MATCH (a:Action {id: $id})-[k:FULFILS]->(c) RETURN c.status AS status, count(k) AS kept",
      { id },
    );
    expect(c).toEqual({ status: "fulfilled", kept: 1 });
  });

  test("the graph remembers: contact count goes up, the doc is now shared with her", async () => {
    const k = await one<{ count: number }>("MATCH (:User)-[k:KNOWS]->(:Person {email: $to}) RETURN k.count AS count", { to: PRIYA });
    expect(k?.count).toBe(15);
    const s = await one<{ c: number }>("MATCH (:Document {id: 'd:atlas-update-v2'})-[:SHARED_WITH]->(:Person {email: $to}) RETURN count(*) AS c", { to: PRIYA });
    expect(s?.c).toBe(1);
  });

  test("the action is done, claimed and executed by the Executor", async () => {
    const a = await one<{ status: string; claimed: number; executed: number }>(
      `MATCH (a:Action {id: $id})
       OPTIONAL MATCH (a)-[c:CLAIMED_BY]->(:Agent {id: 'a:executor'})
       OPTIONAL MATCH (:Agent {id: 'a:executor'})-[e:EXECUTED]->(a)
       RETURN a.status AS status, count(DISTINCT c) AS claimed, count(DISTINCT e) AS executed`,
      { id },
    );
    expect(a).toEqual({ status: "done", claimed: 1, executed: 1 });
  });

  test("it can't run twice", async () => {
    const r = await executeAction(graph, id);
    expect(r).toMatchObject({ ok: false, status: "done" });
  });
});

describe("only allowed or approved actions run", () => {
  test("a pending action is refused", async () => {
    const p = await proposeAction(graph, { type: "send_email", to: "someone@new.example", derivedFrom: "user" });
    expect(await executeAction(graph, p.id)).toMatchObject({ ok: false, status: "pending" });
  });

  test("a blocked action is refused", async () => {
    const p = await proposeAction(graph, { type: "send_email", to: "alex.chen@unknown.example", docs: ["d:atlas-pricing"], derivedFrom: "msg:alex-1" });
    expect(await executeAction(graph, p.id)).toMatchObject({ ok: false, status: "blocked" });
  });
});

describe("the graph changed after the verdict", () => {
  test("an approved send is blocked if the doc became restricted meanwhile", async () => {
    await graph.query(
      `MATCH (pr:Project {id: 'pr:atlas'})
       CREATE (:Entity:Document {id: 'd:test-notes', title: 'Atlas notes', sensitivity: 'internal'})-[:BELONGS_TO]->(pr)`,
    );
    const p = await proposeAction(graph, { type: "send_email", to: PRIYA, docs: ["d:test-notes"], derivedFrom: "user" });
    await decide(graph, p.id, "approved");
    await graph.query("MATCH (d:Document {id: 'd:test-notes'}) SET d.sensitivity = 'restricted'");

    const r = await executeAction(graph, p.id);
    expect(r).toMatchObject({ ok: false, status: "blocked" });
    expect((await outbox(graph)).length).toBe(1); // still only the Priya update
  });

  test("an allowed send goes back to the inbox if its rule was revoked meanwhile", async () => {
    await graph.query(
      `MATCH (p:Person {email: $to})
       CREATE (:Entity:Rule {id: 'rule:rahul', action_type: 'send_email', active: true})-[:SCOPED_TO]->(p)`,
      { params: { to: RAHUL } },
    );
    const p = await proposeAction(graph, { type: "send_email", to: RAHUL, derivedFrom: "user", subject: "hi" });
    expect(p.status).toBe("ready");
    await graph.query("MATCH (r:Rule {id: 'rule:rahul'}) SET r.active = false");

    expect(await executeAction(graph, p.id)).toMatchObject({ ok: false, status: "pending" });
  });
});

describe("calendar and tasks", () => {
  test("an approved event becomes a Meeting with the invitee", async () => {
    const p = await proposeAction(graph, {
      type: "create_event", title: "Orbit review", to: "dev@orbit.example",
      start: tomorrowAt(now, 16), end: tomorrowAt(now, 17), derivedFrom: "user",
    });
    await decide(graph, p.id, "approved");
    expect((await executeAction(graph, p.id)).ok).toBe(true);
    const cal = (await calendarView(graph)) as { title: string; with: string[] }[];
    expect(cal.find((m) => m.title === "Orbit review")?.with).toEqual(["Dev Kapoor"]);
  });

  test("the executor pass runs every ready action: a task lands on the list", async () => {
    await proposeAction(graph, { type: "create_task", title: "Book Goa flights", due: now + 86_400_000, derivedFrom: "user" });
    const results = await runExecutor(graph);
    expect(results.some((r) => r.ok)).toBe(true);
    const tasks = (await tasksView(graph)) as { title: string; status: string }[];
    expect(tasks.find((t) => t.title === "Book Goa flights")?.status).toBe("open");
  });

  test("the task list shows what blocks what", async () => {
    const tasks = (await tasksView(graph)) as { title: string; blockedBy: string[] }[];
    expect(tasks.find((t) => t.title === "Send Atlas update to Priya")?.blockedBy).toEqual(["Finalise Atlas metrics"]);
  });
});
