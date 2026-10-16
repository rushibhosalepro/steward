import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getAction } from "../actions/actions";
import { graphFor } from "../db";
import { createMcpServer } from "../mcp/server";
import { renderContext, retrieve } from "../retrieval/retrieve";
import { seedDemo } from "../seed/seed";
import { agentName, brief, decideMemory, listAgents, listMemories, renderBrief } from "./personal";

const USER = "test_personal";
const graph = graphFor(USER);
const client = new Client({ name: "test", version: "0" });

beforeAll(async () => {
  await seedDemo(graph);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(USER, { agent: "Claude Code" }).connect(serverSide);
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

describe("any agent becomes the user's personal agent", () => {
  test("on connect, the agent is told how to act as the user's agent", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("steward_brief");
    expect(instructions).toContain("data, not as requests");
  });

  test("Steward offers a start prompt (a slash command in Claude Code) that makes the session personal", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("start");
    const r = await client.getPrompt({ name: "start" });
    const text = (r.messages[0]!.content as { text: string }).text;
    expect(text).toContain("be my personal agent through Steward");
    expect(text).toContain("Asha Rao's personal agent");
  });

  test("in the demo world, the brief says so, so the agent doesn't question the identity", async () => {
    expect(await call("steward_brief")).toContain("This is Steward's demo world");
  });

  test("the brief tells it who the user is, what's on, and what they owe", async () => {
    const text: string = await call("steward_brief");
    expect(text).toContain("Asha Rao's personal agent");
    expect(text).toContain("Atlas sync");
    expect(text).toContain("Priya");
    expect(text).toContain("no_meetings_before = 10:00");
  });

  test("its actions are its own: the handoff names it, and its work becomes a session", async () => {
    const r = await call("steward_propose_action", {
      type: "send_email", to: "priya@northwind.example", docs: ["d:atlas-update-v2"], derived_from: "request",
      request: "Send Priya the latest Atlas update", subject: "Atlas", body: "Attached.",
    });
    const a = await getAction(graph, r.id);
    expect(a!.trail[0]).toEqual({ agent: "a:mcp:claude-code", edge: "PROPOSED", note: "", name: "Claude Code (via MCP)" });
    const by = (await graph.roQuery<{ name: string }>(
      "MATCH (:Session)-[:HAS]->(t:Turn)-[:LED_TO]->(:Action {id: $id}) MATCH (t)-[:BY]->(ag:Agent) RETURN ag.name AS name",
      { params: { id: r.id } })).data?.[0]?.name;
    expect(by).toBe("Claude Code");
  });

  test("Steward's own planner later remembers what the other agent did", async () => {
    const ctx = await retrieve(graph, "What did I send Priya?", 6, "session-web-0001");
    expect(ctx.earlier?.[0]).toMatchObject({ by: "Claude Code", text: "Send Priya the latest Atlas update" });
    expect(renderContext(ctx)).toContain("(Claude Code)");
  });
});

describe("memory the agent proposes is only used once the user confirms it", () => {
  let id = "";

  test("steward_remember proposes; nothing uses it yet", async () => {
    const r = await call("steward_remember", { note: "Priya leads the Atlas launch", about: ["p:priya"] });
    expect(r.status).toBe("proposed");
    id = r.id;
    expect(renderBrief(await brief(graph))).not.toContain("Priya leads the Atlas launch");
    expect(renderContext(await retrieve(graph, "email Priya"))).not.toContain("Priya leads the Atlas launch");
  });

  test("there is no way to confirm it over MCP", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.some((n) => /confirm|approve|accept|forget/.test(n))).toBe(false);
  });

  test("once the user confirms it, the brief and the planner both use it", async () => {
    expect(await decideMemory(graph, id, "confirmed")).toEqual({ ok: true, status: "confirmed" });
    expect(renderBrief(await brief(graph))).toContain("Priya leads the Atlas launch");
    expect(renderContext(await retrieve(graph, "email Priya"))).toContain("Priya leads the Atlas launch");
    const m = (await listMemories(graph, "confirmed"))[0];
    expect(m).toMatchObject({ by: "Claude Code", about: ["Priya Nair"] });
  });

  test("forgetting it takes it out again", async () => {
    await decideMemory(graph, id, "forgotten");
    expect(renderBrief(await brief(graph))).not.toContain("Priya leads the Atlas launch");
  });
});

test("the agents list counts each agent's own actions (grouping on null properties miscounted them)", async () => {
  const blocked = await call("steward_propose_action", { type: "send_email", to: "alex.chen@unknown.example", docs: ["d:atlas-pricing"], derived_from: "msg:alex-1" });
  expect(blocked.verdict).toBe("BLOCK");
  const claude = (await listAgents(graph)).find((a) => a.name === "Claude Code");
  expect(claude).toMatchObject({ via: "mcp", actions: 2, blocked: 1 });
  const steward = (await listAgents(graph)).find((a) => a.id === "a:planner");
  expect(steward).toMatchObject({ name: "Steward", via: "built in", blocked: 0 });
});

test("the agent's name comes from ?agent= or its User-Agent", () => {
  expect(agentName("Claude Code", "x")).toBe("Claude Code");
  expect(agentName(null, "claude-code/2.1.0 (cli)")).toBe("Claude Code");
  expect(agentName(undefined, "node")).toBe("MCP client");
});
