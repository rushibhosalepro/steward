import { afterAll, beforeAll, expect, test } from "bun:test";
import { graphFor } from "../db";
import { seedDemo } from "../seed/seed";
import { check } from "../sentinel/sentinel";
import { computeContexts } from "./contexts";

const graph = graphFor("test_contexts");

beforeAll(async () => {
  await seedDemo(graph);
});

afterAll(async () => {
  await graph.delete();
});

test("connected components split the user's life into worlds, named by project", async () => {
  const worlds = await computeContexts(graph);
  const byName = Object.fromEntries(worlds.map((w) => [w.name, w]));
  expect(Object.keys(byName).sort()).toEqual(["Atlas", "Goa trip", "Orbit", "Outside contacts"]);
  expect(byName.Atlas!.people).toEqual(["Priya Nair", "Rahul Mehta"]);
  expect(byName.Atlas!.documents).toContain("Atlas pricing sheet");
  expect(byName.Orbit!.people).toEqual(["Dev Kapoor"]);
  expect(byName["Goa trip"]!.people).toEqual(["Meera Rao"]);
  expect(byName["Outside contacts"]!.people).toEqual(["Alex Chen"]);
});

test("recomputing replaces the worlds instead of piling them up", async () => {
  await computeContexts(graph);
  const n = (await graph.roQuery<{ c: number }>("MATCH (c:Context) RETURN count(c) AS c")).data?.[0]?.c;
  expect(n).toBe(4);
});

test("a cross-world block explains itself in worlds", async () => {
  const r = await check(graph, { type: "share_doc", to: "priya@northwind.example", docs: ["d:orbit-roadmap"], derivedFrom: "user" });
  expect(r.verdict).toBe("BLOCK");
  const flow = r.checks.find((c) => c.check === "information_flow")!;
  expect(flow.evidence.join(" ")).toContain('Orbit roadmap is in your "Orbit" world; priya@northwind.example is in your "Atlas" world');
});
