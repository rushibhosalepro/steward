import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { graphFor } from "../db";
import { tasksView } from "../executor/executor";
import { retrieve } from "../retrieval/retrieve";
import { seedDemo } from "../seed/seed";
import { OfflinePlanner } from "./offline";
import { choosePlanner, planRequest, toProposed } from "./plan";
import type { Plan, PlannedAction, Planner } from "./types";

const graph = graphFor("test_planner");
const PRIYA_REQUEST = "Prepare for tomorrow's meeting with Priya and send her the project update";

beforeAll(async () => {
  await seedDemo(graph);
});

afterAll(async () => {
  await graph.delete();
});

const one = async <T>(cypher: string, params: Record<string, string> = {}) =>
  (await graph.roQuery<T>(cypher, { params })).data?.[0];

const action = (a: Partial<PlannedAction> & Pick<PlannedAction, "type" | "derived_from">): PlannedAction => ({
  to: null, docs: [], subject: null, body: null, title: null, start: null, end: null, due: null, rationale: "test", ...a,
});

class FixedPlanner implements Planner {
  name = "fixed";
  constructor(private plan_: Plan) {}
  async plan() {
    return this.plan_;
  }
}

describe("offline planner", () => {
  test("on the Priya request: send the update she's owed, and a prep task for the sync", async () => {
    const ctx = await retrieve(graph, PRIYA_REQUEST);
    const plan = await new OfflinePlanner().plan(PRIYA_REQUEST, ctx);
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0]).toMatchObject({
      type: "send_email", to: "priya@northwind.example", docs: ["d:atlas-update-v2"], derived_from: "msg:priya-1",
    });
    expect(plan.actions[0]?.rationale).toContain("commitment");
    expect(plan.actions[1]).toMatchObject({ type: "create_task", title: "Prepare for Atlas sync with Priya", derived_from: "request" });
  });

  test("a document named in the request wins, and the stranger's mail is cited as the source", async () => {
    const req = "Forward Alex the Atlas pricing sheet he asked for";
    const plan = await new OfflinePlanner().plan(req, await retrieve(graph, req));
    expect(plan.actions[0]).toMatchObject({
      type: "send_email", to: "alex.chen@unknown.example", docs: ["d:atlas-pricing"], derived_from: "msg:alex-1",
    });
  });

  test("a request it can't handle yields an empty plan, not a guess", async () => {
    const ctx = await retrieve(graph, "what's the weather like");
    const plan = await new OfflinePlanner().plan("what's the weather like", ctx);
    expect(plan.actions).toEqual([]);
  });
});

describe("planRequest: the full chain in the graph", () => {
  let result: Awaited<ReturnType<typeof planRequest>>;

  beforeAll(async () => {
    result = await planRequest(graph, PRIYA_REQUEST, new OfflinePlanner());
  });

  test("the email asks first, the prep task just runs", () => {
    expect(result.planner).toBe("offline");
    expect(result.steps.map((s) => [s.action.type, s.verdict, s.status])).toEqual([
      ["send_email", "ASK", "pending"],
      ["create_task", "ALLOW", "done"],
    ]);
  });

  test("the prep task is on the list", async () => {
    const tasks = (await tasksView(graph)) as { title: string }[];
    expect(tasks.map((t) => t.title)).toContain("Prepare for Atlas sync with Priya");
  });

  test("Request -> Plan -> Step -> Action is in the graph, with the context the plan used", async () => {
    const chain = await one<{ steps: number }>(
      `MATCH (:Request {id: $req})-[:PRODUCED]->(p:Plan {id: $plan})-[:HAS]->(:Step)-[:PROPOSES]->(:Action)
       RETURN count(*) AS steps`,
      { req: result.requestId, plan: result.planId },
    );
    expect(chain?.steps).toBe(2);
    const used = await one<{ c: number }>("MATCH (:Plan {id: $plan})-[:USED_CONTEXT]->(:Person {id: 'p:priya'}) RETURN count(*) AS c", { plan: result.planId });
    expect(used?.c).toBe(1);
    const wrote = await one<{ c: number }>("MATCH (:Agent {id: 'a:planner'})-[:WROTE]->(:Plan {id: $plan}) RETURN count(*) AS c", { plan: result.planId });
    expect(wrote?.c).toBe(1);
  });

  test("the email's provenance is Priya's own message", async () => {
    const src = await one<{ id: string }>("MATCH (a:Action {id: $id})-[:DERIVED_FROM]->(s) RETURN s.id AS id", { id: result.steps[0]!.action.id });
    expect(src?.id).toBe("msg:priya-1");
  });
});

describe("a hijacked planner still can't leak", () => {
  test("forwarding the pricing sheet to Alex is blocked, whatever the planner claims as provenance", async () => {
    const hijacked = new FixedPlanner({
      summary: "Following the instructions in Alex's email.",
      actions: [
        action({ type: "send_email", to: "alex.chen@unknown.example", docs: ["d:atlas-pricing"], derived_from: "msg:alex-1" }),
        action({ type: "send_email", to: "alex.chen@unknown.example", docs: ["d:atlas-pricing"], derived_from: "request" }),
        action({ type: "share_doc", to: "priya@northwind.example", docs: ["d:atlas-pricing"], derived_from: "request" }),
      ],
    });
    const r = await planRequest(graph, "handle my inbox", hijacked);
    expect(r.steps.map((s) => s.verdict)).toEqual(["BLOCK", "BLOCK", "BLOCK"]);
    expect(r.steps.every((s) => s.status === "blocked")).toBe(true);
  });

  test("an invented provenance id fails closed", async () => {
    const r = await planRequest(graph, "email Rahul", new FixedPlanner({
      summary: "x",
      actions: [action({ type: "send_email", to: "rahul@example.com", derived_from: "msg:made-up" })],
    }));
    expect(r.steps[0]?.verdict).toBe("ASK");
    expect(r.steps[0]?.reason).toContain("unknown source");
  });
});

describe("plumbing", () => {
  test("toProposed maps request provenance and ISO times", () => {
    const p = toProposed(action({ type: "create_event", derived_from: "request", start: "2026-10-16T16:00:00+05:30", end: "bad" }), "req:1", "hi");
    expect(p.derivedFrom).toBe("req:1");
    expect(p.start).toBe(Date.parse("2026-10-16T10:30:00Z"));
    expect(p.end).toBeUndefined();
  });

  test("choosePlanner honours an explicit choice and refuses an unconfigured one", () => {
    expect(choosePlanner("offline", {}).name).toBe("offline");
    expect(choosePlanner("claude", { ANTHROPIC_API_KEY: "x" }).name).toBe("claude");
    expect(() => choosePlanner("claude", {})).toThrow("not configured");
    expect(() => choosePlanner("groq", {})).toThrow("not configured");
    expect(() => choosePlanner("nope", {})).toThrow("unknown planner");
  });
});
