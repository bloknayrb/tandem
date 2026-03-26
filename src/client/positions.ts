/**
 * Client-side position module.
 *
 * Consolidates all ProseMirror ↔ flat-offset conversion and annotation
 * range resolution into caller-optimized functions.
 *
 * High-level (use these):
 *   - annotationToPmRange() — resolve an annotation to PM positions (relRange preferred, flat fallback)
 *   - pmSelectionToFlat()   — convert a PM selection to flat offsets for server broadcast
 *
 * Low-level (escape hatches):
 *   - flatOffsetToPmPos()      — single flat offset → PM position
 *   - pmPosToFlatOffset()      — single PM position → flat offset
 *   - relRangeToPmPositions()  — RelativeRange → PM positions via Y.Doc
 */

import type { Node as PmNode } from "@tiptap/pm/model";
import * as Y from "yjs";
import type { Annotation, RelativeRange, DocumentRange } from "../shared/types";
import type { PmRangeResult } from "../shared/positions/index";
import { headingPrefixLength } from "../shared/offsets";

// ---------------------------------------------------------------------------
// Low-level: flat offset ↔ ProseMirror position
// ---------------------------------------------------------------------------

/**
 * Convert a flat character offset (from the server's extractText format) to a
 * ProseMirror document position.
 *
 * Flat text includes heading prefixes ("# ", "## ") and "\n" separators
 * that don't exist in ProseMirror's content model.
 */
export function flatOffsetToPmPos(doc: PmNode, flatOffset: number): number {
  let accumulated = 0;
  let pmOffset = 0;

  const nodeCount = doc.childCount;
  for (let i = 0; i < nodeCount; i++) {
    const child = doc.child(i);
    const childStart = pmOffset + 1; // +1 for PM block open tag

    const prefixLen =
      child.type.name === "heading" ? headingPrefixLength((child.attrs.level as number) || 1) : 0;

    const textLen = child.textContent.length;
    const fullFlatLen = prefixLen + textLen;

    if (accumulated + fullFlatLen > flatOffset) {
      const offsetInFlat = flatOffset - accumulated;
      const textOffset = Math.max(0, offsetInFlat - prefixLen);
      return childStart + Math.min(textOffset, textLen);
    }

    accumulated += fullFlatLen;
    pmOffset += child.nodeSize;

    if (i < nodeCount - 1) {
      accumulated += 1; // \n separator
      if (accumulated > flatOffset) {
        return childStart + textLen;
      }
    }
  }

  return doc.content.size;
}

/**
 * Convert a ProseMirror position to a flat text offset.
 * Inverse of flatOffsetToPmPos.
 */
export function pmPosToFlatOffset(doc: PmNode, pmPos: number): number {
  let flatOffset = 0;
  let pmOffset = 0;

  const nodeCount = doc.childCount;
  for (let i = 0; i < nodeCount; i++) {
    const child = doc.child(i);
    const nodeStart = pmOffset + 1; // +1 for block open tag

    const prefixLen =
      child.type.name === "heading" ? headingPrefixLength((child.attrs.level as number) || 1) : 0;

    const textLen = child.textContent.length;
    const nodeEnd = nodeStart + textLen;

    if (pmPos <= nodeEnd) {
      if (pmPos <= nodeStart) {
        return flatOffset + prefixLen;
      }
      const offsetInNode = pmPos - nodeStart;
      return flatOffset + prefixLen + Math.min(offsetInNode, textLen);
    }

    flatOffset += prefixLen + textLen;
    pmOffset += child.nodeSize;

    if (i < nodeCount - 1) {
      flatOffset += 1; // \n separator
    }
  }

  return flatOffset;
}

// ---------------------------------------------------------------------------
// Low-level: RelativeRange → ProseMirror positions
// ---------------------------------------------------------------------------

/**
 * Resolve a Y.AbsolutePosition to a ProseMirror position by walking the
 * Y.XmlFragment and PM doc in parallel, matching by XmlText identity.
 */
function xmlTextIndexToPmPos(
  pmDoc: PmNode,
  fragment: Y.XmlFragment,
  absPos: { type: Y.AbstractType<unknown>; index: number },
): number | null {
  let pmOffset = 0;

  const nodeCount = Math.min(pmDoc.childCount, fragment.length);
  for (let i = 0; i < nodeCount; i++) {
    const yNode = fragment.get(i);
    const pmChild = pmDoc.child(i);
    const childStart = pmOffset + 1;

    if (yNode instanceof Y.XmlElement) {
      let charAccum = 0;
      for (let j = 0; j < yNode.length; j++) {
        const child = yNode.get(j);
        if (child instanceof Y.XmlText) {
          if (child === absPos.type) {
            return childStart + Math.min(charAccum + absPos.index, pmChild.textContent.length);
          }
          charAccum += child.length;
        }
      }
    }

    pmOffset += pmChild.nodeSize;
  }

  return null;
}

/**
 * Resolve a RelativeRange to ProseMirror positions via Y.Doc.
 * Returns null if either endpoint can't be resolved (e.g., deleted content).
 */
export function relRangeToPmPositions(
  ydoc: Y.Doc,
  pmDoc: PmNode,
  relRange: RelativeRange,
): { from: number; to: number } | null {
  const fromRpos = Y.createRelativePositionFromJSON(relRange.fromRel);
  const toRpos = Y.createRelativePositionFromJSON(relRange.toRel);

  const fromAbs = Y.createAbsolutePositionFromRelativePosition(fromRpos, ydoc);
  const toAbs = Y.createAbsolutePositionFromRelativePosition(toRpos, ydoc);
  if (!fromAbs || !toAbs) return null;

  const fragment = ydoc.getXmlFragment("default");
  const fromPm = xmlTextIndexToPmPos(pmDoc, fragment, fromAbs);
  const toPm = xmlTextIndexToPmPos(pmDoc, fragment, toAbs);
  if (fromPm === null || toPm === null) return null;

  return { from: fromPm, to: toPm };
}

// ---------------------------------------------------------------------------
// High-level: annotation → PM range
// ---------------------------------------------------------------------------

/**
 * Resolve an annotation to ProseMirror positions.
 *
 * Prefers relRange (CRDT-anchored, survives edits). Falls back to flat offsets.
 * Returns null if neither path resolves. The `method` field tells the caller
 * which path was used — useful for diagnostics and testing.
 */
export function annotationToPmRange(
  ann: Annotation,
  pmDoc: PmNode,
  ydoc: Y.Doc | null,
): PmRangeResult | null {
  // Try relRange first
  if (ann.relRange && ydoc) {
    const resolved = relRangeToPmPositions(ydoc, pmDoc, ann.relRange);
    if (resolved) return { ...resolved, method: "rel" };
  }
  // Fall back to flat offsets
  if (!ann.range) return null;
  return {
    from: flatOffsetToPmPos(pmDoc, ann.range.from),
    to: flatOffsetToPmPos(pmDoc, ann.range.to),
    method: "flat",
  };
}

// ---------------------------------------------------------------------------
// High-level: PM selection → flat offsets
// ---------------------------------------------------------------------------

/**
 * Convert a ProseMirror selection to flat text offsets for server broadcast.
 * Convenience wrapper around pmPosToFlatOffset for the awareness extension.
 */
export function pmSelectionToFlat(
  pmDoc: PmNode,
  selection: { from: number; to: number },
): DocumentRange {
  return {
    from: pmPosToFlatOffset(pmDoc, selection.from),
    to: pmPosToFlatOffset(pmDoc, selection.to),
  };
}
