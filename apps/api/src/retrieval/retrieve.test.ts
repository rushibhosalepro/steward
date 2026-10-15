import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { proposeAction } from "../actions/actions";
import { graphFor } from "../db";
import { seedDemo } from "../seed/seed";
import { renderContext, retrieve, searchTerms } from "./retrieve";

const graph = graphFor("test_retrieve");
const PRIYA_REQUEST = "Prepare for tomorrow's meeting with Priya and send her the project update";

beforeAll(async () => {
  await seedDemo(graph);
  // Bookkeeping that must never leak into the Planner's context.
  await proposeAction(graph, { type: "send_email", to: "priya@northwind.example", derivedFrom: "user", subject: "Priya" });
});

afterAll(async () => {
  await graph.delete();
});

test("search terms drop stopwords and possessives", () => {
  expect(searchTerms(PRIYA_REQUEST)).toEqual(["meeting", "priya", "project", "update"]);
});

describe("the Priya request", () => {
  test("full-text finds Priya, her meeting and the Atlas update as entry points", async () => {
    const ctx = await retrieve(graph, PRIYA_REQUEST);
    const ids = ctx.entryPoints.map((e) => e.id);
    expect(ids).toContain("p:priya");
    expect(ids).toContain("m:priya-sync");
    expect(ids).toContain("d:atlas-update-v2");
  });

  test("expansion pulls in what the Planner needs, hops away from the entry points", async () => {
    const ctx = await retrieve(graph, PRIYA_REQUEST);
    const has = (from: string, rel: string, to: string) => ctx.edges.some((e) => e.from === from && e.rel === rel && e.to === to);
    expect(has("m:priya-sync", "WITH", "p:priya")).toBe(true);
    expect(has("m:priya-sync", "ABOUT", "pr:atlas")).toBe(true);
    expect(has("d:atlas-update-v2", "SUPERSEDES", "d:atlas-update-v1")).toBe(true);
    expect(has("c:priya-update", "ABOUT", "d:atlas-update-v2")).toBe(true);
    expect(has("msg:priya-1", "FROM", "p:priya")).toBe(true);
    expect(has("t:atlas-metrics", "BLOCKS", "t:atlas-update")).toBe(true);
  });

  test("the user, agents and Steward's own bookkeeping are never in the context", async () => {
    const ctx = await retrieve(graph, PRIYA_REQUEST);
    const labels = new Set(ctx.nodes.map((n) => n.label));
    for (const l of ["User", "Agent", "Action", "Approval", "Rule", "Request"]) expect(labels.has(l)).toBe(false);
  });

  test("the user's own profile and preferences come separately", async () => {
    const ctx = await retrieve(graph, PRIYA_REQUEST);
    expect(ctx.user).toEqual({ name: "Asha Rao", timezone: "Asia/Kolkata", preferences: [{ key: "no_meetings_before", value: "10:00" }] });
  });

  test("the rendered context lists nodes with ids and properties, then edges", async () => {
    const text = renderContext(await retrieve(graph, PRIYA_REQUEST));
    expect(text).toContain('[d:atlas-update-v2] Document "Atlas project update (v2)"');
    expect(text).toContain("sensitivity=restricted"); // the pricing sheet is in Atlas' neighbourhood, flagged
    expect(text).toContain("- m:priya-sync -WITH-> p:priya");
    expect(text).toContain("user preference: no_meetings_before = 10:00");
  });
});

describe("people are never crowded out", () => {
  test("Priya stays an entry point even when many Atlas tasks outscore her", async () => {
    for (let i = 0; i < 8; i++) {
      await graph.query("CREATE (:Entity:Task {id: $id, title: 'Atlas update sync task', status: 'open'})", { params: { id: `t:noise-${i}` } });
    }
    const ctx = await retrieve(graph, "Send Priya the Atlas update before our sync");
    expect(ctx.entryPoints.map((e) => e.id)).toContain("p:priya");
    await graph.query("MATCH (t:Task) WHERE t.id STARTS WITH 't:noise-' DELETE t");
  });
});

describe("requests about the inbox", () => {
  test("'go through my inbox' starts from the latest inbound mail, senders included", async () => {
    const ctx = await retrieve(graph, "Go through my inbox and do whatever people asked for");
    const ids = ctx.entryPoints.map((e) => e.id);
    expect(ids).toContain("msg:priya-1");
    expect(ids).toContain("msg:alex-1");
    expect(ctx.edges.some((e) => e.from === "msg:alex-1" && e.rel === "FROM" && e.to === "p:alex")).toBe(true);
  });
});

describe("edge cases", () => {
  test("stemming: 'price' finds the 'pricing' sheet", async () => {
    const ctx = await retrieve(graph, "what's the latest on the price sheet");
    expect(ctx.entryPoints.map((e) => e.id)).toContain("d:atlas-pricing");
  });

  test("nothing to search for returns an empty context, not an error", async () => {
    const ctx = await retrieve(graph, "can you do it please");
    expect(ctx.entryPoints).toEqual([]);
    expect(ctx.user?.name).toBe("Asha Rao");
  });

  test("another user's graph knows nothing about Priya", async () => {
    const other = graphFor("test_retrieve_other");
    await other.query("CREATE (:Entity:User {id: 'u:bob', name: 'Bob', timezone: 'UTC'})");
    await other.query("CREATE FULLTEXT INDEX FOR (e:Entity) ON (e.name, e.title, e.subject, e.what)");
    const ctx = await retrieve(other, PRIYA_REQUEST);
    expect(ctx.entryPoints).toEqual([]);
    await other.delete();
  });
});
