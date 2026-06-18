/**
 * FALLBACK aggregation + verdict for the #1123 M0 spike.
 *
 * Reads spike-1123-fallback.jsonl (constrained single-shot trials), rolls up
 * per (model, op) pass rates with 95% Wilson CIs, applies the SAME gate as the
 * full-collaborator bar (rate >= 0.80 AND Wilson lower >= 0.70), and names the
 * smallest ladder model clearing all three FALLBACK ops (comment, replacement,
 * chat). This is the measured FALLBACK bar the plan requires before any
 * FALLBACK-vs-NO-GO call — never assumed.
 *
 * Usage: npx tsx probe/local-model-spike/report-fallback.ts
 *
 * NOTE: This script applies the autonomous-collaborator bar (constrained
 * single-shot variant). No model clears all three ops; the script outputs
 * NO-GO. The shipping decision is GO as opt-in/experimental — see
 * docs/spikes/local-llm-capability-spike.md for the human-in-the-loop rationale.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { wilson } from "./scoring.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(HERE, "spike-1123-fallback.jsonl");

const BAR = 0.8;
const WILSON_FLOOR = 0.7;
const LADDER = ["qwen2.5:7b-instruct", "llama3.1:8b", "qwen2.5:14b-instruct"];
const FALLBACK_OPS = ["comment", "replacement", "chat"];

interface Trial {
  model: string;
  operation: string;
  scenario_id: string;
  score: { pass: boolean; failureMode?: string };
  metrics: { wallMs: number; jsonParseFailures: number };
}

function load(): Trial[] {
  if (!existsSync(LOG_PATH)) {
    console.error("No fallback trial log found. Run batch-fallback.ts first.");
    process.exit(1);
  }
  const trials: Trial[] = [];
  for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (line.trim()) trials.push(JSON.parse(line));
  }
  return trials;
}

function rollup(trials: Trial[], pred: (t: Trial) => boolean) {
  const sel = trials.filter(pred);
  const passes = sel.filter((t) => t.score.pass).length;
  const w = wilson(passes, sel.length);
  return { n: sel.length, passes, ...w, clears: sel.length > 0 && w.rate >= BAR && w.lo >= WILSON_FLOOR };
}

function main() {
  const trials = load();
  const models = [...new Set(trials.map((t) => t.model))].sort((a, b) => LADDER.indexOf(a) - LADDER.indexOf(b));

  console.log("# M0 Local-Model Spike — FALLBACK (constrained single-shot) Results\n");
  console.log(`Bar: pass rate ≥ ${BAR} AND Wilson 95% lower bound ≥ ${WILSON_FLOOR}, per op. FALLBACK = single forced structured-output call, no loop. Sequence/no-op/envelope excluded by definition.\n`);

  console.log("## Per-model × per-operation\n");
  console.log("| Model | Operation | n | pass | rate | Wilson95 | clears |");
  console.log("|---|---|---|---|---|---|---|");
  const modelClears: Record<string, boolean> = {};
  for (const model of models) {
    let allClear = true;
    for (const op of FALLBACK_OPS) {
      const r = rollup(trials, (t) => t.model === model && t.operation === op);
      if (r.n === 0) {
        allClear = false;
        continue;
      }
      if (!r.clears) allClear = false;
      console.log(
        `| ${model} | ${op} | ${r.n} | ${r.passes} | ${(r.rate * 100).toFixed(0)}% | [${(r.lo * 100).toFixed(0)}–${(r.hi * 100).toFixed(0)}%] | ${r.clears ? "✅" : "❌"} |`,
      );
    }
    modelClears[model] = allClear;
  }

  console.log("\n## Failure-mode histogram\n");
  const fm: Record<string, number> = {};
  for (const t of trials) if (!t.score.pass) fm[t.score.failureMode ?? "UNKNOWN"] = (fm[t.score.failureMode ?? "UNKNOWN"] ?? 0) + 1;
  for (const [mode, count] of Object.entries(fm).sort((a, b) => b[1] - a[1])) console.log(`- ${mode}: ${count}`);
  if (Object.keys(fm).length === 0) console.log("- (no failures)");

  console.log("\n## Latency (informational, non-gating)\n");
  console.log("| Model | trials | median ms | p90 ms |");
  console.log("|---|---|---|---|");
  for (const model of models) {
    const ms = trials.filter((t) => t.model === model).map((t) => t.metrics.wallMs).sort((a, b) => a - b);
    if (!ms.length) continue;
    console.log(`| ${model} | ${ms.length} | ${ms[Math.floor(ms.length / 2)]} | ${ms[Math.floor(ms.length * 0.9)]} |`);
  }

  console.log("\n## FALLBACK verdict\n");
  const fbModel = LADDER.find((m) => modelClears[m]);
  if (fbModel) {
    console.log(`**FALLBACK VIABLE** — smallest model clearing all three constrained ops (comment, replacement, chat): \`${fbModel}\`.`);
    console.log("Dropped vs full collaborator: autonomous multi-step sequences, deep-retrieval over 50-page docs, and act/no-act discipline — the constrained surface invokes the model per deliberate user action instead.");
  } else {
    console.log("**NO-GO** — no model clears even the constrained single-shot bar across comment + replacement + chat.");
  }
  console.log(`\n_(${trials.length} fallback trials; models: ${models.join(", ")})_`);
}

main();
