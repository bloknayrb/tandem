/**
 * Resumable batch runner for the #1123 M0 spike.
 *
 * Validates the scenario bank (every gold anchor must resolve) FAIL-FAST, then
 * runs models × scenarios × seeds, scores each trial, and appends one JSON line
 * per trial to spike-1123-trials.jsonl. Re-running skips trial_ids already in
 * the log, so a multi-hour CPU run survives interruption.
 *
 * Usage:
 *   npx tsx probe/local-model-spike/batch.ts --validate-only
 *   npx tsx probe/local-model-spike/batch.ts --models qwen2.5:7b-instruct --seeds 1 --limit 4
 *   npx tsx probe/local-model-spike/batch.ts --models qwen2.5:7b-instruct,llama3.1:8b --seeds 2
 */
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeMarkdownDoc } from "../../tests/helpers/ydoc-factory.js";
import { findOccurrence } from "../../src/server/mcp/navigation.js";
import { extractText } from "../../src/server/mcp/document-model.js";

import type { Transport } from "./ollama.js";
import { TOOLS } from "./tools.js";
import { runLoop } from "./loop.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";
import { score } from "./scoring.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(HERE, "spike-1123-trials.jsonl");

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? "" : fallback;
}

function loadFixture(rel: string) {
  return readFileSync(join(HERE, rel), "utf8");
}

/** FAIL-FAST: every scenario's gold + acceptable anchors must resolve in its fixture. */
function validateScenarios(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const s of SCENARIOS) {
    const text = extractText(makeMarkdownDoc(loadFixture(s.fixture)));
    const refs = [s.target, ...(s.target.acceptable_anchors ?? [])];
    for (const r of refs) {
      const hit = findOccurrence(text, r.quoted_text, r.occurrence_index ?? 1);
      if ("error" in hit) problems.push(`${s.id}: anchor not found -> "${r.quoted_text.slice(0, 40)}" (occ ${r.occurrence_index ?? 1}): ${hit.error}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function loadDoneIds(): Set<string> {
  if (!existsSync(LOG_PATH)) return new Set();
  const ids = new Set<string>();
  for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      ids.add(JSON.parse(line).trial_id);
    } catch {
      /* ignore partial last line */
    }
  }
  return ids;
}

async function runTrial(model: string, transport: Transport, scenario: Scenario, seed: number, temperature: number) {
  const md = loadFixture(scenario.fixture);
  const ydoc = makeMarkdownDoc(md);
  const includeText = !scenario.envelope;
  const loop = await runLoop({
    ydoc,
    model,
    transport,
    tools: TOOLS,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(ydoc, scenario.prompt, includeText),
    temperature,
  });
  const scored = score(scenario, ydoc, loop);
  return { loop, scored, ydoc };
}

async function main() {
  const validation = validateScenarios();
  if (!validation.ok) {
    console.error("❌ Scenario validation FAILED:");
    for (const p of validation.problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log(`✅ Scenario bank validated: ${SCENARIOS.length} scenarios, all gold anchors resolve.`);

  if (process.argv.includes("--validate-only")) return;

  const models = (arg("models", "qwen2.5:7b-instruct") || "qwen2.5:7b-instruct").split(",").map((m) => m.trim()).filter(Boolean);
  const transport = (arg("transport", "v1") || "v1") as Transport;
  const seeds = parseInt(arg("seeds", "2") || "2", 10);
  const limit = arg("limit") ? parseInt(arg("limit")!, 10) : undefined;
  const scenarios = limit ? SCENARIOS.slice(0, limit) : SCENARIOS;
  // seed→temperature map: seed 1 deterministic, seed 2 a small perturbation (flakiness probe).
  const temps = [0.0, 0.4];

  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const done = loadDoneIds();
  const total = models.length * scenarios.length * seeds;
  let n = 0;
  let ran = 0;
  const t0 = Date.now();

  for (const model of models) {
    for (const scenario of scenarios) {
      for (let s = 1; s <= seeds; s++) {
        n++;
        const trialId = `${model}__${scenario.id}__seed${s}`;
        if (done.has(trialId)) {
          console.log(`[${n}/${total}] skip (done): ${trialId}`);
          continue;
        }
        const temperature = temps[(s - 1) % temps.length];
        const startedAt = Date.now() - t0;
        try {
          const { loop, scored } = await runTrial(model, transport, scenario, s, temperature);
          const rec = {
            trial_id: trialId,
            model,
            transport,
            operation: scenario.operation,
            scenario_id: scenario.id,
            fixture: scenario.fixture,
            envelope: !!scenario.envelope,
            seed: s,
            temperature,
            strata: scenario.strata ?? [],
            prompt: scenario.prompt,
            final_content: loop.finalContent,
            tool_calls: loop.steps.flatMap((st) => st.toolCalls.map((tc) => ({ name: tc.name, args: tc.args, rawArgs: tc.rawArgs, parseError: tc.parseError, outcome: tc.outcome }))),
            metrics: loop.metrics,
            score: scored,
            elapsed_offset_ms: startedAt,
          };
          appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n");
          ran++;
          console.log(`[${n}/${total}] ${scored.pass ? "PASS" : "FAIL"} ${trialId} (${loop.metrics.wallMs}ms${scored.failureMode ? ", " + scored.failureMode : ""})`);
        } catch (err) {
          console.error(`[${n}/${total}] ERROR ${trialId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  console.log(`\nDone. Ran ${ran} new trial(s) (${done.size} already logged). Log: ${LOG_PATH}`);
}

await main();
