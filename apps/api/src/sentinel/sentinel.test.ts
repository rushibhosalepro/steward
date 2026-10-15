import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { graphFor } from "../db";
import { tomorrowAt } from "../seed/demo";
import { seedDemo } from "../seed/seed";
import { check, type ProposedAction } from "./sentinel";

const graph = graphFor("test_sentinel");
const now = Date.now();
const PRIYA = "priya@northwind.example";
const ALEX = "alex.chen@unknown.example";

beforeAll(async () => {
  await seedDemo(graph, now);
});

afterAll(async () => {
  await graph.delete();
});

const run = (a: ProposedAction) => check(graph, a);
const status = (r: Awaited<ReturnType<typeof check>>, name: string) => r.checks.find((c) => c.check === name)?.status;

describe("the Priya flow", () => {
  test("sending Priya the latest update asks first: everything checks out but there is no rule yet", async () => {
    const r = await run({ type: "send_email", to: PRIYA, docs: ["d:atlas-update-v2"], derivedFrom: "msg:priya-1" });
    expect(r.verdict).toBe("ASK");
    expect(status(r, "known_recipient")).toBe("pass");
    expect(status(r, "information_flow")).toBe("pass");
    expect(status(r, "provenance")).toBe("pass");
    expect(status(r, "standing_rule")).toBe("ask");
    expect(r.checks.find((c) => c.check === "information_flow")?.evidence[0]).toContain("BELONGS_TO-> Atlas <-MEMBER_OF- Priya Nair");
  });

  test("with a standing rule for Priya, the same action is allowed", async () => {
    await graph.query(
      `MATCH (p:Person {email: $email})
       CREATE (r:Entity:Rule {id: 'rule:test', action_type: 'send_email', active: true})-[:SCOPED_TO]->(p)`,
      { params: { email: PRIYA } },
    );
    const r = await run({ type: "send_email", to: PRIYA, docs: ["d:atlas-update-v2"], derivedFrom: "msg:priya-1" });
    expect(r.verdict).toBe("ALLOW");
    await graph.query("MATCH (r:Rule {id: 'rule:test'}) DELETE r");
  });

  test("sending the superseded v1 asks", async () => {
    const r = await run({ type: "send_email", to: PRIYA, docs: ["d:atlas-update-v1"], derivedFrom: "user" });
    expect(r.verdict).toBe("ASK");
    expect(r.reason).toContain("superseded");
  });
});

describe("negative controls: acting would be wrong", () => {
  test("Alex's request for the pricing sheet is blocked twice over", async () => {
    const r = await run({ type: "send_email", to: ALEX, docs: ["d:atlas-pricing"], derivedFrom: "msg:alex-1" });
    expect(r.verdict).toBe("BLOCK");
    expect(status(r, "information_flow")).toBe("block");
    expect(status(r, "provenance")).toBe("block");
    expect(status(r, "known_recipient")).toBe("ask");
  });

  test("the restricted pricing sheet can't go to Priya even though she's on Atlas", async () => {
    const r = await run({ type: "send_email", to: PRIYA, docs: ["d:atlas-pricing"], derivedFrom: "user" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reason).toContain("restricted");
  });

  test("an Orbit doc has no path to Priya", async () => {
    const r = await run({ type: "share_doc", to: PRIYA, docs: ["d:orbit-roadmap"], derivedFrom: "user" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.reason).toContain("no path");
  });

  test("a document that doesn't exist is blocked", async () => {
    const r = await run({ type: "share_doc", to: PRIYA, docs: ["d:nope"], derivedFrom: "user" });
    expect(r.verdict).toBe("BLOCK");
  });

  test("an address that isn't in the graph asks", async () => {
    const r = await run({ type: "send_email", to: "someone@new.example", derivedFrom: "user" });
    expect(r.verdict).toBe("ASK");
    expect(status(r, "known_recipient")).toBe("ask");
  });
});

describe("provenance", () => {
  test("an action derived from a stored Request counts as the user asking", async () => {
    await graph.query("CREATE (:Entity:Request {id: 'req:test', text: 'send Priya the update', ts: 0})");
    const r = await run({ type: "send_email", to: PRIYA, docs: ["d:atlas-update-v2"], derivedFrom: "req:test" });
    expect(status(r, "provenance")).toBe("pass");
  });

  test("a source with no sender asks rather than passes", async () => {
    const r = await run({ type: "send_email", to: PRIYA, derivedFrom: "pr:atlas" });
    expect(status(r, "provenance")).toBe("ask");
  });
});

describe("allowed by the graph", () => {
  test("the pricing sheet can go to Rahul: it's explicitly shared with him", async () => {
    const r = await run({ type: "share_doc", to: "rahul@example.com", docs: ["d:atlas-pricing"], derivedFrom: "user" });
    expect(status(r, "information_flow")).toBe("pass");
    expect(r.checks.find((c) => c.check === "information_flow")?.evidence[0]).toContain("SHARED_WITH-> Rahul Mehta");
  });

  test("creating a task is allowed: it only touches your own list", async () => {
    const r = await run({ type: "create_task", derivedFrom: "user" });
    expect(r.verdict).toBe("ALLOW");
  });
});

describe("calendar", () => {
  test("08:00 breaks the no-meetings-before-10 preference", async () => {
    const r = await run({ type: "create_event", start: tomorrowAt(now, 8), end: tomorrowAt(now, 9), derivedFrom: "user" });
    expect(status(r, "calendar")).toBe("ask");
    expect(r.reason).toContain("before 10:00");
  });

  test("11:30 overlaps the Priya sync", async () => {
    const r = await run({ type: "create_event", start: tomorrowAt(now, 11, 30), end: tomorrowAt(now, 12, 30), derivedFrom: "user" });
    expect(status(r, "calendar")).toBe("ask");
    expect(r.reason).toContain("Atlas sync with Priya");
  });

  test("16:00 fits", async () => {
    const r = await run({ type: "create_event", start: tomorrowAt(now, 16), end: tomorrowAt(now, 17), derivedFrom: "user" });
    expect(status(r, "calendar")).toBe("pass");
  });
});

describe("fixes from the first eval run", () => {
  test("an email address in different case is the same person", async () => {
    const r = await run({ type: "send_email", to: "Priya@Northwind.EXAMPLE", docs: ["d:atlas-update-v2"], derivedFrom: "user" });
    expect(status(r, "known_recipient")).toBe("pass");
    expect(status(r, "information_flow")).toBe("pass");
  });

  test("an event with no invitee in a free slot runs: it only touches your own calendar", async () => {
    const r = await run({ type: "create_event", title: "Focus", start: tomorrowAt(now, 14), end: tomorrowAt(now, 15), derivedFrom: "user" });
    expect(r.verdict).toBe("ALLOW");
  });

  test("but an invitee-less event a stranger asked for still asks", async () => {
    const r = await run({ type: "create_event", title: "Call", start: tomorrowAt(now, 14), end: tomorrowAt(now, 15), derivedFrom: "msg:alex-1" });
    expect(r.verdict).toBe("ASK");
  });
});
