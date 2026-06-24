/**
 * Phase A0 — import smoke test (#1123 M0 spike).
 *
 * Day-1 gate: prove a standalone tsx script can import the real Tandem
 * operations the harness depends on, resolve+run clean, and that the
 * flat-offset coordinate systems line up (findOccurrence offsets are valid
 * input to anchoredRange, which createAnnotation consumes).
 *
 * If this fails to resolve/run, the "standalone loop over internal ops"
 * architecture is wrong — find out now, not on day 10.
 *
 * Run: npx tsx probe/local-model-spike/smoke.ts
 */

import { findOccurrence } from "../../src/server/mcp/navigation.js";
import {
  createAnnotation,
  addReplyToAnnotation,
} from "../../src/server/mcp/annotations.js";
import { anchoredRange } from "../../src/server/positions.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { getOutline, getSection } from "../../src/server/mcp/document.js";
import { makeMarkdownDoc } from "../../tests/helpers/ydoc-factory.js";
import { withMcp } from "../../src/shared/origins.js";
import { Y_MAP_ANNOTATIONS } from "../../src/shared/constants.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
}

const md = `# Intro

The labor cost figure is $42,500 in the summary.

## Details

The labor cost figure is $42,500 again here for emphasis.
`;

const doc = makeMarkdownDoc(md);
const fragment = doc.getXmlFragment("default");
const annotations = doc.getMap(Y_MAP_ANNOTATIONS);

// 1. extractText is the canonical flat-offset string.
const text = extractText(doc);
console.log("extractText():\n", JSON.stringify(text));
assert(text.includes("$42,500"), "extractText should contain the seeded figure");

// 2. Outline / section windowed reads.
const outline = getOutline(fragment);
console.log("getOutline():", JSON.stringify(outline));
assert(outline.length === 2, `expected 2 headings, got ${outline.length}`);

const section = getSection(fragment, "Details");
console.log("getSection('Details'):", JSON.stringify(section));
assert(section.found, "getSection should find 'Details'");

// 3. Quote-anchor resolver: 2nd occurrence of the figure.
const occ2 = findOccurrence(text, "$42,500", 2);
console.log("findOccurrence('$42,500', 2):", JSON.stringify(occ2));
assert("from" in occ2, "findOccurrence should resolve the 2nd occurrence");

// 4. Offsets from findOccurrence feed anchoredRange cleanly.
const anchored = anchoredRange(doc, occ2.from, occ2.to, undefined, {
  rejectHeadingOverlap: true,
});
console.log("anchoredRange().ok:", anchored.ok, "fullyAnchored:", (anchored as { fullyAnchored?: boolean }).fullyAnchored);
assert(anchored.ok, "anchoredRange should accept findOccurrence offsets");

// 5. createAnnotation (comment) — also exercises the withMcp + pushNotification path.
const commentId = createAnnotation(
  annotations,
  doc,
  "comment",
  anchored,
  "This figure is repeated — is the duplication intentional?",
);
console.log("createAnnotation id:", commentId);
assert(annotations.get(commentId), "comment annotation should be stored");

// 6. createAnnotation (replacement = comment + suggestedText).
const occ1 = findOccurrence(text, "$42,500", 1);
assert("from" in occ1, "findOccurrence occ1");
const anchored1 = anchoredRange(doc, occ1.from, occ1.to, undefined, {
  rejectHeadingOverlap: true,
});
assert(anchored1.ok, "anchored1 ok");
const replId = createAnnotation(annotations, doc, "comment", anchored1, "Round this.", {
  suggestedText: "$42,000",
});
const stored = annotations.get(replId) as { suggestedText?: string };
assert(stored?.suggestedText === "$42,000", "replacement should carry suggestedText");

// 7. reply to the pending comment (Claude author, withMcp wrap).
const reply = addReplyToAnnotation(doc, annotations, commentId, "Looks intentional.", "claude", withMcp);
console.log("addReplyToAnnotation:", JSON.stringify(reply));
assert(reply.ok, `reply should succeed: ${JSON.stringify(reply)}`);

console.log("\n✅ SMOKE PASS — standalone import graph resolves and all primitives run.");
console.log("Annotations map size:", annotations.size);
