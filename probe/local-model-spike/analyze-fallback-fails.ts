/**
 * Diagnostic for the FALLBACK single-shot failures (read-only over the log).
 *
 * Honors the adversarial-review guards:
 *  - mechanically VERIFY each "artifact" quote is unique (matchCount === 1) —
 *    a redundant occurrence_index is only harmless on a unique quote;
 *  - CORPUS multi-match audit: count any emitted occurrence_index that STRICTLY
 *    resolved to a span on a quote appearing >1 time (the silent wrong-location
 *    risk). If zero, the artifact framing is empirically vindicated.
 *  - separate the no-tool-call cases (a reliability floor retry/lenient cannot fix).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeMarkdownDoc } from "../../tests/helpers/ydoc-factory.js";
import { extractText } from "../../src/server/mcp/document-model.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(HERE, "spike-1123-fallback.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const fixCache: Record<string, string> = {};
function text(fix: string): string {
  return (fixCache[fix] ??= extractText(makeMarkdownDoc(readFileSync(join(HERE, fix), "utf8"))));
}
function unescapeMd(q: string): string {
  return q.replace(/\\([$#*_`[\]()])/g, "$1");
}
/** Strict total-occurrence count of a literal quote in text. */
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

let noToolCall = 0;
let artifactUniqueOcc = 0;
let artifactEscape = 0;
let genuine = 0;
let silentCorruptionRisk = 0; // emitted occ resolved (strict) to a span on a quote with matchCount > 1
const corruptionExamples: string[] = [];

// CORPUS-WIDE multi-match audit (all trials, pass and fail).
for (const r of lines) {
  if (r.operation === "chat") continue;
  const tc = r.tool_calls[0];
  if (!tc || !tc.args) continue;
  const q: string = tc.args.quoted_text || "";
  const occ: number = tc.args.occurrence_index ?? 1;
  const t = text(r.fixture);
  const mc = matchCount(t, q);
  if (mc > 1 && occ >= 1 && occ <= mc) {
    // model selected an existing-but-possibly-wrong copy of a repeated quote
    silentCorruptionRisk++;
    if (corruptionExamples.length < 6) corruptionExamples.push(`${r.trial_id}: occ ${occ} of ${mc} — "${q.slice(0, 50)}"`);
  }
}

// FAILURE classification.
for (const r of lines) {
  if (r.score.pass) continue;
  if (r.operation === "chat") {
    genuine++;
    continue;
  }
  const tc = r.tool_calls[0];
  if (!tc || !tc.args) {
    noToolCall++;
    continue;
  }
  const q: string = tc.args.quoted_text || "";
  const occ: number = tc.args.occurrence_index ?? 1;
  const t = text(r.fixture);
  const mc = matchCount(t, q);
  const mcUnesc = matchCount(t, unescapeMd(q));
  if (mc === 1 && occ > 1) {
    artifactUniqueOcc++; // redundant occ-index on a VERIFIED-unique quote
  } else if (mc === 0 && mcUnesc === 1) {
    artifactEscape++; // markdown-escaped quote that resolves uniquely once unescaped
  } else {
    genuine++;
  }
}

console.log("Total fails:", lines.filter((r: { score: { pass: boolean } }) => !r.score.pass).length);
console.log("\n— Failure classification —");
console.log("ANCHOR ARTIFACT, redundant occ-index on VERIFIED-unique quote (matchCount===1):", artifactUniqueOcc);
console.log("ANCHOR ARTIFACT, markdown-escape, unique once unescaped:", artifactEscape);
console.log("NO TOOL CALL despite forced tool_choice (reliability floor; un-rescuable):", noToolCall);
console.log("GENUINE (wrong content/span/location, or chat):", genuine);
console.log("\n— Corpus silent-corruption audit (THE false-GO hazard) —");
console.log("emitted occurrence_index that strictly resolved on a quote with matchCount > 1:", silentCorruptionRisk);
for (const e of corruptionExamples) console.log("   " + e);
console.log(silentCorruptionRisk === 0 ? "  => ZERO. Artifact framing empirically vindicated; clamp-on-unique cannot mis-anchor in this corpus." : "  => NON-ZERO: investigate before any lenient verdict.");
