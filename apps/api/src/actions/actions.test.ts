import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { graphFor } from "../db";
import { seedDemo } from "../seed/seed";
import { decide, getAction, listInbox, proposeAction } from "./actions";

const graph = graphFor("test_actions");
const PRIYA = "priya@northwind.example";

beforeAll(async () => {
  await seedDemo(graph);
});

afterAll(async () => {
  await graph.delete();
});

const count = async (cypher: string, params: Record<string, string> = {}) =>
  (await graph.roQuery<{ c: number }>(cypher, { params })).data?.[0]?.c;

describe("the Priya flow, stored in the graph", () => {
  let id = "";

  test("an ASK becomes a pending Action wired to its source, target, docs and agents", async () => {
    const r = await proposeAction(graph, {
      type: "send_email", to: PRIYA, docs: ["d:atlas-update-v2"], derivedFrom: "msg:priya-1",
      subject: "Atlas update", body: "Hi Priya, attached is the latest update.",
    });
    id = r.id;
    expect(r.verdict).toBe("ASK");
    expect(r.status).toBe("pending");

    expect(await count("MATCH (:Action {id: $id})-[:DERIVED_FROM]->(:Message {id: 'msg:priya-1'}) RETURN count(*) AS c", { id })).toBe(1);
    expect(await count("MATCH (:Action {id: $id})-[:TARGETS]->(:Person {email: $to}) RETURN count(*) AS c", { id, to: PRIYA })).toBe(1);
    expect(await count("MATCH (:Action {id: $id})-[:USES]->(:Document {id: 'd:atlas-update-v2'}) RETURN count(*) AS c", { id })).toBe(1);
    expect(await count("MATCH (:Agent {id: 'a:planner'})-[:PROPOSED]->(:Action {id: $id}) RETURN count(*) AS c", { id })).toBe(1);
    expect(await count("MATCH (:Agent {id: 'a:sentinel'})-[:CHECKED {verdict: 'ASK'}]->(:Action {id: $id}) RETURN count(*) AS c", { id })).toBe(1);
  });

  test("it shows up in the inbox", async () => {
    const inbox = await listInbox(graph);
    const item = inbox.find((i) => i.id === id);
    expect(item?.target).toBe("Priya Nair");
    expect(item?.docs).toEqual(["Atlas project update (v2)"]);
  });

  test("the why panel gets the checks and the entities the verdict rests on", async () => {
    const a = await getAction(graph, id);
    expect(a?.checks.map((c) => c.check)).toContain("information_flow");
    const why = a!.justifiedBy.map((j) => `${j.check}:${j.label}:${j.name}`);
    expect(why).toContain("known_recipient:Person:Priya Nair");
    expect(why).toContain("information_flow:Document:Atlas project update (v2)");
    expect(why).toContain("information_flow:Project:Atlas");
    expect(why).toContain("provenance:Message:Before tomorrow");
    expect(a?.derivedFrom).toEqual({ label: "Message", text: "Before tomorrow" });
  });

  test("approving records an Approval and empties the inbox slot", async () => {
    const r = await decide(graph, id, "approved", "looks right");
    expect(r).toEqual({ ok: true, status: "approved" });
    expect(await count("MATCH (:Approval {decision: 'approved'})-[:ON]->(:Action {id: $id}) RETURN count(*) AS c", { id })).toBe(1);
    expect((await listInbox(graph)).find((i) => i.id === id)).toBeUndefined();
    expect((await getAction(graph, id))?.decisions[0]?.note).toBe("looks right");
  });

  test("an action can't be decided twice", async () => {
    const r = await decide(graph, id, "rejected");
    expect(r).toEqual({ ok: false, code: 409, error: "action is already approved" });
  });
});

describe("restraint", () => {
  test("a BLOCK is stored as blocked, never enters the inbox, and can't be approved", async () => {
    const r = await proposeAction(graph, {
      type: "send_email", to: "alex.chen@unknown.example", docs: ["d:atlas-pricing"], derivedFrom: "msg:alex-1",
    });
    expect(r.status).toBe("blocked");
    expect((await listInbox(graph)).find((i) => i.id === r.id)).toBeUndefined();
    expect(await decide(graph, r.id, "approved")).toEqual({ ok: false, code: 409, error: "blocked actions can't be approved" });
  });

  test("a user-typed request becomes a Request node the action derives from", async () => {
    const r = await proposeAction(graph, { type: "create_task", title: "Book Goa flights", derivedFrom: "user", request: "remind me to book flights" });
    expect(r.status).toBe("ready");
    const a = await getAction(graph, r.id);
    expect(a?.derivedFrom).toEqual({ label: "Request", text: "remind me to book flights" });
  });

  test("rejecting works and unknown ids are 404", async () => {
    const r = await proposeAction(graph, { type: "send_email", to: "someone@new.example", derivedFrom: "user" });
    expect(await decide(graph, r.id, "rejected")).toEqual({ ok: true, status: "rejected" });
    expect(await decide(graph, "act:nope", "approved")).toEqual({ ok: false, code: 404, error: "no such action" });
  });
});
