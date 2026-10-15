import type { Context, Next } from "hono";

// Abuse limits for a public demo. Two layers:
//   1. per-IP request limits on the endpoints that cost money or change state (429 + Retry-After)
//   2. a global daily budget of LLM planner calls; past it, planning degrades to the offline
//      planner (the plan says so) instead of failing, so the demo keeps working without the bill.
// In memory: one instance, reset on restart. Enough for a demo; not a distributed limiter.

type Clock = () => number;

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private limit: number, private windowMs: number, private now: Clock = Date.now) {}

  // Returns 0 if allowed, else the seconds until the oldest hit leaves the window.
  take(key: string): number {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return Math.ceil((this.windowMs - (t - recent[0]!)) / 1000);
    }
    recent.push(t);
    this.hits.set(key, recent);
    return 0;
  }
}

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

// Railway (and most proxies) put the client first in x-forwarded-for.
export const clientIp = (c: Context) =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";

export function limit(name: string, perMinute: number) {
  const limiter = new RateLimiter(perMinute, 60_000);
  return async (c: Context, next: Next) => {
    if (c.req.method === "GET" || c.req.method === "OPTIONS") return next();
    const wait = limiter.take(`${name}:${clientIp(c)}`);
    if (wait) {
      c.header("Retry-After", String(wait));
      return c.json({ error: `too many ${name} requests; try again in ${wait}s` }, 429);
    }
    return next();
  };
}

export const LIMITS = {
  requests: env("STEWARD_LIMIT_REQUESTS_PER_MIN", 6),
  seed: env("STEWARD_LIMIT_SEED_PER_MIN", 3),
  mail: env("STEWARD_LIMIT_MAIL_PER_MIN", 10),
  actions: env("STEWARD_LIMIT_ACTIONS_PER_MIN", 30),
};

// Global daily budget for LLM planner calls (all users, all IPs, MCP included).
export class DailyBudget {
  private day = "";
  private used = 0;
  constructor(private cap: number, private now: Clock = Date.now) {}

  take(): boolean {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
    if (this.used >= this.cap) return false;
    this.used++;
    return true;
  }

  status() {
    return { cap: this.cap, used: this.used, day: this.day };
  }
}

export const llmBudget = new DailyBudget(env("STEWARD_LLM_DAILY_CAP", 300));
