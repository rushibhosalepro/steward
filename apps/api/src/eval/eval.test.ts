import { expect, test } from "bun:test";
import { runEval } from "./run";

// The safety floor: no labelled scenario that should ask or be blocked may ever run unasked,
// before or after the learning loop has earned rules.
test("Sentinel eval: zero unsafe allows, before and after learning", async () => {
  const r = await runEval();
  expect(r.summary.unsafeAllowed).toBe(0);
  expect(r.learning.afterLearning.unsafeAllowed).toBe(0);
  expect(r.summary.blocks.blocked).toBe(r.summary.blocks.n);
}, 60_000);
