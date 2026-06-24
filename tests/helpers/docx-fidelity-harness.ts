/**
 * .docx round-trip fidelity harness (Phase 0d — the "scoreboard").
 *
 * Drives a .docx buffer through the REAL production adapter (`getAdapter("docx")`)
 * — import (mammoth → html → Y.Doc + Word-comment injection), export
 * (Y.Doc → .docx), then re-import the produced buffer — and captures a
 * structure-and-anchor-aware model of each generation so a test can assert:
 *
 *   1. Stability: the import→export→reimport cycle is a fixed point
 *      (`gen1.tree` deep-equals `gen2.tree`). This is the load-bearing gate.
 *   2. Per-feature fidelity: a capability manifest's positive assertions
 *      (see `docx-roundtrip-fidelity.test.ts`).
 *
 * Why drive the real adapter, not a hand-rolled import: the adapter's `apply`
 * runs BOTH `htmlToYDoc` AND `extractDocxComments`/`injectCommentsAsAnnotations`.
 * A body-only re-implementation would leave the annotation map empty, making
 * every comment assertion vacuous and the stability gate pass trivially (the
 * blocker the plan review caught). Reusing production also can't drift from it.
 *
 * The capture is deliberately NOT flat-text-only. `tree` carries nesting +
 * structural attrs + per-segment mark runs, so list re-nesting, a
 * tableHeader↔tableCell swap, and a mark-boundary shift all change it — the
 * exact drift classes a flat-text or per-XmlText-length vector would miss.
 */

import * as Y from "yjs";
import type { Capture, NodeSnapshot } from "../../src/server/file-io/docx-capture.js";
import { captureModel } from "../../src/server/file-io/docx-capture.js";
import { getAdapter } from "../../src/server/file-io/index.js";
import { transactForTest } from "../../src/shared/origins.js";

export type {
  AnnotationSnapshot,
  Capture,
  NodeSnapshot,
  Run,
} from "../../src/server/file-io/docx-capture.js";
// The capture model + its types now live in production (src/server/file-io/
// docx-capture.ts) so the 0d scoreboard and the 0e verifier share ONE
// definition (not two copies a comment claims must stay in sync). Re-exported
// here so existing scoreboard imports (`from "../helpers/docx-fidelity-
// harness.js"`) keep working unchanged.
export { captureModel };

export interface RoundTrip {
  gen1: Capture;
  gen2: Capture;
  /** Mammoth import-loss warnings from the FIRST import (the ceiling). */
  importWarnings: string[];
}

async function importGeneration(bytes: Buffer): Promise<{ doc: Y.Doc; warnings: string[] }> {
  const adapter = getAdapter("docx");
  const prepared = await adapter.parse(bytes);
  const doc = new Y.Doc();
  // adapter.apply runs htmlToYDoc + injectCommentsAsAnnotations; the latter
  // self-wraps `withInternal`, so do NOT double-wrap — transactForTest just
  // supplies the outer transaction htmlToYDoc relies on.
  transactForTest(doc, () => adapter.apply(doc, prepared, { fileName: "fixture.docx" }));
  const warnings = prepared.issues.flatMap((issue) =>
    issue.kind === "other" && issue.importLosses ? issue.importLosses : [],
  );
  return { doc, warnings };
}

export async function runRoundTrip(bytes: Buffer): Promise<RoundTrip> {
  const adapter = getAdapter("docx");
  if (!adapter.saveBinary) throw new Error("docx adapter is missing saveBinary");

  const first = await importGeneration(bytes);
  const exported = await adapter.saveBinary(first.doc);
  const second = await importGeneration(Buffer.from(exported));

  const gen1 = captureModel(first.doc);
  const gen2 = captureModel(second.doc);
  first.doc.destroy();
  second.doc.destroy();

  return { gen1, gen2, importWarnings: first.warnings };
}

// ---------------------------------------------------------------------------
// Query helpers for manifest assertions (positive, feature-specific checks)
// ---------------------------------------------------------------------------

/** All distinct mark keys present anywhere in the capture. */
export function marksIn(capture: Capture): Set<string> {
  const marks = new Set<string>();
  for (const node of capture.tree) {
    for (const run of node.runs) for (const mark of run.marks) marks.add(mark);
  }
  return marks;
}

/** Whether any node's path ends with `nodeName`. */
export function hasNode(capture: Capture, nodeName: string): boolean {
  return capture.tree.some((node) => node.path[node.path.length - 1] === nodeName);
}

/** Nodes whose path ends with `nodeName`. */
export function nodesOfType(capture: Capture, nodeName: string): NodeSnapshot[] {
  return capture.tree.filter((node) => node.path[node.path.length - 1] === nodeName);
}
