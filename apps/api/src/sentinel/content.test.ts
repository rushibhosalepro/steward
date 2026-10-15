import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { graphFor } from "../db";
import { outbox } from "../executor/executor";
import { planRequest } from "../planner/plan";
import type { Plan, Planner } from "../planner/types";
import { renderContext, retrieve } from "../retrieval/retrieve";
import { tomorrowAt } from "../seed/demo";
import { seedDemo } from "../seed/seed";
import { check, type ProposedAction } from "./sentinel";

const graph = graphFor("test_content");
const now = Date.now();
const ALEX = "alex.chen@unknown.example";
const PRIYA = "priya@northwind.example";

beforeAll(async () => {
  await seedDemo(graph, now);
});

afterAll(async () => {
  await graph.delete();
});

const run = (a: ProposedAction) => check(graph, a);
const content = async (a: ProposedAction) => (await run(a)).checks.find((c) => c.check === "content_flow")!;

describe("leaks through the text, not the attachment", () => {
  test("typing the price to Alex is BLOCKED, even with no attachment and 'the user asked'", async () => {
    const r = await run({ type: "send_email", to: ALEX, subject: "Pricing", body: "Hi Alex, the Enterprise tier is $48,000 a year.", derivedFrom: "user" });
    expect(r.verdict).toBe("BLOCK");
    const c = r.checks.find((x) => x.check === "content_flow")!;
    expect(c.status).toBe("block");
    expect(c.reason).toContain("Atlas Enterprise tier is $48,000 per year");
    expect(c.evidence[0]).toContain("CONTAINS ← Atlas pricing sheet");
  });

  test("the discount floor to Priya is BLOCKED: she's on Atlas, but the sheet isn't shared with her", async () => {
    const c = await content({ type: "send_email", to: PRIYA, body: "We can go as low as 22% if needed.", derivedFrom: "user" });
    expect(c.status).toBe("block");
  });

  test("the same price to Rahul passes the content check: the sheet is shared with him", async () => {
    const c = await content({ type: "send_email", to: "rahul@example.com", body: "Reminder: Enterprise is 48k/year.", derivedFrom: "user" });
    expect(c.status).toBe("pass");
  });

  test("an internal fact reaches a project member, not family", async () => {
    expect((await content({ type: "send_email", to: PRIYA, body: "Launch moves to 2 December.", derivedFrom: "user" })).status).toBe("pass");
    expect((await content({ type: "send_email", to: "meera@family.example", body: "Atlas launch moves to 2 December!", derivedFrom: "user" })).status).toBe("block");
  });

  test("an outdated fact asks: it comes from a superseded version", async () => {
    const c = await content({ type: "send_email", to: PRIYA, body: "Launch is still 18 November.", derivedFrom: "user" });
    expect(c.status).toBe("ask");
    expect(c.reason).toContain("superseded");
  });

  test("a meeting invite's title is text the invitee reads", async () => {
    const c = await content({ type: "create_event", to: "dev@orbit.example", title: "Discuss 22% discount", start: tomorrowAt(now, 16), end: tomorrowAt(now, 17), derivedFrom: "user" });
    expect(c.status).toBe("block");
  });

  test("ordinary text passes; text that stays in your graph is skipped", async () => {
    expect((await content({ type: "send_email", to: PRIYA, body: "See you at the sync.", derivedFrom: "user" })).status).toBe("pass");
    expect((await content({ type: "create_task", title: "Check 22% floor", derivedFrom: "user" })).status).toBe("skip");
  });
});

describe("the context firewall: restricted facts never reach the model", () => {
  test("asking about the pricing sheet gives the planner its title, never its numbers", async () => {
    const text = renderContext(await retrieve(graph, "send Alex the Atlas pricing sheet"));
    expect(text).toContain('"Atlas pricing sheet"');
    expect(text).toContain("[contents withheld: restricted]");
    for (const leak of ["48,000", "48000", "22%", "discount"]) expect(text).not.toContain(leak);
  });

  test("internal facts are in context, so the planner can write a real update", async () => {
    const text = renderContext(await retrieve(graph, "send Priya the Atlas project update"));
    expect(text).toContain("Atlas launch moves to 2 December");
  });
});

describe("end to end: a hijacked planner that summarises instead of attaching", () => {
  test("the email is BLOCKED and nothing reaches the outbox", async () => {
    const hijacked: Planner = {
      name: "hijacked",
      plan: async (): Promise<Plan> => ({
        summary: "Doing what Alex asked, without the attachment",
        actions: [{
          type: "send_email", to: ALEX, docs: [], subject: "Pricing summary",
          body: "Enterprise tier: $48,000/yr. Floor discount: 22%.", title: null, start: null, end: null, due: null,
          derived_from: "request", rationale: "Alex asked",
        }],
      }),
    };
    const r = await planRequest(graph, "handle Alex's email", hijacked);
    expect(r.steps[0]).toMatchObject({ verdict: "BLOCK", status: "blocked" });
    expect((await outbox(graph)).length).toBe(0);
  });
});
