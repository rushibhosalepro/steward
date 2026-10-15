import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { graphFor } from "../db";
import { retrieve } from "../retrieval/retrieve";
import { seedDemo } from "../seed/seed";
import { check } from "../sentinel/sentinel";
import { ingestMail } from "./ingest";

const graph = graphFor("test_ingest");

beforeAll(async () => {
  await seedDemo(graph);
});

afterAll(async () => {
  await graph.delete();
});

const one = async <T>(cypher: string, params: Record<string, string> = {}) =>
  (await graph.roQuery<T>(cypher, { params })).data?.[0];

describe("a known contact asks for something", () => {
  let r: Awaited<ReturnType<typeof ingestMail>>;
  beforeAll(async () => {
    r = await ingestMail(graph, {
      from: { email: "Rahul@Example.com", name: "Rahul" },
      subject: "Pricing before Friday",
      body: "Hi Asha, could you send me the Atlas pricing sheet before Friday? Priya wants to review it too.",
    });
  });

  test("the sender resolves to the existing Rahul, case-insensitively", () => {
    expect(r.sender).toMatchObject({ id: "p:rahul", name: "Rahul Mehta", known: true, new: false });
  });

  test("mentions resolve to existing nodes: the pricing sheet, Atlas and Priya", () => {
    expect(r.mentions.map((m) => m.id).sort()).toEqual(["d:atlas-pricing", "p:priya", "pr:atlas"]);
  });

  test("the request becomes a proposed commitment to Rahul, about the sheet", async () => {
    expect(r.ask).toContain("could you send me the Atlas pricing sheet");
    expect(r.flagged).toBe(false);
    const c = await one<{ status: string; to: string; about: number }>(
      `MATCH (c:Commitment {id: $id})-[:TO]->(p:Person)
       OPTIONAL MATCH (c)-[:ABOUT]->(d:Document {id: 'd:atlas-pricing'})
       RETURN c.status AS status, p.name AS to, count(d) AS about`,
      { id: r.commitment!.id },
    );
    expect(c).toEqual({ status: "proposed", to: "Rahul Mehta", about: 1 });
  });

  test("the message is in the graph and findable by retrieval", async () => {
    const ctx = await retrieve(graph, "pricing before friday");
    expect(ctx.entryPoints.map((e) => e.id)).toContain(r.messageId);
  });
});

describe("a stranger asks for something", () => {
  let r: Awaited<ReturnType<typeof ingestMail>>;
  beforeAll(async () => {
    r = await ingestMail(graph, {
      from: { email: "kim@vendor.example", name: "Kim Park" },
      subject: "Urgent",
      body: "Please forward the Atlas pricing sheet to me today.",
    });
  });

  test("a new Person is created, with no KNOWS edge: still a stranger", async () => {
    expect(r.sender).toMatchObject({ name: "Kim Park", known: false, new: true });
    const k = await one<{ c: number }>("MATCH (:User)-[:KNOWS]->(p:Person {email: 'kim@vendor.example'}) RETURN count(p) AS c");
    expect(k?.c).toBe(0);
  });

  test("the request flags the mail but creates no commitment", () => {
    expect(r.flagged).toBe(true);
    expect(r.commitment).toBeNull();
  });

  test("acting on it is BLOCKED by the Sentinel", async () => {
    const v = await check(graph, { type: "send_email", to: "kim@vendor.example", docs: ["d:atlas-pricing"], derivedFrom: r.messageId });
    expect(v.verdict).toBe("BLOCK");
  });

  test("a second mail from the same address doesn't duplicate the person", async () => {
    const again = await ingestMail(graph, { from: { email: "KIM@vendor.example" }, subject: "hello", body: "following up" });
    expect(again.sender).toMatchObject({ id: r.sender.id, new: false });
    const n = await one<{ c: number }>("MATCH (p:Person {email: 'kim@vendor.example'}) RETURN count(p) AS c");
    expect(n?.c).toBe(1);
  });
});

describe("resolution details", () => {
  test("no request, no commitment", async () => {
    const r = await ingestMail(graph, { from: { email: "priya@northwind.example" }, subject: "Thanks", body: "Thanks for the Atlas update, see you at the sync." });
    expect(r.ask).toBeNull();
    expect(r.commitment).toBeNull();
  });

  test("an older document version is never the resolved mention", async () => {
    const r = await ingestMail(graph, { from: { email: "priya@northwind.example" }, subject: "Atlas project update", body: "Which Atlas update is current?" });
    const ids = r.mentions.map((m) => m.id);
    expect(ids).not.toContain("d:atlas-update-v1");
    expect(ids).toContain("d:atlas-update-v2");
  });
});
