/**
 * Aggregation + verdict for the #1123 M0 spike.
 *
 * Reads spike-1123-trials.jsonl, rolls up per (model, operation) pass rates
 * with 95% Wilson CIs, applies the gate (rate >= 0.80 AND Wilson lower >= 0.70),
 * walks the GO/FALLBACK/NO-GO decision tree, and prints a markdown summary +
 * failure-mode histogram. Latency reported separately (non-gating).
 *
 * Usage: npx tsx probe/local-model-spike/report.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { wilson } from "./scoring.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(HERE, "spike-1123-trials.jsonl");

const BAR = 0.8;
const WILSON_FLOOR = 0.7;
// Model ladder ascending (smallest clearing the bar wins GO).
const LADDER = ["qwen2.5:7b-instruct", "llama3.1:8b", "qwen2.5:14b-instruct"];

interface Trial {
  model: string;
  operation: string;
  envelope: boolean;
  scenario_id: string;
  score: { pass: boolean; failureMode?: string };
  metrics: { wallMs: number; jsonParseFailures: number };
}

function load(): Trial[] {
  if (!existsSync(LOG_PATH)) {
    console.error("No trial log found. Run batch.ts first.");
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
  const ops = [...new Set(trials.map((t) => t.operation))];

  console.log("# M0 Local-Model Capability Spike — Results\n");
  console.log(`Bar: pass rate ≥ ${BAR} AND Wilson 95% lower bound ≥ ${WILSON_FLOOR}. Envelope reported as a separate gating column.\n`);

  console.log("## Per-model × per-operation (medium fixture)\n");
  console.log("| Model | Operation | n | pass | rate | Wilson95 | clears |");
  console.log("|---|---|---|---|---|---|---|");
  const modelClears: Record<string, boolean> = {};
  for (const model of models) {
    let allClear = true;
    for (const op of ops) {
      const r = rollup(trials, (t) => t.model === model && t.operation === op && !t.envelope);
      if (r.n === 0) continue;
      if (!r.clears) allClear = false;
      console.log(
        `| ${model} | ${op} | ${r.n} | ${r.passes} | ${(r.rate * 100).toFixed(0)}% | [${(r.lo * 100).toFixed(0)}–${(r.hi * 100).toFixed(0)}%] | ${r.clears ? "✅" : "❌"} |`,
      );
    }
    // envelope column (if any envelope trials present)
    const env = rollup(trials, (t) => t.model === model && t.envelope);
    if (env.n > 0) {
      if (!env.clears) allClear = false;
      console.log(`| ${model} | **envelope (all ops)** | ${env.n} | ${env.passes} | ${(env.rate * 100).toFixed(0)}% | [${(env.lo * 100).toFixed(0)}–${(env.hi * 100).toFixed(0)}%] | ${env.clears ? "✅" : "❌"} |`);
    } else {
      allClear = false; // envelope is mandatory; absence cannot count as a pass
    }
    modelClears[model] = allClear;
  }

  console.log("\n## Failure-mode histogram\n");
  const fm: Record<string, number> = {};
  for (const t of trials) if (!t.score.pass) fm[t.score.failureMode ?? "UNKNOWN"] = (fm[t.score.failureMode ?? "UNKNOWN"] ?? 0) + 1;
  for (const [mode, count] of Object.entries(fm).sort((a, b) => b[1] - a[1])) console.log(`- ${mode}: ${count}`);
  if (Object.keys(fm).length === 0) console.log("- (no failures)");

  console.log("\n## Latency (informational, non-gating)\n");
  console.log("| Model | trials | median ms | p90 ms | JSON-parse fails |");
  console.log("|---|---|---|---|---|");
  for (const model of models) {
    const ms = trials.filter((t) => t.model === model).map((t) => t.metrics.wallMs).sort((a, b) => a - b);
    if (!ms.length) continue;
    const med = ms[Math.floor(ms.length / 2)];
    const p90 = ms[Math.floor(ms.length * 0.9)];
    const jp = trials.filter((t) => t.model === model).reduce((s, t) => s + (t.metrics.jsonParseFailures ?? 0), 0);
    console.log(`| ${model} | ${ms.length} | ${med} | ${p90} | ${jp} |`);
  }

  console.log("\n## Verdict\n");
  const envPresent = trials.some((t) => t.envelope);
  if (!envPresent) {
    console.log("⚠️ PARTIAL — no envelope trials logged yet; per-model GO is gated on the envelope column, so no full GO can be declared until the 50-page envelope set runs.");
  }
  const goModel = LADDER.find((m) => modelClears[m]);
  if (goModel) {
    console.log(`**GO** — smallest model clearing the full bar (incl. envelope): \`${goModel}\`.`);
  } else if (envPresent) {
    console.log("No model clears the full-collaborator bar across all ops + envelope. Next: measure the FALLBACK (structured-output) bar before declaring FALLBACK vs NO-GO.");
  }
  console.log(`\n_(${trials.length} trials; models: ${models.join(", ")})_`);
}

main();
