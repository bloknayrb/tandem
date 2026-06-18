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
import { getAdapter } from "../../src/server/file-io/index.js";
import { extractText } from "../../src/server/mcp/document-model.js";
import { anchoredRange } from "../../src/server/positions.js";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_FOOTNOTE_BODIES,
} from "../../src/shared/constants.js";
import { transactForTest } from "../../src/shared/origins.js";
import type { Annotation, FootnoteBody } from "../../src/shared/types.js";

/**
 * Structural attributes worth comparing across a round-trip. A change in any of
 * these is a fidelity change even when flat text is identical (e.g. a dropped
 * `colspan`, a heading demoted by losing `level`). Deliberately excludes
 * presentational/volatile attrs.
 */
const STRUCTURAL_ATTRS = [
  "level",
  "start",
  "colspan",
  "rowspan",
  "src",
  "alt",
  "title",
  "checked",
] as const;

/** Object-replacement char standing in for an embed (e.g. hardBreak) in a run. */
const EMBED_PLACEHOLDER = "￼";

export interface Run {
  text: string;
  /** Sorted active mark keys on this run (bold, italic, link, …). */
  marks: string[];
}

export interface NodeSnapshot {
  /** nodeName chain from the fragment root, e.g. ["table","tableRow","tableCell","paragraph"]. */
  path: string[];
  /** Structural attributes present on this node (subset of STRUCTURAL_ATTRS). */
  attrs: Record<string, unknown>;
  /** Per-segment mark runs of this node's IMMEDIATE XmlText children. */
  runs: Run[];
}

export interface AnnotationSnapshot {
  /** "comment" | "note" | "highlight" — imported Word comments land as `note`. */
  type: string;
  /** "user" | "claude" | "import" — Word comments import with author "import". */
  author: string;
  from: number;
  to: number;
  /** The characters the annotation currently covers (what a user perceives). */
  anchorText: string;
  /** Whether the range is CRDT-anchorable (not landing on a separator/prefix). */
  fullyAnchored: boolean;
}

export interface Capture {
  /** Pre-order serialization of the full Y.Doc tree — the stability discriminator. */
  tree: NodeSnapshot[];
  /** Flat text (coarse human-readable cross-check; not the primary gate). */
  flatText: string;
  /**
   * Word-comment-relevant annotations (`type === "comment"` OR `author ===
   * "import"`). Excludes id/timestamp (non-deterministic). Note that imported
   * Word comments arrive as private `note`s (ADR-027), so filtering on
   * `type === "comment"` alone would miss them — measuring their round-trip
   * (or lack of it) requires the import-authored set.
   */
  annotations: AnnotationSnapshot[];
  /**
   * Reconstructed footnote bodies (#1123 Tier-A #3 PR 2), keyed by OOXML id —
   * read from Y_MAP_FOOTNOTE_BODIES. The `tree` deep-eq gate is BLIND to this
   * off-fragment map (it would pass even if the body silently vanished), so the
   * scoreboard asserts body survival into gen2 against THIS field directly.
   */
  footnoteBodies: Record<string, FootnoteBody>;
  /**
   * Inline footnote-reference markers (`{ id, text }`) in document order. Lets
   * the scoreboard assert the mark's id value (M2) and the verbatim `[N]`
   * bracket text (M1) survive a round-trip — `runs` only carries mark keys.
   */
  footnoteRefs: Array<{ id: string; text: string }>;
}

function structuralAttrs(el: Y.XmlElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of STRUCTURAL_ATTRS) {
    const value = el.getAttribute(key);
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function runsOf(el: Y.XmlElement): Run[] {
  // Invariant: htmlToYDoc emits exactly ONE immediate Y.XmlText per text-bearing
  // block (heading/paragraph/codeBlock/inline-wrap), so concatenating runs
  // across siblings here is lossless. If a future import path ever produced
  // adjacent XmlText siblings under one element, this would erase the inter-text
  // boundary — insert a per-XmlText sentinel run then.
  const runs: Run[] = [];
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);
    if (!(child instanceof Y.XmlText)) continue;
    for (const op of child.toDelta() as Array<{
      insert?: unknown;
      attributes?: Record<string, unknown>;
    }>) {
      const marks = op.attributes ? Object.keys(op.attributes).sort() : [];
      if (typeof op.insert === "string") {
        runs.push({ text: op.insert, marks });
      } else if (op.insert != null) {
        runs.push({ text: EMBED_PLACEHOLDER, marks });
      }
    }
  }
  return runs;
}

function walk(el: Y.XmlElement, parentPath: string[], out: NodeSnapshot[]): void {
  const path = [...parentPath, el.nodeName ?? "?"];
  out.push({ path, attrs: structuralAttrs(el), runs: runsOf(el) });
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i);
    if (child instanceof Y.XmlElement) walk(child, path, out);
  }
}

/**
 * Footnote reference markers found in the tree, with their mark `id` and the
 * verbatim `[N]` text. `runsOf` captures only mark KEYS, so this is the only
 * place the scoreboard can pin the id value (M2) and the multi-digit bracket
 * text (M1) across generations.
 */
function collectFootnoteRefs(doc: Y.Doc): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  const fragment = doc.getXmlFragment("default");
  const visit = (el: Y.XmlElement): void => {
    for (let i = 0; i < el.length; i++) {
      const child = el.get(i);
      if (child instanceof Y.XmlText) {
        for (const op of child.toDelta() as Array<{
          insert?: unknown;
          attributes?: Record<string, unknown>;
        }>) {
          const ref = op.attributes?.["footnote-ref"] as { id?: string } | undefined;
          if (ref?.id && typeof op.insert === "string") {
            out.push({ id: ref.id, text: op.insert });
          }
        }
      } else if (child instanceof Y.XmlElement) {
        visit(child);
      }
    }
  };
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) visit(node);
  }
  return out;
}

export function captureModel(doc: Y.Doc): Capture {
  const fragment = doc.getXmlFragment("default");
  const tree: NodeSnapshot[] = [];
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) walk(node, [], tree);
  }

  const flatText = extractText(doc);
  const annotationMap = doc.getMap(Y_MAP_ANNOTATIONS);
  const annotations: AnnotationSnapshot[] = [];
  for (const value of annotationMap.values()) {
    const ann = value as Annotation;
    if (ann.type !== "comment" && ann.author !== "import") continue;
    // Resolve through the real positions path, freshly per generation
    // (RelativePositions cannot cross a from-scratch Y.Doc rebuild).
    const resolved = anchoredRange(doc, ann.range.from, ann.range.to);
    if (!resolved.ok) {
      // The annotation no longer resolves (range gone/moved/invalid/heading
      // overlap). Record it as an unanchorable degradation rather than crashing
      // — a measurable loss is exactly what this scoreboard exists to capture.
      annotations.push({
        type: ann.type,
        author: ann.author,
        from: -1,
        to: -1,
        anchorText: "",
        fullyAnchored: false,
      });
      continue;
    }
    const { from, to } = resolved.range;
    annotations.push({
      type: ann.type,
      author: ann.author,
      from,
      to,
      anchorText: flatText.slice(from, to),
      fullyAnchored: resolved.fullyAnchored,
    });
  }
  annotations.sort((a, b) => a.from - b.from || a.to - b.to);

  const rawBodies = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_FOOTNOTE_BODIES);
  const footnoteBodies =
    rawBodies && typeof rawBodies === "object" ? (rawBodies as Record<string, FootnoteBody>) : {};

  return { tree, flatText, annotations, footnoteBodies, footnoteRefs: collectFootnoteRefs(doc) };
}

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
