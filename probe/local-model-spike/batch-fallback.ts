/**
 * FALLBACK batch runner for the #1123 M0 spike.
 *
 * Measures the FALLBACK (constrained single-shot structured-output) bar the
 * plan requires before any FALLBACK-vs-NO-GO call. Runs ONLY the medium-fixture
 * comment / replacement / chat scenarios (sequence, no-op, and envelope require
 * a loop and are out of FALLBACK scope by definition), single-shot via
 * runFallback, scored by the SAME scoring.ts, logged to its own JSONL so it
 * never mixes with the agentic-loop trials.
 *
 * Usage:
 *   npx tsx probe/local-model-spike/batch-fallback.ts --models qwen2.5:7b-instruct,llama3.1:8b,qwen2.5:14b-instruct --seeds 2
 */
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeMarkdownDoc } from "../../tests/helpers/ydoc-factory.js";
import { findOccurrence } from "../../src/server/mcp/navigation.js";
import { extractText } from "../../src/server/mcp/document-model.js";

import type { Transport } from "./ollama.js";
import { runFallback, FALLBACK_SYSTEM_PROMPT } from "./fallback.js";
import { buildUserPrompt } from "./prompts.js";
import { score } from "./scoring.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// FALLBACK scope: medium-fixture comment / replacement / chat only.
const FALLBACK_OPS = new Set(["comment", "replacement", "chat"]);
const FALLBACK_SCENARIOS = SCENARIOS.filter((s) => !s.envelope && FALLBACK_OPS.has(s.operation));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? "" : fallback;
}

function loadFixture(rel: string) {
  return readFileSync(join(HERE, rel), "utf8");
}

function validateScenarios(): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const s of FALLBACK_SCENARIOS) {
    const text = extractText(makeMarkdownDoc(loadFixture(s.fixture)));
    const refs = [s.target, ...(s.target.acceptable_anchors ?? [])];
    for (const r of refs) {
      const hit = findOccurrence(text, r.quoted_text, r.occurrence_index ?? 1);
      if ("error" in hit) problems.push(`${s.id}: anchor not found -> "${r.quoted_text.slice(0, 40)}"`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function loadDoneIds(LOG_PATH: string): Set<string> {
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

async function runTrial(model: string, transport: Transport, scenario: Scenario, temperature: number, maxAnchorRetries: number) {
  const ydoc = makeMarkdownDoc(loadFixture(scenario.fixture));
  const loop = await runFallback({
    ydoc,
    model,
    transport,
    operation: scenario.operation,
    systemPrompt: FALLBACK_SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(ydoc, scenario.prompt, true),
    temperature,
    maxAnchorRetries,
  });
  const scored = score(scenario, ydoc, loop);
  return { loop, scored };
}

async function main() {
  const validation = validateScenarios();
  if (!validation.ok) {
    console.error("❌ Fallback scenario validation FAILED:");
    for (const p of validation.problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log(`✅ Fallback bank validated: ${FALLBACK_SCENARIOS.length} scenarios (comment/replacement/chat, medium only).`);
  if (process.argv.includes("--validate-only")) return;

  const models = (arg("models", "qwen2.5:7b-instruct") || "qwen2.5:7b-instruct").split(",").map((m) => m.trim()).filter(Boolean);
  const transport = (arg("transport", "v1") || "v1") as Transport;
  const seeds = parseInt(arg("seeds", "2") || "2", 10);
  const limit = arg("limit") ? parseInt(arg("limit")!, 10) : undefined;
  const scenarios = limit ? FALLBACK_SCENARIOS.slice(0, limit) : FALLBACK_SCENARIOS;
  const retry = parseInt(arg("retry", "0") || "0", 10);
  const LOG_PATH = join(HERE, retry > 0 ? `spike-1123-fallback-retry${retry}.jsonl` : "spike-1123-fallback.jsonl");
  const temps = [0.0, 0.4];

  mkdirSync(dirname(LOG_PATH), { recursive: true });
  const done = loadDoneIds(LOG_PATH);
  const total = models.length * scenarios.length * seeds;
  let n = 0;
  let ran = 0;

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
        try {
          const { loop, scored } = await runTrial(model, transport, scenario, temperature, retry);
          const rec = {
            trial_id: trialId,
            mode: retry > 0 ? `fallback-retry${retry}` : "fallback",
            model,
            transport,
            operation: scenario.operation,
            scenario_id: scenario.id,
            fixture: scenario.fixture,
            seed: s,
            temperature,
            strata: scenario.strata ?? [],
            prompt: scenario.prompt,
            final_content: loop.finalContent,
            tool_calls: loop.steps.flatMap((st) => st.toolCalls.map((tc) => ({ name: tc.name, args: tc.args, rawArgs: tc.rawArgs, parseError: tc.parseError, outcome: tc.outcome }))),
            metrics: loop.metrics,
            score: scored,
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
