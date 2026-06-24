// Structure-and-anchor-aware projection of a .docx Y.Doc — the shared substrate
// for BOTH the 0d round-trip scoreboard (tests/helpers/docx-fidelity-harness.ts)
// AND the 0e post-write verifier (docx-verify.ts). Extracted from the harness so
// "measurement" and "verification" share ONE definition of the document model
// structurally, not by a comment that two copies must stay in sync.
//
// `captureModel` is READ-ONLY w.r.t. its input doc: it only reads the fragment
// and re-resolves annotation anchors via `anchoredRange` (which recomputes
// RelativePositions from current flat offsets — it never mutates). Safe to run
// against the live session doc.

import * as Y from "yjs";
import {
  Y_MAP_ANNOTATIONS,
  Y_MAP_DOCUMENT_META,
  Y_MAP_FOOTNOTE_BODIES,
} from "../../shared/constants.js";
import type { Annotation, FootnoteBody } from "../../shared/types.js";
import { extractText } from "../mcp/document-model.js";
import { anchoredRange } from "../positions.js";

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
export const EMBED_PLACEHOLDER = "￼";

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
