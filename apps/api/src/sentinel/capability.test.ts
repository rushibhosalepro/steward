import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decide, proposeAction } from "../actions/actions";
import { graphFor } from "../db";
import { planRequest } from "../planner/plan";
import type { PlannedAction, Planner } from "../planner/types";
import { decideRule, listRules, RULE_TTL } from "../rules/rules";
import { seedDemo } from "../seed/seed";
import { check } from "./sentinel";

const graph = graphFor("test_capability");
const RAHUL = "rahul@example.com";

beforeAll(async () => {
  await seedDemo(graph);
});

afterAll(async () => {
  await graph.delete();
});

const ruleCheck = async (a: Parameters<typeof check>[1]) => (await check(graph, a)).checks.find((c) => c.check === "standing_rule")!;

describe("rules are scoped capabilities", () => {
  test("a learned rule is capped at internal data and expires 30 days after it's accepted", async () => {
    for (let i = 0; i < 3; i++) {
      const p = await proposeAction(graph, { type: "send_email", to: RAHUL, derivedFrom: "user", subject: `note ${i}` });
      await decide(graph, p.id, "approved");
    }
    const rule = (await listRules(graph))[0]!;
    const before = Date.now();
    await decideRule(graph, rule.id, "accept");
    const r = (await graph.roQuery<{ scope: string; expires: number }>("MATCH (r:Rule {id: $id}) RETURN r.max_sensitivity AS scope, r.expires_at AS expires", { params: { id: rule.id } })).data![0]!;
    expect(r.scope).toBe("internal");
    expect(r.expires).toBeGreaterThanOrEqual(before + RULE_TTL);
  });

  test("within scope: internal data to Rahul runs on the rule", async () => {
    expect((await ruleCheck({ type: "send_email", to: RAHUL, docs: ["d:atlas-update-v2"], derivedFrom: "user" })).status).toBe("pass");
  });

  test("out of scope: the pricing sheet is shared with Rahul, but restricted data is never covered by a rule", async () => {
    const c = await ruleCheck({ type: "send_email", to: RAHUL, docs: ["d:atlas-pricing"], derivedFrom: "user" });
    expect(c.status).toBe("ask");
    expect(c.reason).toContain("covers data up to internal");
  });

  test("out of scope through the text, too: the price typed into the email", async () => {
    const c = await ruleCheck({ type: "send_email", to: RAHUL, body: "Enterprise is $48,000.", derivedFrom: "user" });
    expect(c.status).toBe("ask");
  });

  test("an expired rule no longer applies", async () => {
    await graph.query("MATCH (r:Rule) SET r.expires_at = 1");
    const c = await ruleCheck({ type: "send_email", to: RAHUL, derivedFrom: "user" });
    expect(c.status).toBe("ask");
    expect(c.reason).toContain("expired");
  });
});

describe("volume: one request can't become a bulk send", () => {
  test("a hijacked planner emails five people from one request: the first three go to the usual checks, the rest need you", async () => {
    const email = (to: string): PlannedAction => ({
      type: "send_email", to, docs: [], subject: "hi", body: "hello", title: null, start: null, end: null, due: null,
      derived_from: "request", rationale: "bulk",
    });
    const bulk: Planner = {
      name: "bulk",
      plan: async () => ({
        summary: "email everyone",
        actions: ["priya@northwind.example", RAHUL, "meera@family.example", "dev@orbit.example", "alex.chen@unknown.example"].map(email),
      }),
    };
    const r = await planRequest(graph, "email everyone", bulk);
    const volume = await Promise.all(
      r.steps.map(async (s) => {
        const a = await graph.roQuery<{ checks: string }>("MATCH (a:Action {id: $id}) RETURN a.checks AS checks", { params: { id: s.action.id } });
        return (JSON.parse(a.data![0]!.checks) as { check: string; status: string }[]).find((c) => c.check === "volume")!.status;
      }),
    );
    expect(volume).toEqual(["pass", "pass", "pass", "ask", "ask"]);
    expect(r.steps.slice(3).every((s) => s.verdict !== "ALLOW")).toBe(true);
  });

  test("direct, one-at-a-time actions aren't counted as a bulk request", async () => {
    const r = await check(graph, { type: "send_email", to: RAHUL, derivedFrom: "user" });
    expect(r.checks.find((c) => c.check === "volume")?.status).toBe("skip");
  });
});
