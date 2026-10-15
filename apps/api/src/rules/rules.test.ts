import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decide, proposeAction } from "../actions/actions";
import { graphFor } from "../db";
import { tomorrowAt } from "../seed/demo";
import { seedDemo } from "../seed/seed";
import { APPROVALS_NEEDED, decideRule, listRules } from "./rules";

const graph = graphFor("test_rules");
const now = Date.now();
const PRIYA = "priya@northwind.example";
const RAHUL = "rahul@example.com";

beforeAll(async () => {
  await seedDemo(graph, now);
});

afterAll(async () => {
  await graph.delete();
});

const sendTo = (to: string, docs?: string[]) => proposeAction(graph, { type: "send_email", to, docs, derivedFrom: "user", subject: "update" });

async function approveSend(to: string, docs?: string[]) {
  const p = await sendTo(to, docs);
  expect(p.verdict).toBe("ASK");
  return decide(graph, p.id, "approved");
}

describe("earning a rule for Priya", () => {
  let ruleId = "";

  test(`no proposal before ${APPROVALS_NEEDED} approvals`, async () => {
    for (let i = 1; i < APPROVALS_NEEDED; i++) {
      const r = await approveSend(PRIYA, ["d:atlas-update-v2"]);
      expect(r.ok && r.proposedRule).toBeFalsy();
    }
  });

  test(`the ${APPROVALS_NEEDED}rd approval proposes a narrow rule, learned from those approvals`, async () => {
    const r = await approveSend(PRIYA, ["d:atlas-update-v2"]);
    expect(r.ok && r.proposedRule).toMatchObject({ description: "send email to Priya Nair", learnedFrom: APPROVALS_NEEDED });
    ruleId = r.ok && r.proposedRule ? r.proposedRule.id : "";

    const rules = await listRules(graph);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ status: "proposed", person: "Priya Nair", action_type: "send_email", learnedFrom: APPROVALS_NEEDED });
  });

  test("a proposed rule changes nothing: Priya still needs approval", async () => {
    expect((await sendTo(PRIYA)).verdict).toBe("ASK");
  });

  test("another approval while a rule is proposed doesn't propose a duplicate", async () => {
    const r = await approveSend(PRIYA);
    expect(r.ok && r.proposedRule).toBeFalsy();
    expect(await listRules(graph)).toHaveLength(1);
  });

  test("once accepted, the next email to Priya runs without asking", async () => {
    expect(await decideRule(graph, ruleId, "accept")).toEqual({ ok: true, status: "active" });
    const p = await sendTo(PRIYA, ["d:atlas-update-v2"]);
    expect(p.verdict).toBe("ALLOW");
    expect(p.status).toBe("ready");
  });

  test("the rule is narrow: other people and other action types still ask", async () => {
    expect((await sendTo(RAHUL)).verdict).toBe("ASK");
    const ev = await proposeAction(graph, { type: "create_event", to: PRIYA, start: tomorrowAt(now, 16), end: tomorrowAt(now, 17), derivedFrom: "user" });
    expect(ev.verdict).toBe("ASK");
  });

  test("the rule never overrides a BLOCK: the restricted pricing sheet still can't go to Priya", async () => {
    const p = await sendTo(PRIYA, ["d:atlas-pricing"]);
    expect(p.verdict).toBe("BLOCK");
  });

  test("revoking puts Priya back to asking", async () => {
    expect(await decideRule(graph, ruleId, "revoke")).toEqual({ ok: true, status: "revoked" });
    expect((await sendTo(PRIYA)).verdict).toBe("ASK");
  });

  test("illegal transitions are refused", async () => {
    expect(await decideRule(graph, ruleId, "accept")).toMatchObject({ ok: false, code: 409 });
    expect(await decideRule(graph, "rule:nope", "accept")).toMatchObject({ ok: false, code: 404 });
  });

  test("after a revoke, it takes a fresh streak of approvals to propose again", async () => {
    for (let i = 1; i < APPROVALS_NEEDED; i++) {
      const r = await approveSend(PRIYA);
      expect(r.ok && r.proposedRule).toBeFalsy();
    }
    const r = await approveSend(PRIYA);
    expect(r.ok && r.proposedRule).toBeTruthy();
  });
});

describe("rejections reset the streak", () => {
  test("approve, approve, reject, approve, approve: no rule for Rahul", async () => {
    await approveSend(RAHUL);
    await approveSend(RAHUL);
    const rejected = await sendTo(RAHUL);
    await decide(graph, rejected.id, "rejected");
    const a = await approveSend(RAHUL);
    const b = await approveSend(RAHUL);
    expect(a.ok && a.proposedRule).toBeFalsy();
    expect(b.ok && b.proposedRule).toBeFalsy();
  });

  test("a third approval after the rejection proposes one", async () => {
    const r = await approveSend(RAHUL);
    expect(r.ok && r.proposedRule).toMatchObject({ description: "send email to Rahul Mehta" });
  });

  test("a declined proposal stays inactive", async () => {
    const rahul = (await listRules(graph)).find((r) => r.person === "Rahul Mehta")!;
    expect(await decideRule(graph, rahul.id, "decline")).toEqual({ ok: true, status: "declined" });
    expect((await sendTo(RAHUL)).verdict).toBe("ASK");
  });
});
