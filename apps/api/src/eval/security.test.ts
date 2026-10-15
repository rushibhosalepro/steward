import { expect, test } from "bun:test";
import { runSecurityEval } from "./security";

// Every attack in the adversarial suite must hold, with no forbidden side effect.
test("adversarial suite: every attack holds", async () => {
  const r = await runSecurityEval();
  expect(r.rows.filter((x) => !x.pass).map((x) => `${x.id}: ${x.got}`)).toEqual([]);
}, 120_000);
