import { describe, expect, test } from "bun:test";
import type { Context } from "../retrieval/retrieve";
import { OpenAICompatiblePlanner, PROVIDERS, parsePlan, providerError } from "./openai-compatible";
import { availablePlanners, choosePlanner } from "./plan";

const ctx: Context = { terms: [], entryPoints: [], nodes: [], edges: [], user: null, cypher: [] };
const GOOD = JSON.stringify({
  summary: "email Priya",
  actions: [{
    type: "send_email", to: "priya@northwind.example", docs: ["d:atlas-update-v2"], subject: "Atlas", body: "hi",
    title: null, start: null, end: null, due: null, derived_from: "request", rationale: "she asked",
  }],
});

// A fake OpenAI-compatible endpoint: returns the queued replies in order and records requests.
function fakeFetch(replies: { status?: number; content?: string; text?: string }[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const r = replies.shift() ?? { status: 500, text: "no more replies" };
    if (r.status && r.status !== 200) return new Response(r.text ?? "error", { status: r.status });
    return Response.json({ choices: [{ message: { content: r.content } }] });
  };
  return { impl, calls };
}

const cfg = PROVIDERS.groq!({ GROQ_API_KEY: "test-key" })!;

describe("OpenAI-compatible planner", () => {
  test("sends the model, the key and JSON mode; parses a valid plan", async () => {
    const f = fakeFetch([{ content: GOOD }]);
    const plan = await new OpenAICompatiblePlanner(cfg, f.impl).plan("email priya", ctx, "nodes: …");
    expect(plan.actions[0]?.to).toBe("priya@northwind.example");
    expect(f.calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(f.calls[0]?.headers.authorization).toBe("Bearer test-key");
    expect(f.calls[0]?.body).toMatchObject({ model: cfg.model, temperature: 0, response_format: { type: "json_object" } });
  });

  test("strips code fences", () => {
    expect(parsePlan("```json\n" + GOOD + "\n```").ok).toBe(true);
  });

  test("an invalid answer gets one repair turn with the validation error", async () => {
    const f = fakeFetch([{ content: '{"summary": "x", "actions": [{"type": "fax"}]}' }, { content: GOOD }]);
    const plan = await new OpenAICompatiblePlanner(cfg, f.impl).plan("x", ctx, "");
    expect(plan.summary).toBe("email Priya");
    const repair = f.calls[1]!.body.messages as { role: string; content: string }[];
    expect(repair.at(-1)?.content).toContain("did not validate");
  });

  test("still invalid after the repair: it throws", async () => {
    const f = fakeFetch([{ content: "not json" }, { content: "still not json" }]);
    expect(new OpenAICompatiblePlanner(cfg, f.impl).plan("x", ctx, "")).rejects.toThrow("did not validate after one repair");
  });

  test("a model without JSON mode (400) is retried without response_format", async () => {
    const f = fakeFetch([{ status: 400, text: "response_format not supported" }, { content: GOOD }]);
    await new OpenAICompatiblePlanner(cfg, f.impl).plan("x", ctx, "");
    expect(f.calls[1]?.body.response_format).toBeUndefined();
  });

  test("an auth failure throws with the provider name", async () => {
    const f = fakeFetch([{ status: 401, text: "bad key" }]);
    expect(new OpenAICompatiblePlanner(cfg, f.impl).plan("x", ctx, "")).rejects.toThrow("groq 401");
  });
});

describe("provider registry", () => {
  test("only providers with a key are available; offline always is", () => {
    expect(availablePlanners({})).toEqual(["offline"]);
    expect(availablePlanners({ XAI_API_KEY: "k", GROQ_API_KEY: "k" })).toEqual(["offline", "xai", "groq"]);
    expect(availablePlanners({ ANTHROPIC_API_KEY: "k", OLLAMA_ENABLED: "1" })).toEqual(["offline", "claude", "ollama"]);
  });

  test("model overrides per provider", () => {
    expect(PROVIDERS.xai!({ XAI_API_KEY: "k", STEWARD_MODEL_XAI: "grok-test" })?.model).toBe("grok-test");
  });

  test("auto prefers Claude, then the first configured provider, then offline", () => {
    expect(choosePlanner("auto", {}).name).toBe("offline");
    expect(choosePlanner("auto", { GROQ_API_KEY: "k", GEMINI_API_KEY: "k" }).name).toBe("gemini");
    expect(choosePlanner("auto", { GROQ_API_KEY: "k", ANTHROPIC_API_KEY: "k" }).name).toBe("claude");
    expect(choosePlanner(undefined, { STEWARD_PLANNER: "offline", GROQ_API_KEY: "k" }).name).toBe("offline");
  });

  test("when the LLM fails, the plan comes from the offline planner and says why", async () => {
    // Ollama pointed at a port nothing listens on: a real network failure.
    const planner = choosePlanner("ollama", { OLLAMA_ENABLED: "1", OLLAMA_BASE_URL: "http://127.0.0.1:9/v1" });
    const plan = await planner.plan("email priya", ctx, "");
    expect(plan.by).toBe("offline");
    expect(plan.note).toContain("ollama failed");
  });
});

describe("provider errors", () => {
  test("keep the message, drop account ids", () => {
    const body = JSON.stringify({ error: { message: "Rate limit reached for model `x` in organization `org_01kxaw25k5fnqrpys06wjfr6kj` service tier `on_demand`" } });
    const msg = providerError(body);
    expect(msg).toContain("Rate limit reached");
    expect(msg).not.toContain("org_01kxaw25k5fnqrpys06wjfr6kj");
  });
});
