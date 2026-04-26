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
import { headingPrefixLength } from "../shared/offsets";
import type { PmRangeResult } from "../shared/positions/index";
import type { DocumentRange, FlatOffset, PmPos, RelativeRange } from "../shared/positions/types";
import { toFlatOffset, toPmPos } from "../shared/positions/types";
import type { Annotation } from "../shared/types";

// ---------------------------------------------------------------------------
// Low-level: flat offset ↔ ProseMirror position
// ---------------------------------------------------------------------------

/**
 * Compute the flat text length of a PM textblock node.
 * Counts text runs and hardBreak embeds (each embed = 1 flat char, matching
 * the server's Y.XmlText embed → "\n" convention).
 */
function textblockFlatLength(node: PmNode): number {
  let len = 0;
  node.forEach((child) => {
    if (child.isText) {
      len += child.text!.length;
    } else if (child.type.name === "hardBreak") {
      len += 1;
    }
  });
  return len;
}

/**
 * Compute the flat text length of a PM node (recursive for container nodes).
 * Container nodes get FLAT_SEPARATOR ("\n") between their block children,
 * matching the server's getElementText() separator convention.
 */
function pmNodeFlatTextLength(node: PmNode): number {
  if (node.isTextblock) return textblockFlatLength(node);
  let len = 0;
  for (let i = 0; i < node.childCount; i++) {
    if (i > 0) len += 1; // FLAT_SEPARATOR between block children
    len += pmNodeFlatTextLength(node.child(i));
  }
  return len;
}

/**
 * Resolve a flat text offset to a PM position within a single PM node.
 * pmStart is the PM position at the start of the node's content (one past the opening token).
 */
function resolveWithinNode(node: PmNode, textOffset: number, pmStart: number): PmPos {
  if (node.isTextblock) {
    return toPmPos(pmStart + Math.min(textOffset, textblockFlatLength(node)));
  }
  let accumulated = 0;
  let pmOffset = pmStart;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const childStart = pmOffset + 1;
    if (i > 0) accumulated += 1;
    const childLen = pmNodeFlatTextLength(child);
    if (accumulated + childLen > textOffset) {
      return resolveWithinNode(child, textOffset - accumulated, childStart);
    }
    accumulated += childLen;
    pmOffset += child.nodeSize;
  }
  return toPmPos(pmStart + node.content.size);
}

/**
 * Convert a flat character offset (from the server's extractText format) to a
 * ProseMirror document position.
 *
 * Flat text includes heading prefixes ("# ", "## ") and "\n" separators
 * that don't exist in ProseMirror's content model.
 */
export function flatOffsetToPmPos(doc: PmNode, flatOffset: FlatOffset): PmPos {
  let accumulated = 0;
  let pmOffset = 0;

  const nodeCount = doc.childCount;
  for (let i = 0; i < nodeCount; i++) {
    const child = doc.child(i);
    const childStart = pmOffset + 1; // +1 for PM block open tag

    const prefixLen =
      child.type.name === "heading" ? headingPrefixLength((child.attrs.level as number) || 1) : 0;

    const textLen = pmNodeFlatTextLength(child);
    const fullFlatLen = prefixLen + textLen;

    if (accumulated + fullFlatLen > flatOffset) {
      const offsetInFlat = flatOffset - accumulated;
      const textOffset = Math.max(0, offsetInFlat - prefixLen);
      return resolveWithinNode(child, textOffset, childStart);
    }

    accumulated += fullFlatLen;
    pmOffset += child.nodeSize;

    if (i < nodeCount - 1) {
      accumulated += 1; // \n separator
      if (accumulated > flatOffset) {
        return toPmPos(childStart + child.content.size);
      }
    }
  }

  return toPmPos(doc.content.size);
}

/**
 * Compute the flat offset within a single PM node at a given PM position.
 * pmStart is the PM position at the start of the node's content (one past the opening token).
 */
function flatOffsetWithinNode(node: PmNode, pmPos: PmPos, pmStart: number): number {
  if (node.isTextblock) {
    return Math.min(pmPos - pmStart, textblockFlatLength(node));
  }
  let flatAccum = 0;
  let pmOffset = pmStart;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const childStart = pmOffset + 1;
    if (i > 0) flatAccum += 1;
    const childEnd = pmOffset + child.nodeSize;
    if (pmPos < childEnd) {
      if (pmPos <= childStart) return flatAccum;
      return flatAccum + flatOffsetWithinNode(child, pmPos, childStart);
    }
    flatAccum += pmNodeFlatTextLength(child);
    pmOffset += child.nodeSize;
  }
  return flatAccum;
}

/**
 * Convert a ProseMirror position to a flat text offset.
 * Inverse of flatOffsetToPmPos.
 */
export function pmPosToFlatOffset(doc: PmNode, pmPos: PmPos): FlatOffset {
  let flatOffset = 0;
  let pmOffset = 0;

  const nodeCount = doc.childCount;
  for (let i = 0; i < nodeCount; i++) {
    const child = doc.child(i);
    const nodeStart = pmOffset + 1; // +1 for block open tag

    const prefixLen =
      child.type.name === "heading" ? headingPrefixLength((child.attrs.level as number) || 1) : 0;

    const textLen = pmNodeFlatTextLength(child);
    const nodeEnd = pmOffset + child.nodeSize;

    if (pmPos < nodeEnd) {
      if (pmPos <= nodeStart) {
        return toFlatOffset(flatOffset + prefixLen);
      }
      return toFlatOffset(flatOffset + prefixLen + flatOffsetWithinNode(child, pmPos, nodeStart));
    }

    flatOffset += prefixLen + textLen;
    pmOffset += child.nodeSize;

    if (i < nodeCount - 1) {
      flatOffset += 1; // \n separator
    }
  }

  return toFlatOffset(flatOffset);
}

// ---------------------------------------------------------------------------
// Low-level: RelativeRange → ProseMirror positions
// ---------------------------------------------------------------------------

/**
 * Recursively search a Y.XmlElement / PM node pair for the XmlText matching
 * absPos.type, and return the corresponding PM position.
 */
function findXmlTextInParallel(
  yEl: Y.XmlElement,
  pmNode: PmNode,
  pmStart: number,
  absPos: { type: Y.AbstractType<unknown>; index: number },
): PmPos | null {
  if (pmNode.isTextblock) {
    let charAccum = 0;
    for (let j = 0; j < yEl.length; j++) {
      const child = yEl.get(j);
      if (child instanceof Y.XmlText) {
        if (child === absPos.type) {
          return toPmPos(pmStart + Math.min(charAccum + absPos.index, textblockFlatLength(pmNode)));
        }
        charAccum += child.length;
      }
    }
    return null;
  }
  let pmOffset = pmStart;
  if (yEl.length !== pmNode.childCount) {
    console.warn(
      `[positions] Y.js/PM child count mismatch: yEl(${yEl.nodeName}).length=${yEl.length} vs pmNode(${pmNode.type.name}).childCount=${pmNode.childCount}`,
    );
  }
  const count = Math.min(yEl.length, pmNode.childCount);
  for (let j = 0; j < count; j++) {
    const yChild = yEl.get(j);
    const pmChild = pmNode.child(j);
    const childStart = pmOffset + 1;
    if (yChild instanceof Y.XmlElement) {
      const result = findXmlTextInParallel(yChild, pmChild, childStart, absPos);
      if (result !== null) return result;
    }
    pmOffset += pmChild.nodeSize;
  }
  return null;
}

/**
 * Resolve a Y.AbsolutePosition to a ProseMirror position by walking the
 * Y.XmlFragment and PM doc in parallel, matching by XmlText identity.
 * Handles nested structures (lists, blockquotes) via recursive parallel walk.
 */
function xmlTextIndexToPmPos(
  pmDoc: PmNode,
  fragment: Y.XmlFragment,
  absPos: { type: Y.AbstractType<unknown>; index: number },
): PmPos | null {
  let pmOffset = 0;

  const nodeCount = Math.min(pmDoc.childCount, fragment.length);
  for (let i = 0; i < nodeCount; i++) {
    const yNode = fragment.get(i);
    const pmChild = pmDoc.child(i);
    const childStart = pmOffset + 1;
    if (yNode instanceof Y.XmlElement) {
      const result = findXmlTextInParallel(yNode, pmChild, childStart, absPos);
      if (result !== null) return result;
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
): { from: PmPos; to: PmPos } | null {
  let fromAbs, toAbs;
  try {
    const fromRpos = Y.createRelativePositionFromJSON(relRange.fromRel);
    const toRpos = Y.createRelativePositionFromJSON(relRange.toRel);
    fromAbs = Y.createAbsolutePositionFromRelativePosition(fromRpos, ydoc);
    toAbs = Y.createAbsolutePositionFromRelativePosition(toRpos, ydoc);
  } catch (err) {
    console.warn("[positions] relRangeToPmPositions: failed to resolve relRange:", err);
    return null;
  }
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
    if (resolved && resolved.from <= resolved.to) return { ...resolved, method: "rel" };
    if (resolved) {
      console.warn(
        `[positions] annotationToPmRange: inverted rel range for ${ann.id}, falling back to flat`,
      );
    }
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
  selection: { from: PmPos; to: PmPos },
): DocumentRange {
  return {
    from: pmPosToFlatOffset(pmDoc, selection.from),
    to: pmPosToFlatOffset(pmDoc, selection.to),
  };
}
