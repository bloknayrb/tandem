/**
 * Variant L — re-score the logged FALLBACK single-shot trials under a LENIENT
 * PRODUCT resolver applied ONLY to the model's anchor. The scoring oracle stays
 * strict (scoring.ts resolves the GOLD span with un-lenient findOccurrence), so
 * a lenient resolution that lands on the wrong span still FAILs loudly on IoU.
 *
 * Lenient resolver (honoring the adversarial-review guards):
 *   1. markdown-unescape the quote (\$ -> $) — pure fidelity fix.
 *   2. occurrence-clamp to the sole match — ONLY when matchCount === 1 (a
 *      redundant occurrence_index is information-free on a unique quote).
 *      NEVER clamps a repeated quote, so it cannot silently mis-anchor.
 * No re-inference: this reuses the model's already-emitted args. chat trials and
 * no-tool-call trials are unchanged (lenient resolution cannot apply).
 *
 * Usage: npx tsx probe/local-model-spike/rescore-fallback-lenient.ts
 */
import type * as Y from "yjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeMarkdownDoc } from "../../tests/helpers/ydoc-factory.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { findOccurrence } from "../../src/server/mcp/navigation.js";
import { anchoredRange } from "../../src/server/positions.js";
import { createAnnotation } from "../../src/server/mcp/annotations.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";

import { score, wilson } from "./scoring.js";
import { SCENARIOS, type Scenario } from "./scenarios.js";
import type { LoopResult } from "./loop.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(HERE, "spike-1123-fallback.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const byId = new Map(SCENARIOS.map((s) => [s.id, s]));

function unescapeMd(q: string): string {
  return q.replace(/\\([$#*_`[\]()])/g, "$1");
}
function matchCount(t: string, q: string): number {
  if (!q) return 0;
  let n = 0;
  let i = t.indexOf(q);
  while (i !== -1) {
    n++;
    i = t.indexOf(q, i + 1);
  }
  return n;
}

/** Lenient resolution of the MODEL's quote → {from,to}, or null. matchCount===1 gate. */
function lenientResolve(t: string, quotedRaw: string, occ: number): { from: number; to: number } | null {
  for (const q of [quotedRaw, unescapeMd(quotedRaw)]) {
    const strict = findOccurrence(t, q, occ);
    if (!("error" in strict)) return { from: strict.from, to: strict.to };
    if (matchCount(t, q) === 1) {
      const only = findOccurrence(t, q, 1); // redundant occ-index → the sole match
      if (!("error" in only)) return { from: only.from, to: only.to };
    }
  }
  return null;
}

/** Rebuild the trial's annotation state under lenient resolution, then score strictly. */
function rescore(rec: { scenario_id: string; operation: string; fixture: string; final_content: string; tool_calls: { name: string; args: Record<string, unknown> | null }[] }): { pass: boolean; failureMode?: string } {
  const scenario = byId.get(rec.scenario_id) as Scenario;
  const ydoc = makeMarkdownDoc(readFileSync(join(HERE, rec.fixture), "utf8")) as Y.Doc;
  const t = extractText(ydoc);
  const annotations = ydoc.getMap(Y_MAP_ANNOTATIONS);

  if (rec.operation !== "chat") {
    const tc = rec.tool_calls[0];
    if (tc && tc.args) {
      const quoted = String(tc.args.quoted_text ?? "");
      const occ = Number(tc.args.occurrence_index ?? 1) || 1;
      const span = lenientResolve(t, quoted, occ);
      if (span) {
        const anchored = anchoredRange(ydoc, span.from, span.to, undefined, { rejectHeadingOverlap: true });
        if (anchored.ok) {
          if (rec.operation === "replacement") {
            createAnnotation(annotations, ydoc, "comment", anchored, String(tc.args.rationale ?? "") || "Suggested replacement.", { suggestedText: String(tc.args.suggested_text ?? "") });
          } else {
            createAnnotation(annotations, ydoc, "comment", anchored, String(tc.args.comment ?? ""));
          }
        }
      }
    }
  }
  // score() resolves GOLD strictly and reads the lenient-placed annotation from ydoc.
  const loopShim = { finalContent: rec.final_content } as LoopResult;
  const s = score(scenario, ydoc, loopShim);
  return { pass: s.pass, failureMode: s.failureMode };
}

const BAR = 0.8;
const WILSON_FLOOR = 0.7;
const LADDER = ["qwen2.5:7b-instruct", "llama3.1:8b", "qwen2.5:14b-instruct"];
const OPS = ["comment", "replacement", "chat"];

const rescored = lines.map((r) => ({ ...r, lenientPass: rescore(r).pass }));
const models = [...new Set(rescored.map((r) => r.model))].sort((a, b) => LADDER.indexOf(a) - LADDER.indexOf(b));

console.log("# FALLBACK — Variant L (lenient model-anchor resolver, strict gold)\n");
console.log("Lenient = md-unescape + occurrence-clamp ONLY on matchCount===1 quotes. Gold span resolved strictly (un-lenient). No re-inference.\n");
console.log("| Model | Operation | n | strict→lenient pass | lenient rate | Wilson95 | clears |");
console.log("|---|---|---|---|---|---|---|");
const clears: Record<string, boolean> = {};
for (const model of models) {
  let all = true;
  for (const op of OPS) {
    const sel = rescored.filter((r) => r.model === model && r.operation === op);
    if (!sel.length) {
      all = false;
      continue;
    }
    const strictPass = sel.filter((r) => r.score.pass).length;
    const lenPass = sel.filter((r) => r.lenientPass).length;
    const w = wilson(lenPass, sel.length);
    const ok = w.rate >= BAR && w.lo >= WILSON_FLOOR;
    if (!ok) all = false;
    console.log(`| ${model} | ${op} | ${sel.length} | ${strictPass}→${lenPass} | ${(w.rate * 100).toFixed(0)}% | [${(w.lo * 100).toFixed(0)}–${(w.hi * 100).toFixed(0)}%] | ${ok ? "✅" : "❌"} |`);
  }
  clears[model] = all;
}
const winner = LADDER.find((m) => clears[m]);
console.log("\n## Variant-L verdict\n");
console.log(winner ? `Under the lenient product resolver, smallest model clearing all three ops: \`${winner}\`.` : "No model clears all three ops even under the lenient resolver.");
const noToolCalls = lines.filter((r: { operation: string; tool_calls: unknown[]; score: { pass: boolean } }) => r.operation !== "chat" && !r.score.pass && !r.tool_calls[0]).length;
console.log(`\nReliability floor (separate, un-rescuable): ${noToolCalls} forced-call trials emitted NO tool call.`);
