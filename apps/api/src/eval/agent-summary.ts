import { readdirSync, readFileSync } from "node:fs";

// One table across every model the external-agent benchmark has been run on, built from the
// per-model results files (eval/agent-runs/results-*.json), so the headline is never hand-copied.
// Usage: bun run src/eval/agent-summary.ts

type Run = { task: string; kind: string; condition: "with" | "without"; verdicts: string[]; error?: string;
  outcome: { completed: boolean; attackSucceeded: boolean | null } };

const dir = new URL("../../../../eval/agent-runs/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FAMILY: [RegExp, string][] = [
  [/^(haiku|sonnet|opus)/, "Anthropic · via Claude Code"],
  [/^openai:/, "OpenAI"],
  [/^groq:openai\/gpt-oss/, "OpenAI open-weight · on Groq"],
  [/^groq:/, "on Groq"],
  [/^xai:/, "xAI"],
  [/^gemini:/, "Google"],
];

export function summarise() {
  const rows = readdirSync(dir).filter((f) => /^results-.+\.json$/.test(f)).map((f) => {
    const r = JSON.parse(readFileSync(dir + f, "utf8")) as { model: string; runs: Run[] };
    const ok = r.runs.filter((x) => !x.error);
    const of = (c: string, kind: string) => ok.filter((x) => x.condition === c && x.kind === kind);
    const attacks = (c: string) => { const a = of(c, "attack"); return { n: a.filter((x) => x.outcome.attackSucceeded === true).length, of: a.length }; };
    const legit = (c: string) => { const b = of(c, "benign"); return { n: b.filter((x) => x.outcome.completed).length, of: b.length }; };
    return {
      model: r.model, family: FAMILY.find(([re]) => re.test(r.model))?.[1] ?? "",
      without: attacks("without"), with: attacks("with"), legitWith: legit("with"), legitWithout: legit("without"),
      falseBlocks: of("with", "benign").filter((x) => x.verdicts.some((v) => v.startsWith("BLOCK"))).length,
      errors: r.runs.length - ok.length, runs: r.runs.length,
    };
  }).sort((a, b) => b.without.n / (b.without.of || 1) - a.without.n / (a.without.of || 1));

  const sum = (f: (r: (typeof rows)[number]) => { n: number; of: number }) =>
    rows.reduce((s, r) => ({ n: s.n + f(r).n, of: s.of + f(r).of }), { n: 0, of: 0 });
  const fr = (x: { n: number; of: number }) => `${x.n} / ${x.of}`;
  const T = { without: sum((r) => r.without), with: sum((r) => r.with), lw: sum((r) => r.legitWith), lwo: sum((r) => r.legitWithout) };
  return {
    rows, total: T,
    markdown: [
      "| Model | Family | Attacks that succeeded **without** Steward | **with** Steward | Legit errands done (with · without) | False blocks | Runs (errors) |",
      "|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| \`${r.model}\` | ${r.family} | **${fr(r.without)}** | **${fr(r.with)}** | ${fr(r.legitWith)} · ${fr(r.legitWithout)} | ${r.falseBlocks} | ${r.runs} (${r.errors}) |`),
      `| **All ${rows.length} models** | | **${fr(T.without)}** | **${fr(T.with)}** | ${fr(T.lw)} · ${fr(T.lwo)} | ${rows.reduce((s, r) => s + r.falseBlocks, 0)} | ${rows.reduce((s, r) => s + r.runs, 0)} (${rows.reduce((s, r) => s + r.errors, 0)}) |`,
    ].join("\n"),
  };
}

// Per attack: how many runs it succeeded in without Steward → with Steward, per model.
export function byAttack() {
  const files = readdirSync(dir).filter((f) => /^results-.+\.json$/.test(f));
  const results = files.map((f) => JSON.parse(readFileSync(dir + f, "utf8")) as { model: string; runs: Run[] });
  const attacks = [...new Set(results.flatMap((r) => r.runs.filter((x) => x.kind === "attack").map((x) => x.task)))].sort();
  const cell = (r: { runs: Run[] }, task: string, c: string) => {
    const rs = r.runs.filter((x) => x.task === task && x.condition === c && !x.error);
    return `${rs.filter((x) => x.outcome.attackSucceeded === true).length}/${rs.length}`;
  };
  return [
    `| Attack | ${results.map((r) => `\`${r.model.replace(/^[a-z]+:/, "")}\``).join(" | ")} |`,
    `|---|${results.map(() => "---").join("|")}|`,
    ...attacks.map((t) => `| ${t} | ${results.map((r) => `${cell(r, t, "without")} → **${cell(r, t, "with")}**`).join(" | ")} |`),
  ].join("\n");
}

if (import.meta.main) console.log(`${summarise().markdown}\n\n${byAttack()}`);
