import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { OfflinePlanner } from "../planner/offline";
import { WithFallback } from "../planner/plan";
import type { Planner } from "../planner/types";
import type { Context as RetrievalContext } from "../retrieval/retrieve";
import { DailyBudget, limit, RateLimiter } from "./limits";

describe("per-IP rate limit", () => {
  test("allows up to the limit in the window, then says how long to wait", () => {
    let t = 0;
    const r = new RateLimiter(3, 60_000, () => t);
    expect([r.take("a"), r.take("a"), r.take("a")]).toEqual([0, 0, 0]);
    expect(r.take("a")).toBe(60);
    expect(r.take("b")).toBe(0); // other clients unaffected
    t = 60_001;
    expect(r.take("a")).toBe(0);
  });

  test("as middleware: POSTs over the limit get 429 + Retry-After; GETs are never limited", async () => {
    const app = new Hono();
    app.use("/seed", limit("seed", 2));
    app.all("/seed", (c) => c.json({ ok: true }));
    const post = () => app.request("/seed", { method: "POST", headers: { "x-forwarded-for": "203.0.113.7" } });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    const third = await post();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await app.request("/seed", { headers: { "x-forwarded-for": "203.0.113.7" } })).status).toBe(200);
    expect((await app.request("/seed", { method: "POST", headers: { "x-forwarded-for": "198.51.100.1" } })).status).toBe(200);
  });
});

describe("daily LLM budget", () => {
  test("caps calls per day and resets the next day", () => {
    let t = Date.parse("2026-10-15T10:00:00Z");
    const b = new DailyBudget(2, () => t);
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    t = Date.parse("2026-10-16T00:00:01Z");
    expect(b.take()).toBe(true);
  });

  test("past the budget, planning degrades to the offline planner and the LLM is never called", async () => {
    let called = 0;
    const llm: Planner = { name: "openai", plan: async () => { called++; return { summary: "x", actions: [] }; } };
    const planner = new WithFallback(llm, new OfflinePlanner(), new DailyBudget(1));
    const ctx: RetrievalContext = { terms: [], entryPoints: [], nodes: [], edges: [], user: null, cypher: [] };
    expect((await planner.plan("a", ctx, "")).by).toBe("openai");
    const second = await planner.plan("b", ctx, "");
    expect(second.by).toBe("offline");
    expect(second.note).toContain("LLM budget");
    expect(called).toBe(1);
  });
});
