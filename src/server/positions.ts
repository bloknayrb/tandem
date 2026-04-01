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
import type { Annotation } from "../shared/types.js";
import { MCP_ORIGIN } from "./events/queue.js";
import type {
  FlatOffset,
  SerializedRelPos,
  DocumentRange,
  RelativeRange,
  RangeValidation,
  AnchoredRangeResult,
  ElementPosition,
} from "../shared/positions/index.js";
import { toFlatOffset, toSerializedRelPos } from "../shared/positions/index.js";
import {
  getElementText,
  extractText,
  findXmlText,
  getHeadingPrefixLength,
} from "./mcp/document-model.js";

// ---------------------------------------------------------------------------
// Low-level: element resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a flat character offset to a Y.Doc element position.
 * Needed by tandem_edit for cross-element deletion logic.
 */
export function resolveToElement(
  fragment: Y.XmlFragment,
  charOffset: FlatOffset,
): ElementPosition | null {
  let accumulated = 0;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    const prefixLen = getHeadingPrefixLength(node);
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
export function flatOffsetToRelPos(
  doc: Y.Doc,
  offset: FlatOffset,
  assoc: 0 | -1,
): SerializedRelPos | null {
  const fragment = doc.getXmlFragment("default");
  const resolved = resolveToElement(fragment, offset);
  if (!resolved || resolved.clampedFromPrefix) return null;

  const node = fragment.get(resolved.elementIndex);
  if (!(node instanceof Y.XmlElement)) return null;

  const xmlText = findXmlText(node);
  if (!xmlText) return null;
  const rpos = Y.createRelativePositionFromTypeIndex(xmlText, resolved.textOffset, assoc);
  return toSerializedRelPos(Y.relativePositionToJSON(rpos));
}

/**
 * Resolve a JSON-serialized Yjs RelativePosition back to a flat text offset.
 * Returns null if the referenced content was deleted.
 */
export function relPosToFlatOffset(doc: Y.Doc, relPosJson: SerializedRelPos): FlatOffset | null {
  let absPos;
  try {
    const rpos = Y.createRelativePositionFromJSON(relPosJson);
    absPos = Y.createAbsolutePositionFromRelativePosition(rpos, doc);
  } catch (err) {
    if (!(err instanceof TypeError) && !(err instanceof SyntaxError)) {
      console.error("[positions] relPosToFlatOffset: unexpected error resolving relRange:", err);
    }
    return null;
  }
  if (!absPos) return null;

  const fragment = doc.getXmlFragment("default");
  let accumulated = 0;

  for (let i = 0; i < fragment.length; i++) {
    const node = fragment.get(i);
    if (!(node instanceof Y.XmlElement)) continue;

    const prefixLen = getHeadingPrefixLength(node);
    const text = getElementText(node);

    const xmlText = findXmlText(node);
    if (xmlText && xmlText === absPos.type) {
      return toFlatOffset(accumulated + prefixLen + absPos.index);
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
 */
export function validateRange(
  ydoc: Y.Doc,
  from: FlatOffset,
  to: FlatOffset,
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
        return { ok: false, code: "RANGE_GONE" };
      }
      const best = candidates.reduce((a, b) => (Math.abs(a - from) <= Math.abs(b - from) ? a : b));
      return {
        ok: false,
        code: "RANGE_MOVED",
        resolvedFrom: toFlatOffset(best),
        resolvedTo: toFlatOffset(best + opts.textSnapshot.length),
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
 */
export function anchoredRange(
  ydoc: Y.Doc,
  from: FlatOffset,
  to: FlatOffset,
  textSnapshot?: string,
): AnchoredRangeResult | (RangeValidation & { ok: false }) {
  const validation = validateRange(ydoc, from, to, { textSnapshot });
  if (!validation.ok) return validation;

  const range: DocumentRange = { from, to };

  // Create CRDT-anchored positions
  const fromRel = flatOffsetToRelPos(ydoc, from, 0); // assoc 0: stick right
  const toRel = flatOffsetToRelPos(ydoc, to, -1); // assoc -1: stick left
  const relRange: RelativeRange | undefined = fromRel && toRel ? { fromRel, toRel } : undefined;

  if (!relRange) {
    const fragment = ydoc.getXmlFragment("default");
    const fromEl = resolveToElement(fragment, from);
    const toEl = resolveToElement(fragment, to);
    if (fromEl && !fromEl.clampedFromPrefix && toEl && !toEl.clampedFromPrefix) {
      console.error(`[positions] anchoredRange: relRange creation failed for [${from}, ${to}]`);
    }
  }

  if (relRange) {
    return { ok: true, fullyAnchored: true, range, relRange };
  }
  return { ok: true, fullyAnchored: false, range };
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
  if (newFrom === null || newTo === null) return ann; // deleted content
  if (newFrom > newTo) {
    console.error(
      `[positions] refreshRange: inverted CRDT range for annotation ${ann.id}: ` +
        `resolved [${newFrom}, ${newTo}] from flat [${ann.range.from}, ${ann.range.to}]`,
    );
    return ann;
  }
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
  }, MCP_ORIGIN);
  return results;
}
