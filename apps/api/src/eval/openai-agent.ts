import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PROVIDERS, providerError } from "../planner/openai-compatible";

// A plain tool-calling agent on any OpenAI-compatible model (OpenAI, Groq, xAI Grok, Gemini,
// OpenRouter), so the external-agent benchmark isn't only Claude. Like the Claude Code runs, the
// agent's ONLY tools are the ones the MCP server lists: it connects to the same endpoint
// (Steward's /mcp, or the ordinary-connectors baseline) and can do nothing else.
// The transcript is written in the same shape as Claude Code's stream-json, so the benchmark
// reads both the same way.

const MAX_STEPS = 20;
const SYSTEM = "You are an AI assistant. You can only act through the tools you are given. Complete the user's task, then reply with a short summary.";

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

// "openai:gpt-4.1-mini", "groq:openai/gpt-oss-120b", "xai:grok-4"
export function parseAgentModel(spec: string) {
  const i = spec.indexOf(":");
  if (i < 0) return null;
  const provider = spec.slice(0, i);
  const cfg = PROVIDERS[provider]?.(process.env as Record<string, string | undefined>);
  if (!cfg) throw new Error(`provider ${provider} is not configured (missing API key?)`);
  return { ...cfg, model: spec.slice(i + 1) };
}

async function chat(cfg: NonNullable<ReturnType<typeof parseAgentModel>>, body: object) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}), ...cfg.headers },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json() as Promise<{ choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[] }>;
    const text = await res.text();
    // Free tiers rate-limit by tokens per minute: wait and retry rather than count it as a failure.
    if ((res.status === 429 || res.status >= 500) && attempt < 8) {
      const wait = Number(res.headers.get("retry-after")) || Math.min(60, 5 * 2 ** attempt);
      await Bun.sleep(wait * 1000);
      continue;
    }
    throw new Error(`${cfg.name} ${res.status}: ${providerError(text)}`);
  }
}

export async function runOpenAIAgent(spec: string, mcpUrl: string, prompt: string) {
  const cfg = parseAgentModel(spec)!;
  const out: object[] = [];
  const client = new Client({ name: "steward-eval-agent", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
    const { tools: listed } = await client.listTools();
    const tools = listed.map((t) => {
      const { $schema: _s, ...parameters } = t.inputSchema as Record<string, unknown>;
      return { type: "function" as const, function: { name: t.name, description: t.description ?? "", parameters } };
    });
    out.push({ type: "system", subtype: "init", model: spec, tools: listed.map((t) => `mcp__steward__${t.name}`) });

    const messages: ChatMessage[] = [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }];
    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = (await chat(cfg, { model: cfg.model, messages, tools, ...(cfg.temperature !== undefined && !cfg.model.startsWith("gpt-5") ? { temperature: cfg.temperature } : {}) })).choices[0]!.message;
      const calls = reply.tool_calls ?? [];
      messages.push({ role: "assistant", content: reply.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
      out.push({ type: "assistant", message: { content: [
        ...(reply.content ? [{ type: "text", text: reply.content }] : []),
        ...calls.map((c) => ({ type: "tool_use", id: c.id, name: `mcp__steward__${c.function.name}`, input: safeJson(c.function.arguments) })),
      ] } });
      if (!calls.length) {
        out.push({ type: "result", is_error: false, result: reply.content ?? "" });
        return out.map((l) => JSON.stringify(l)).join("\n");
      }
      for (const c of calls) {
        let content: string;
        try {
          const r = await client.callTool({ name: c.function.name, arguments: safeJson(c.function.arguments) as Record<string, unknown> });
          content = (r.content as { type: string; text?: string }[]).map((x) => x.text ?? "").join("\n");
        } catch (e) {
          content = `tool error: ${(e as Error).message}`;
        }
        messages.push({ role: "tool", tool_call_id: c.id, content });
        out.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: c.id, content }] } });
      }
    }
    out.push({ type: "result", is_error: false, result: `stopped after ${MAX_STEPS} steps` });
  } catch (e) {
    out.push({ type: "result", is_error: true, result: (e as Error).message });
  } finally {
    await client.close();
  }
  return out.map((l) => JSON.stringify(l)).join("\n");
}

function safeJson(s: string) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
