import { z } from "zod";
import type { Context } from "../retrieval/retrieve";

// What any planner (Claude or the offline fallback) must return. Planners only *propose*:
// every action still goes through the Sentinel before anything runs.

export const PlannedActionSchema = z.object({
  type: z.enum(["send_email", "share_doc", "create_event", "create_task"]),
  to: z.string().nullable().describe("recipient or invitee email, exactly as in the context"),
  docs: z.array(z.string()).describe("Document ids from the context, e.g. d:atlas-update-v2"),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  title: z.string().nullable().describe("event or task title"),
  start: z.string().nullable().describe("event start, ISO 8601 with offset"),
  end: z.string().nullable().describe("event end, ISO 8601 with offset"),
  due: z.string().nullable().describe("task due time, ISO 8601 with offset"),
  derived_from: z
    .string()
    .describe('"request" if this answers the user\'s request directly, or the id of the inbound Message it responds to'),
  rationale: z.string().describe("one sentence: why, citing the graph facts used"),
});

export const PlanSchema = z.object({
  summary: z.string().describe("one sentence describing the plan"),
  actions: z.array(PlannedActionSchema),
});

export type PlannedAction = z.infer<typeof PlannedActionSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export interface Planner {
  name: string;
  // `rendered` is the text form of `ctx` (what an LLM reads); rule-based planners use `ctx`.
  plan(request: string, ctx: Context, rendered: string): Promise<Plan>;
}
