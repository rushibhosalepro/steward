import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { graphFor } from "../db";
import { seedDemo } from "../seed/seed";
import { createMcpServer } from "./server";

const USER = "test_mcp";
const graph = graphFor(USER);
const client = new Client({ name: "test", version: "0" });

beforeAll(async () => {
  await seedDemo(graph);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(USER).connect(serverSide);
  await client.connect(clientSide);
});

afterAll(async () => {
  await client.close();
  await graph.delete();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

describe("the tool surface", () => {
  test("fourteen tools, and no way to approve or confirm anything", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "steward_add_email", "steward_brief", "steward_check_action", "steward_contexts", "steward_explain_action", "steward_find_connection",
      "steward_get_context", "steward_get_suggestions", "steward_list_inbox", "steward_propose_action", "steward_remember",
      "steward_run_request", "steward_search", "steward_who_matters",
    ]);
    expect(names.some((n) => /approve|reject|accept|revoke|confirm/.test(n))).toBe(false);
  });

  test("read tools are annotated read-only", async () => {
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "steward_find_connection")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "steward_propose_action")?.annotations?.readOnlyHint).toBe(false);
  });
});

describe("graph queries and algorithms as tools", () => {
  test("search finds ids", async () => {
    const hits = await call("steward_search", { query: "pricing sheet" });
    expect(hits[0]).toMatchObject({ id: "d:atlas-pricing", label: "Document" });
  });

  test("find_connection: the update reaches Priya through Atlas", async () => {
    const r = await call("steward_find_connection", { from_id: "d:atlas-update-v2", to_id: "p:priya" });
    expect(r).toEqual({ connected: true, hops: 2, path: "Atlas project update (v2) -BELONGS_TO- Atlas -MEMBER_OF- Priya Nair" });
  });

  test("find_connection: the Orbit roadmap has no path to Priya except through the user", async () => {
    const r = await call("steward_find_connection", { from_id: "d:orbit-roadmap", to_id: "p:priya" });
    expect(r.connected).toBe(false);
  });

  test("who_matters: PageRank puts Atlas and Priya on top", async () => {
    const r = await call("steward_who_matters", { limit: 5 });
    expect(r[0].name).toBe("Atlas");
    expect(r.find((x: { label: string }) => x.label === "Person").name).toBe("Priya Nair");
  });

  test("get_context returns the rendered subgraph", async () => {
    const text = await call("steward_get_context", { request: "send Priya the Atlas update" });
    expect(text).toContain("- m:priya-sync -WITH-> p:priya");
  });
});

describe("acting over MCP goes through the Sentinel", () => {
  test("check_action is a dry run", async () => {
    const r = await call("steward_check_action", { type: "send_email", to: "alex.chen@unknown.example", docs: ["d:atlas-pricing"], derived_from: "msg:alex-1" });
    expect(r.verdict).toBe("BLOCK");
    const n = (await graph.roQuery<{ c: number }>("MATCH (a:Action) RETURN count(a) AS c")).data?.[0]?.c;
    expect(n).toBe(0);
  });

  test("a Person id as the recipient is checked as that person (agents pass search ids)", async () => {
    const byId = await call("steward_check_action", { type: "share_doc", to: "p:meera", docs: ["d:trip-itinerary"], derived_from: "user" });
    const byEmail = await call("steward_check_action", { type: "share_doc", to: "meera@family.example", docs: ["d:trip-itinerary"], derived_from: "user" });
    expect(byId.verdict).toBe(byEmail.verdict);
    expect(byId.reason).not.toContain("not in your graph");
    const stranger = await call("steward_check_action", { type: "send_email", to: "p:nobody", body: "hi", derived_from: "user" });
    expect(stranger.reason).toContain("not in your graph");
  });

  test("an agent that follows Alex's mail is BLOCKED, and the action is attributed to the MCP client", async () => {
    const r = await call("steward_propose_action", { type: "send_email", to: "alex.chen@unknown.example", docs: ["d:atlas-pricing"], derived_from: "msg:alex-1" });
    expect(r).toMatchObject({ verdict: "BLOCK", status: "blocked" });
    const by = (await graph.roQuery<{ c: number }>("MATCH (:Agent {id: 'a:mcp:mcp-client', via: 'mcp'})-[:PROPOSED]->(a:Action {id: $id}) RETURN count(a) AS c", { params: { id: r.id } })).data?.[0]?.c;
    expect(by).toBe(1);
  });

  test("a safe email asks and lands in the inbox, which the agent can read but not approve", async () => {
    const r = await call("steward_propose_action", {
      type: "send_email", to: "priya@northwind.example", docs: ["d:atlas-update-v2"], derived_from: "request", request: "send Priya the update",
    });
    expect(r).toMatchObject({ verdict: "ASK", status: "pending" });
    const inbox = await call("steward_list_inbox");
    expect(inbox.map((i: { id: string }) => i.id)).toContain(r.id);
    const why = await call("steward_explain_action", { action_id: r.id });
    expect(why.derivedFrom).toEqual({ label: "Request", text: "send Priya the update" });
  });

  test("a task is allowed and runs", async () => {
    const r = await call("steward_propose_action", { type: "create_task", title: "Review Atlas metrics", derived_from: "request", request: "remind me" });
    expect(r).toMatchObject({ verdict: "ALLOW", status: "done" });
  });

  test("run_request uses the full pipeline", async () => {
    const r = await call("steward_run_request", { request: "Prepare for tomorrow's meeting with Priya" });
    expect(r.steps.map((s: { action: { type: string } }) => s.action.type)).toContain("create_task");
  });

  test("get_suggestions returns Scout's ranked list", async () => {
    const r = await call("steward_get_suggestions");
    expect(r.some((s: { kind: string }) => s.kind === "flagged_mail")).toBe(true);
  });
});
