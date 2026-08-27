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
import {
  FLAT_SEPARATOR,
  flattenHeadingText,
  headingPrefix,
  headingPrefixLength,
} from "../shared/offsets";
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
 * The CHARACTERS behind the two length functions above.
 *
 * This module already modelled the server's flat projection — heading prefixes,
 * `"\n"` between block children, a hard break as one character, a block leaf as
 * none — but only as arithmetic. Anything that needed the flat TEXT on the
 * client had nothing to call, so `applySuggestion` reached for
 * `doc.textBetween(from, to, "\n", "\n")` instead, which is a different
 * projection and diverges on three reachable shapes (#1631):
 *
 *  - a heading's `"## "` prefix is in the flat text and in no PM text node;
 *  - a hard break inside a heading is a SPACE in flat text ({@link
 *    flattenHeadingText}) and a newline to `textBetween`;
 *  - a block leaf (`horizontalRule`, a block `image`) contributes nothing to
 *    flat text, and one `leafText` character to `textBetween`.
 *
 * Each one made a suggestion permanently unacceptable on a document nobody had
 * edited. They are emitted here as a pair with the length walk deliberately:
 * `pmDocFlatText(doc).length` must equal `pmPosToFlatOffset(doc, content.size)`
 * for every document, which is what the equivalence test asserts alongside the
 * server's own `extractText`.
 */
function textblockFlatText(node: PmNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) {
      out += child.text ?? "";
    } else if (child.type.name === "hardBreak") {
      out += FLAT_SEPARATOR;
    }
    // Everything else contributes NOTHING — the mirror of `textblockFlatLength`
    // counting only these two. This is the arm `textBetween`'s `leafText` gets
    // wrong for block leaves.
  });
  return out;
}

function pmNodeFlatText(node: PmNode): string {
  if (node.isTextblock) return textblockFlatText(node);
  const parts: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    parts.push(pmNodeFlatText(node.child(i)));
  }
  return parts.join(FLAT_SEPARATOR);
}

/**
 * The server's flat text for a whole PM document, rebuilt from the client's
 * content model. Mirrors `extractText`.
 *
 * The heading prefix is applied at the TOP level only, exactly as
 * {@link pmPosToFlatOffset} charges `headingPrefixLength` at the top level only.
 * That is a mirror of the existing offset math rather than an independent
 * reading of the server — if the projection ever grows nested headings, both
 * walks change together or the offsets they produce stop agreeing.
 */
export function pmDocFlatText(doc: PmNode): string {
  const parts: string[] = [];
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    if (child.type.name === "heading") {
      const level = (child.attrs.level as number) || 1;
      parts.push(headingPrefix(level) + flattenHeadingText(pmNodeFlatText(child)));
    } else {
      parts.push(pmNodeFlatText(child));
    }
  }
  return parts.join(FLAT_SEPARATOR);
}

/**
 * The server's flat text under a PM range — what `captureSnapshot` would have
 * stored for it.
 *
 * Deliberately built by projecting the whole document and slicing it with
 * {@link pmPosToFlatOffset}, rather than by walking the range directly. The
 * boundary cases are the hard part (an offset landing ON a block separator, a
 * container whose last child is a block), `pmPosToFlatOffset` already solves
 * them and is already tested, and a second range-walk would be a second copy of
 * that reasoning. Cost is O(document) per call; this runs on a click.
 */
export function flatTextForPmRange(doc: PmNode, from: PmPos, to: PmPos): string {
  const flat = pmDocFlatText(doc);
  return flat.slice(pmPosToFlatOffset(doc, from), pmPosToFlatOffset(doc, to));
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
    const childLen = pmNodeFlatTextLength(child);
    if (accumulated + childLen > textOffset) {
      return resolveWithinNode(child, textOffset - accumulated, childStart);
    }
    accumulated += childLen;
    pmOffset += child.nodeSize;

    if (i < node.childCount - 1) {
      // The FLAT_SEPARATOR between two block children. An offset that lands ON
      // it means "the end of this child" — and it MUST be resolved here (#1485).
      //
      // Charging the separator at the top of the next iteration instead, which
      // is what this loop used to do, makes the next child's test pass with a
      // NEGATIVE `textOffset - accumulated`, so the recursion resolves inside
      // the WRONG child and returns a position one past the previous child's
      // close token. For a table that put `to` inside the next CELL, and the
      // accept's deleteRange then ate it: a suggestion on the first cell of a
      // row silently deleted the second.
      accumulated += 1;
      if (accumulated > textOffset) {
        // Recurse rather than `childStart + child.content.size`: for a container
        // child (a cell, a list item) that sum lands between the inner block's
        // close token and the container's, which is not a text position.
        return resolveWithinNode(child, childLen, childStart);
      }
    }
  }

  // Past the end of every child — clamp to the end of the LAST one. The old
  // `pmStart + node.content.size` is the container's own inner boundary, which
  // is a text position only when the container's last child is inline. For a
  // table cell wrapping a paragraph it sits BETWEEN the paragraph's close token
  // and the cell's, and a range ending there spans a structural boundary.
  //
  // Recursion terminates because each step descends exactly one level in a
  // finite tree, and this branch is reached with `textOffset` already equal to
  // the node's full flat length, so no child's test can fire and re-enter here.
  // It does NOT always bottom out in a textblock — a container whose last child
  // is a LEAF (a `horizontalRule`) or which is empty ends the descent early,
  // and the `+1` below assumes an open token a leaf does not have. Both return
  // the same value the old code did, so those shapes are unimproved rather than
  // broken; say so rather than claiming an invariant this does not establish.
  if (node.childCount > 0) {
    const last = node.child(node.childCount - 1);
    const lastStart = pmStart + node.content.size - last.nodeSize + 1;
    return resolveWithinNode(last, pmNodeFlatTextLength(last), lastStart);
  }
  return toPmPos(pmStart);
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
        // End of this block. Recurse rather than `childStart + content.size`:
        // that sum is only a text position when the child is a TEXTBLOCK. For a
        // container (a table, a list, a blockquote) it lands between the last
        // inner block's close token and the container's own, which resolves to
        // a structural position and makes the surrounding deleteRange take the
        // node boundary with it. Same defect as #1485, one level up.
        return resolveWithinNode(child, textLen, childStart);
      }
    }
  }

  // Past the end of the document — the end of the LAST block, by the same
  // reasoning as `resolveWithinNode`'s fallthrough. `doc.content.size` is the
  // position AFTER the last block closes, whose parent is the doc node, and it
  // is reached for `flatOffset === flat.length` in EVERY document shape, not
  // just container-ending ones. `tr.delete` survives it (ProseMirror re-fits the
  // slice) but an insert does not: `insertContentAt(doc.content.size, …)`
  // appends a new sibling paragraph AFTER the last block, so a suggestion whose
  // range ends at the end of the document grew a stray paragraph instead of
  // extending the last one.
  if (doc.childCount > 0) {
    const last = doc.child(doc.childCount - 1);
    return resolveWithinNode(
      last,
      pmNodeFlatTextLength(last),
      doc.content.size - last.nodeSize + 1,
    );
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
          // The clamp bounds a Y-derived quantity with a PM-derived one, which is only
          // sound while textblockFlatLength(pmNode) === pmNode.content.size — true for
          // every inline child in this schema (text contributes its length, hardBreak
          // contributes 1 either way). An inline node whose PM size differs from its flat
          // length would silently truncate here, and the warn below only guards the Y side.
          return toPmPos(pmStart + Math.min(charAccum + absPos.index, textblockFlatLength(pmNode)));
        }
        charAccum += child.length;
      } else {
        // A `hardBreak`, which lives as a SIBLING Y.XmlElement rather than
        // inside a Y.XmlText (#1450, #1459). It contributes nothing to the
        // concatenated-XmlText projection this loop walks, but occupies one
        // ProseMirror position — so skipping it under-counted by one per
        // preceding break and resolved every endpoint that many positions
        // early. `applySuggestion` deletes [from, to) and inserts at `from`,
        // so that silently corrupted documents: a short `to` left the tail of
        // the original behind, a short `from` ate text ahead of the range.
        if (!(child instanceof Y.XmlElement) || child.nodeName !== "hardBreak") {
          // Unreachable today — `hardBreak` is the only inline leaf in the
          // schema (pinned by a test) and neither importer puts anything else
          // in a textblock. Worth a runtime warn rather than a silent guess:
          // `textblockFlatLength` above counts ONLY hardBreak, and the server's
          // `directChildSpans` charges a nested element separator + its inner
          // length, so a third shape would put three conventions in play and
          // this is the one that would fail without saying anything.
          console.warn(
            `[positions] unexpected non-text child in textblock: ${
              child instanceof Y.XmlElement ? child.nodeName : typeof child
            }; counting it as one position`,
          );
        }
        charAccum += 1;
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
    } else {
      console.warn(
        `[positions] annotationToPmRange: relRange resolved to null for ${ann.id}, falling back to flat`,
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
