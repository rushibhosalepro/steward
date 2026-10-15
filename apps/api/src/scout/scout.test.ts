import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decide } from "../actions/actions";
import { graphFor } from "../db";
import { ingestMail } from "../ingest/ingest";
import { OfflinePlanner } from "../planner/offline";
import { planRequest } from "../planner/plan";
import { seedDemo } from "../seed/seed";
import { decideSuggestion, runScout, type Suggestion } from "./scout";

const graph = graphFor("test_scout");
const planner = new OfflinePlanner();

beforeAll(async () => {
  await seedDemo(graph);
});

afterAll(async () => {
  await graph.delete();
});

const byKind = (list: Suggestion[], kind: string) => list.filter((s) => s.kind === kind);
const count = async (cypher: string) => (await graph.roQuery<{ c: number }>(cypher)).data?.[0]?.c ?? 0;

describe("on the demo world", () => {
  let list: Suggestion[];
  beforeAll(async () => {
    list = await runScout(graph);
  });

  test("finds what Asha would want to know, without being asked", () => {
    expect(byKind(list, "commitment_due").map((s) => s.refs)).toContainEqual(expect.arrayContaining(["c:priya-update", "p:priya"]));
    expect(byKind(list, "meeting_prep").map((s) => s.text).join(" ")).toContain("Atlas sync with Priya");
    expect(byKind(list, "blocked_task")[0]?.text).toContain("blocked by “Finalise Atlas metrics”");
    expect(byKind(list, "flagged_mail")[0]?.text).toContain("Alex Chen");
  });

  test("Priya's mail isn't 'awaiting reply': her open commitment already covers it", () => {
    expect(byKind(list, "awaiting_reply").find((s) => s.refs.includes("p:priya"))).toBeUndefined();
  });

  test("ranking uses PageRank: Priya is the most central person, and it says so", () => {
    const due = byKind(list, "commitment_due").find((s) => s.refs.includes("p:priya"))!;
    expect(due.why).toContain("#1 of");
    const scores = list.map((s) => s.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test("Scout only suggests: it creates no actions", async () => {
    expect(await count("MATCH (a:Action) RETURN count(a) AS c")).toBe(0);
    expect(await count("MATCH (:Agent {id: 'a:scout'})-[:SUGGESTED]->(s:Suggestion) RETURN count(s) AS c")).toBe(list.length);
  });

  test("running again doesn't duplicate suggestions", async () => {
    const again = await runScout(graph);
    expect(again.length).toBe(list.length);
    expect(await count("MATCH (s:Suggestion) RETURN count(s) AS c")).toBe(list.length);
  });
});

describe("suggestions resolve when the graph changes", () => {
  test("doing the meeting prep resolves it", async () => {
    const prep = byKind(await runScout(graph), "meeting_prep").find((s) => s.text.includes("Priya"))!;
    expect(prep.request).toBe("Prepare for the meeting with Priya");
    await planRequest(graph, prep.request!, planner);
    const after = await runScout(graph);
    expect(byKind(after, "meeting_prep").find((s) => s.text.includes("Priya"))).toBeUndefined();
  });

  test("doing the commitment (Planner -> Sentinel -> approve) resolves it", async () => {
    const due = byKind(await runScout(graph), "commitment_due").find((s) => s.refs.includes("p:priya"))!;
    const plan = await planRequest(graph, due.request!, planner);
    const email = plan.steps.find((s) => s.action.type === "send_email")!;
    expect(email.verdict).toBe("ASK");
    await decide(graph, email.action.id, "approved");
    const { executeAction } = await import("../executor/executor");
    await executeAction(graph, email.action.id);
    const after = await runScout(graph);
    expect(after.find((s) => s.refs.includes("c:priya-update"))).toBeUndefined();
  });

  test("a dismissed suggestion stays dismissed", async () => {
    const blocked = byKind(await runScout(graph), "blocked_task")[0]!;
    expect(await decideSuggestion(graph, blocked.id, "dismiss")).toEqual({ ok: true });
    expect(byKind(await runScout(graph), "blocked_task")).toHaveLength(0);
  });
});

describe("from new mail", () => {
  test("a contact's request becomes a 'take it on?' suggestion; accepting opens the commitment", async () => {
    await ingestMail(graph, { from: { email: "rahul@example.com" }, subject: "Pricing", body: "Could you send me the Atlas pricing sheet?" });
    const proposed = byKind(await runScout(graph), "commitment_proposed")[0]!;
    expect(proposed.text).toContain("Rahul Mehta asked");
    expect(await decideSuggestion(graph, proposed.id, "accept")).toEqual({ ok: true });
    const after = await runScout(graph);
    expect(byKind(after, "commitment_due").some((s) => s.text.includes("Rahul"))).toBe(true);
  });

  test("a contact waiting on a reply shows up, and a sent reply clears it", async () => {
    await ingestMail(graph, { from: { email: "dev@orbit.example" }, subject: "Orbit notes", body: "Thanks for the notes on the roadmap." });
    expect(byKind(await runScout(graph), "awaiting_reply").some((s) => s.text.includes("Dev Kapoor"))).toBe(true);

    const plan = await planRequest(graph, "email Dev the Orbit roadmap", planner);
    const email = plan.steps[0]!;
    await decide(graph, email.action.id, "approved");
    const { executeAction } = await import("../executor/executor");
    await executeAction(graph, email.action.id);
    expect(byKind(await runScout(graph), "awaiting_reply").some((s) => s.text.includes("Dev Kapoor"))).toBe(false);
  });

  test("only proposed commitments can be accepted", async () => {
    const flagged = byKind(await runScout(graph), "flagged_mail")[0]!;
    expect(await decideSuggestion(graph, flagged.id, "accept")).toMatchObject({ ok: false });
  });
});
