/**
 * Server-side position module.
 *
 * Consolidates all flat-offset, Y.Doc element resolution, RelativePosition,
 * and range validation logic into caller-optimized functions.
 *
 * High-level (use these):
 *   - validateRange()    — validate + stale-check a flat-offset range
 *   - anchoredRange()    — validate + create both flat and CRDT-anchored range
 *   - refreshRange()     — resolve relRange → flat offsets (or lazily attach)
 *   - refreshAllRanges() — batch version in a Y.Doc transaction
 *
 * Low-level (escape hatches):
 *   - resolveToElement()     — flat offset → Y.Doc element position
 *   - flatOffsetToRelPos()   — flat offset → serialized RelativePosition
 *   - relPosToFlatOffset()   — serialized RelativePosition → flat offset
 */

import * as Y from "yjs";
import type { Annotation, DocumentRange, RelativeRange } from "../shared/types.js";
import type {
  RangeValidation,
  AnchoredRangeResult,
  ElementPosition,
} from "../shared/positions/index.js";
import { headingPrefixLength, FLAT_SEPARATOR } from "../shared/offsets.js";

// ---------------------------------------------------------------------------
// Internal helpers (same logic as former document-model.ts, consolidated here)
// ---------------------------------------------------------------------------

/** Extract plain text from a Y.XmlElement by recursively collecting Y.XmlText content. */
function getElementText(element: Y.XmlElement): string {
  const parts: string[] = [];
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      parts.push(child.toString());
    } else if (child instanceof Y.XmlElement) {
      parts.push(getElementText(child));
    }
  }
  return parts.join("");
}

/** Heading prefix length for a Y.XmlElement node. */
function nodeHeadingPrefixLength(node: Y.XmlElement): number {
  if (node.nodeName === "heading") {
    const level = Number(node.getAttribute("level") ?? 1);
    return headingPrefixLength(level);
  }
  return 0;
}

/** Find the first Y.XmlText child (read-only, no creation). */
function findXmlText(element: Y.XmlElement): Y.XmlText | null {
  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) return child;
  }
  return null;
}

/** Find or create the first Y.XmlText child. */
function getOrCreateXmlText(element: Y.XmlElement): Y.XmlText {
  return (
    findXmlText(element) ??
    (() => {
      const textNode = new Y.XmlText("");
      element.insert(0, [textNode]);
      return textNode;
    })()
  );
}

/** Extract flat text from a Y.Doc (same format as extractText in document-model). */
function extractText(doc: Y.Doc): string {
  const fragment = doc.getXmlFragment("default");
  const lines: string[] = [];
  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (node instanceof Y.XmlElement) {
      const text = getElementText(node);
      if (node.nodeName === "heading") {
        const level = Number(node.getAttribute("level") ?? 1);
        lines.push("#".repeat(level) + " " + text);
      } else {
        lines.push(text);
      }
    }
  }
  return lines.join(FLAT_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Low-level: element resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a flat character offset to a Y.Doc element position.
 * Needed by tandem_edit for cross-element deletion logic.
 */
export function resolveToElement(
  fragment: Y.XmlFragment,
  charOffset: number,
): ElementPosition | null {
  let accumulated = 0;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    const prefixLen = nodeHeadingPrefixLength(node);
    const text = getElementText(node);
    const fullLen = prefixLen + text.length;

    if (accumulated + fullLen > charOffset) {
      const offsetInFull = charOffset - accumulated;
      const clampedFromPrefix = offsetInFull < prefixLen && prefixLen > 0;
      const textOffset = Math.max(0, offsetInFull - prefixLen);
      return { elementIndex: i, textOffset, clampedFromPrefix };
    }

    accumulated += fullLen;

    if (i < fragment.length - 1) {
      accumulated += 1; // \n separator
      if (accumulated > charOffset) {
        return { elementIndex: i, textOffset: text.length, clampedFromPrefix: false };
      }
    }
  }

  if (fragment.length > 0) {
    const lastNode = fragment.get(fragment.length - 1);
    if (lastNode instanceof Y.XmlElement) {
      return {
        elementIndex: fragment.length - 1,
        textOffset: getElementText(lastNode).length,
        clampedFromPrefix: false,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Low-level: RelativePosition conversion
// ---------------------------------------------------------------------------

/**
 * Convert a flat text offset to a JSON-serialized Yjs RelativePosition.
 * Returns null if the offset falls in a heading prefix or can't be resolved.
 */
export function flatOffsetToRelPos(doc: Y.Doc, offset: number, assoc: 0 | -1): unknown | null {
  const fragment = doc.getXmlFragment("default");
  const resolved = resolveToElement(fragment, offset);
  if (!resolved || resolved.clampedFromPrefix) return null;

  const node = fragment.get(resolved.elementIndex);
  if (!(node instanceof Y.XmlElement)) return null;

  const xmlText = getOrCreateXmlText(node);
  const rpos = Y.createRelativePositionFromTypeIndex(xmlText, resolved.textOffset, assoc);
  return Y.relativePositionToJSON(rpos);
}

/**
 * Resolve a JSON-serialized Yjs RelativePosition back to a flat text offset.
 * Returns null if the referenced content was deleted.
 */
export function relPosToFlatOffset(doc: Y.Doc, relPosJson: unknown): number | null {
  const rpos = Y.createRelativePositionFromJSON(relPosJson);
  const absPos = Y.createAbsolutePositionFromRelativePosition(rpos, doc);
  if (!absPos) return null;

  const fragment = doc.getXmlFragment("default");
  let accumulated = 0;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    const prefixLen = nodeHeadingPrefixLength(node);
    const text = getElementText(node);

    const xmlText = findXmlText(node);
    if (xmlText && xmlText === absPos.type) {
      return accumulated + prefixLen + absPos.index;
    }

    accumulated += prefixLen + text.length;
    if (i < fragment.length - 1) {
      accumulated += 1;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// High-level: range validation
// ---------------------------------------------------------------------------

/**
 * Validate a flat-offset range against a Y.Doc.
 *
 * Checks: ordering, textSnapshot staleness (with relocation), and optionally
 * heading-prefix overlap. Returns a structured RangeValidation.
 *
 * This replaces the scattered checkRangeStale + verifyAndResolveRange +
 * clampedFromPrefix checks in MCP tool handlers.
 */
export function validateRange(
  ydoc: Y.Doc,
  from: number,
  to: number,
  opts?: {
    textSnapshot?: string;
    rejectHeadingOverlap?: boolean;
  },
): RangeValidation {
  const rejectHeadingOverlap = opts?.rejectHeadingOverlap ?? false;

  if (from > to) {
    return {
      ok: false,
      code: "INVALID_RANGE",
      message: `Invalid range: from (${from}) must be <= to (${to}).`,
    };
  }

  // Staleness check
  if (opts?.textSnapshot) {
    const fullText = extractText(ydoc);
    if (fullText.slice(from, to) !== opts.textSnapshot) {
      const candidates: number[] = [];
      let searchFrom = 0;
      while (true) {
        const idx = fullText.indexOf(opts.textSnapshot, searchFrom);
        if (idx === -1) break;
        candidates.push(idx);
        searchFrom = idx + 1;
      }
      if (candidates.length === 0) {
        return { ok: false, code: "RANGE_STALE", gone: true };
      }
      const best = candidates.reduce((a, b) => (Math.abs(a - from) <= Math.abs(b - from) ? a : b));
      return {
        ok: false,
        code: "RANGE_STALE",
        gone: false,
        resolvedFrom: best,
        resolvedTo: best + opts.textSnapshot.length,
      };
    }
  }

  // Heading overlap check
  if (rejectHeadingOverlap) {
    const fragment = ydoc.getXmlFragment("default");
    const startPos = resolveToElement(fragment, from);
    const endPos = resolveToElement(fragment, to);
    if (!startPos || !endPos) {
      return {
        ok: false,
        code: "INVALID_RANGE",
        message: `Cannot resolve offset range [${from}, ${to}] in document.`,
      };
    }
    if (startPos.clampedFromPrefix || endPos.clampedFromPrefix) {
      return { ok: false, code: "HEADING_OVERLAP" };
    }
  }

  return { ok: true, range: { from, to } };
}

// ---------------------------------------------------------------------------
// High-level: anchored range creation
// ---------------------------------------------------------------------------

/**
 * Validate a range and create both flat and CRDT-anchored positions in one call.
 *
 * Replaces the 6-15 lines of ceremony in tandem_highlight, tandem_comment,
 * tandem_suggest, and tandem_flag handlers.
 */
export function anchoredRange(
  ydoc: Y.Doc,
  from: number,
  to: number,
  textSnapshot?: string,
): AnchoredRangeResult | (RangeValidation & { ok: false }) {
  const validation = validateRange(ydoc, from, to, { textSnapshot });
  if (!validation.ok) return validation;

  const range: DocumentRange = { from, to };

  // Create CRDT-anchored positions
  const fromRel = flatOffsetToRelPos(ydoc, from, 0); // assoc 0: stick right
  const toRel = flatOffsetToRelPos(ydoc, to, -1); // assoc -1: stick left
  const relRange: RelativeRange | undefined = fromRel && toRel ? { fromRel, toRel } : undefined;

  return { ok: true, range, relRange };
}

// ---------------------------------------------------------------------------
// High-level: annotation range refresh
// ---------------------------------------------------------------------------

/**
 * Refresh an annotation's flat offsets from its relRange, or lazily attach
 * relRange if missing. Returns the (possibly updated) annotation.
 * If `map` is provided, persists changes back to the Y.Map.
 */
export function refreshRange(ann: Annotation, ydoc: Y.Doc, map?: Y.Map<unknown>): Annotation {
  if (!ann.relRange) {
    // Lazy attachment: compute relRange from current flat offsets
    const fromRel = flatOffsetToRelPos(ydoc, ann.range.from, 0);
    const toRel = flatOffsetToRelPos(ydoc, ann.range.to, -1);
    if (!fromRel || !toRel) return ann;
    const updated = { ...ann, relRange: { fromRel, toRel } };
    if (map) map.set(ann.id, updated);
    return updated;
  }

  // Resolve relRange to current flat offsets
  const newFrom = relPosToFlatOffset(ydoc, ann.relRange.fromRel);
  const newTo = relPosToFlatOffset(ydoc, ann.relRange.toRel);
  if (newFrom === null || newTo === null) return ann; // deleted content, keep old range
  if (newFrom === ann.range.from && newTo === ann.range.to) return ann; // unchanged

  const updated = { ...ann, range: { from: newFrom, to: newTo } };
  if (map) map.set(ann.id, updated);
  return updated;
}

/** Refresh all annotations in a batch, wrapping Y.Map writes in a transaction. */
export function refreshAllRanges(
  annotations: Annotation[],
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
): Annotation[] {
  const results: Annotation[] = [];
  ydoc.transact(() => {
    for (const ann of annotations) {
      results.push(refreshRange(ann, ydoc, map));
    }
  });
  return results;
}
