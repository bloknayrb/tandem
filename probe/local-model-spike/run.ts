/**
 * Single-trial runner for the #1123 M0 spike (manual / integration-sanity use).
 *
 * Usage:
 *   npx tsx probe/local-model-spike/run.ts --model qwen2.5:7b-instruct \
 *        [--transport v1|native] [--fixture path.md] [--prompt "..."]
 *
 * With no --fixture/--prompt it runs a tiny built-in scenario, which doubles as
 * the Phase B per-model tool-call gate (does the model emit a parseable tool
 * call over the chosen endpoint?) and the harness integration-sanity check
 * (does a model-driven call produce a real annotation anchored to the doc?).
 */
import { readFileSync } from "node:fs";

import { makeMarkdownDoc } from "../../tests/helpers/ydoc-factory.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";
import type { Transport } from "./ollama.js";
import { TOOLS } from "./tools.js";
import { runLoop } from "./loop.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const model = arg("model", "qwen2.5:7b-instruct")!;
const transport = (arg("transport", "v1") as Transport)!;
const fixturePath = arg("fixture");
const prompt = arg("prompt");

const DEFAULT_FIXTURE = `# Quarterly Cost Report

## Cost Summary

The labor cost figure is $42,500 for the quarter, which appears inconsistent with the stated invoice total of $40,000.

## Notes

Please review the figures above before sign-off.
`;
const DEFAULT_PROMPT =
  "The labor cost figure in the Cost Summary contradicts the invoice total. Leave a comment on the contradictory figure pointing out the mismatch.";

const md = fixturePath ? readFileSync(fixturePath, "utf8") : DEFAULT_FIXTURE;
const userPrompt = prompt ?? DEFAULT_PROMPT;

const ydoc = makeMarkdownDoc(md);
const includeText = arg("windowed") === undefined; // inline doc text unless --windowed

const result = await runLoop({
  ydoc,
  model,
  transport,
  tools: TOOLS,
  systemPrompt: SYSTEM_PROMPT,
  userPrompt: buildUserPrompt(ydoc, userPrompt, includeText),
});

const annotations = ydoc.getMap(Y_MAP_ANNOTATIONS).toJSON();

console.log("\n=== METRICS ===");
console.log(JSON.stringify(result.metrics, null, 2));
console.log("\n=== STEPS ===");
for (const s of result.steps) {
  console.log(`turn ${s.turn} (${s.latencyMs}ms): ${s.toolCalls.length} tool call(s)`);
  for (const tc of s.toolCalls) {
    console.log(`  - ${tc.name}(${tc.rawArgs}) -> ${JSON.stringify(tc.outcome)}`);
  }
  if (s.toolCalls.length === 0 && s.assistantContent) {
    console.log(`  [chat] ${s.assistantContent.slice(0, 200)}`);
  }
}
console.log("\n=== ANNOTATIONS ON DOC ===");
console.log(JSON.stringify(annotations, null, 2));

const toolCallCount = result.metrics.toolCalls;
console.log(`\nGATE: model emitted ${toolCallCount} tool call(s), ${result.metrics.jsonParseFailures} JSON-parse failure(s) over ${transport}.`);
console.log(toolCallCount > 0 ? "✅ tool-call gate PASS for this transport" : "❌ tool-call gate FAIL — try --transport native");
