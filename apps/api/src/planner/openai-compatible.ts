import { z } from "zod";
import type { Context } from "../retrieval/retrieve";
import { SYSTEM, userMessage } from "./prompt";
import { PlanSchema, type Plan, type Planner } from "./types";

// One planner for every provider that speaks the OpenAI-compatible chat API: xAI (Grok),
// Groq, OpenRouter, Gemini (its OpenAI-compatible endpoint) and Ollama (local). The output is
// validated against the same schema as Claude's; a malformed answer gets one repair turn.

export type ProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  jsonMode: boolean; // ask for response_format json_object (retried without it on a 400)
  headers?: Record<string, string>;
};

type Env = Record<string, string | undefined>;

// Default models are starting points: override with STEWARD_MODEL_<PROVIDER> if your account
// has a different one. A provider is "configured" when its key is set (Ollama: when enabled).
export const PROVIDERS: Record<string, (env: Env) => ProviderConfig | null> = {
  xai: (env) => env.XAI_API_KEY ? {
    name: "xai", baseUrl: "https://api.x.ai/v1", apiKey: env.XAI_API_KEY,
    model: env.STEWARD_MODEL_XAI ?? "grok-4", jsonMode: true,
  } : null,
  groq: (env) => env.GROQ_API_KEY ? {
    name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey: env.GROQ_API_KEY,
    model: env.STEWARD_MODEL_GROQ ?? "openai/gpt-oss-120b", jsonMode: true,
  } : null,
  openrouter: (env) => env.OPENROUTER_API_KEY ? {
    name: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: env.OPENROUTER_API_KEY,
    model: env.STEWARD_MODEL_OPENROUTER ?? "meta-llama/llama-3.3-70b-instruct:free", jsonMode: true,
    headers: { "X-Title": "Steward" },
  } : null,
  gemini: (env) => env.GEMINI_API_KEY ? {
    name: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: env.GEMINI_API_KEY,
    model: env.STEWARD_MODEL_GEMINI ?? "gemini-2.5-flash", jsonMode: true,
  } : null,
  ollama: (env) => env.OLLAMA_ENABLED === "1" ? {
    name: "ollama", baseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
    model: env.STEWARD_MODEL_OLLAMA ?? "llama3.1", jsonMode: true,
  } : null,
};

const SCHEMA_TEXT = JSON.stringify(z.toJSONSchema(PlanSchema));
const SYSTEM_JSON = `${SYSTEM}

Answer with ONE JSON object and nothing else (no prose, no code fences). It must validate against this JSON Schema:
${SCHEMA_TEXT}`;

type Message = { role: "system" | "user" | "assistant"; content: string };
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

// Keep the provider's own message, drop account identifiers: this text ends up in the plan's
// note, the graph and the UI.
export function providerError(body: string) {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? body;
  } catch {
    // not JSON: use the raw text
  }
  return message.replace(/\b(org|organization|proj|project|user)[-_][A-Za-z0-9]+/gi, "[$1 id]").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function parsePlan(text: string): { ok: true; plan: Plan } | { ok: false; error: string } {
  const json = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  const parsed = PlanSchema.safeParse(raw);
  return parsed.success ? { ok: true, plan: parsed.data } : { ok: false, error: z.prettifyError(parsed.error) };
}

export class OpenAICompatiblePlanner implements Planner {
  name: string;
  constructor(private cfg: ProviderConfig, private fetchImpl: FetchLike = fetch) {
    this.name = cfg.name;
  }

  private async complete(messages: Message[], jsonMode: boolean): Promise<string> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        ...(this.cfg.headers ?? {}),
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        temperature: 0,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.status === 400 && jsonMode) return this.complete(messages, false); // model without JSON mode
    if (!res.ok) throw new Error(`${this.cfg.name} ${res.status}: ${providerError(await res.text())}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.cfg.name} returned no content`);
    return content;
  }

  async plan(request: string, _ctx: Context, rendered: string): Promise<Plan> {
    const messages: Message[] = [
      { role: "system", content: SYSTEM_JSON },
      { role: "user", content: userMessage(request, rendered) },
    ];
    const first = await this.complete(messages, this.cfg.jsonMode);
    const parsed = parsePlan(first);
    if (parsed.ok) return parsed.plan;

    // One repair turn with the validation error, then give up.
    const second = await this.complete(
      [...messages, { role: "assistant", content: first }, { role: "user", content: `That did not validate:\n${parsed.error}\nReturn only the corrected JSON object.` }],
      this.cfg.jsonMode,
    );
    const repaired = parsePlan(second);
    if (repaired.ok) return repaired.plan;
    throw new Error(`${this.cfg.name} plan did not validate after one repair: ${repaired.error}`);
  }
}
