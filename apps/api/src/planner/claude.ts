import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Context } from "../retrieval/retrieve";
import { SYSTEM, userMessage } from "./prompt";
import { PlanSchema, type Plan, type Planner } from "./types";

export class ClaudePlanner implements Planner {
  name = "claude";
  private client: Anthropic | null = null; // created on first use, so a missing key fails the call, not startup
  constructor(private model = process.env.STEWARD_MODEL ?? "claude-opus-5-5") {}

  async plan(request: string, _ctx: Context, rendered: string): Promise<Plan> {
    this.client ??= new Anthropic();
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      output_config: { effort: "medium", format: betaZodOutputFormat(PlanSchema) },
      // Route around a safety-classifier refusal instead of failing the request.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: `<graph_context>\n${rendered}\n</graph_context>\n\n<request>${request}</request>` }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`planner refused: ${response.stop_details?.explanation ?? "no explanation"}`);
    }
    if (!response.parsed_output) throw new Error(`planner returned no plan (stop_reason ${response.stop_reason})`);
    return response.parsed_output;
  }
}
