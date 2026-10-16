import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";

// The human surface vs the agent surface. Agents (over MCP or plain HTTP) may propose, plan,
// read and run what the Sentinel ALLOWed. Only a human may approve, change rules, pause or
// resume, reset, or inject the simulated outside world. Those routes require the approver code
// (x-steward-approver), which lives on the server and in the human's UI, never in MCP output.
// Without this, an MCP client could propose over MCP and approve itself over HTTP.

const configured = process.env.STEWARD_APPROVER_TOKEN?.trim();
export const APPROVER_TOKEN = configured || crypto.randomUUID().slice(0, 8);
if (!configured && process.env.NODE_ENV !== "test" && !process.env.BUN_TEST) {
  // Fail closed: no configured code means a fresh random one, shown only to whoever runs the server.
  console.log(`approver code for this run: ${APPROVER_TOKEN} (set STEWARD_APPROVER_TOKEN to fix it)`);
}

export function isApprover(header: string | undefined, token = APPROVER_TOKEN) {
  if (!header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// `alsoAllow` lets a visitor act as the human of their own sandbox (limits/sandbox.ts).
export function humanOnly(token = APPROVER_TOKEN, alsoAllow: (c: Context) => boolean = () => false) {
  return async (c: Context, next: Next) => {
    if (c.req.method === "GET" || c.req.method === "OPTIONS") return next();
    if (!isApprover(c.req.header("x-steward-approver"), token) && !alsoAllow(c)) {
      return c.json({ error: "only a human with the approver code can do this", humanOnly: true }, 403);
    }
    return next();
  };
}
