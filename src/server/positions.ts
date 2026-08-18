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
import { withMcp } from "../shared/origins.js";
import type {
  AnchoredRangeResult,
  DocumentRange,
  FlatOffset,
  RangeValidation,
  RefreshResult,
  RelativeRange,
  SerializedRelPos,
} from "../shared/positions/index.js";
import { toFlatOffset } from "../shared/positions/index.js";
import {
  anchorFlatRange,
  flatOffsetToRelPos,
  getElementTextLength,
  getHeadingPrefixLength,
  resolveToElement,
} from "../shared/positions/ydoc.js";
import type { Annotation } from "../shared/types.js";
import { collectXmlTexts, extractText } from "./mcp/document-model.js";

// Moved to `src/shared/positions/ydoc.ts` — see that file's header for why the
// move is a leaf extraction rather than a file move. Re-exported so existing
// importers of `server/positions` keep working untouched.
export { anchorFlatRange, flatOffsetToRelPos, resolveToElement };

// ---------------------------------------------------------------------------
// Low-level: element resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Low-level: RelativePosition conversion
// ---------------------------------------------------------------------------

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

    const xmlTexts = collectXmlTexts(node);
    for (const { xmlText, offsetFromStart } of xmlTexts) {
      if (xmlText === absPos.type) {
        return toFlatOffset(accumulated + prefixLen + offsetFromStart + absPos.index);
      }
    }

    accumulated += prefixLen + getElementTextLength(node);
    if (i < fragment.length - 1) {
      accumulated += 1;
    }
  }

  console.error(
    "[positions] relPosToFlatOffset: absPos resolved but no matching XmlText found in traversal",
  );
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
 * Pass `opts.rejectHeadingOverlap: true` to also reject ranges that overlap
 * heading prefixes (same guard used by `tandem_edit`).
 *
 * Sole assembler of `RelativeRange` at annotation birth — `refreshRange`'s
 * lazy-attach and dead-relRange repair branches are the only other sites that
 * assemble the `{fromRel, toRel}` shape, and both live in this file. Wire-shape
 * changes to `SerializedRelPos` require updating `SerializedRelPosSchema`,
 * both readers, and any on-disk JSON predating the change.
 */
export function anchoredRange(
  ydoc: Y.Doc,
  from: FlatOffset,
  to: FlatOffset,
  textSnapshot?: string,
  opts?: { rejectHeadingOverlap?: boolean },
): AnchoredRangeResult | (RangeValidation & { ok: false }) {
  const validation = validateRange(ydoc, from, to, {
    textSnapshot,
    rejectHeadingOverlap: opts?.rejectHeadingOverlap,
  });
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
 * relRange if missing. Returns a tagged `RefreshResult` (ADR-032) so
 * callers can distinguish healthy / updated / attached / repaired /
 * degraded / failed paths instead of treating every outcome as success.
 * If `map` is provided, persists changes back to the Y.Map.
 *
 * The lazy-attach and dead-relRange repair branches below are the two
 * intentional `{fromRel, toRel}` re-assembly sites referenced by
 * `anchoredRange`'s JSDoc — both repair existing annotations rather than
 * minting new ones, so the shape duplication is deliberate, not a DRY gap.
 */
export function refreshRange(ann: Annotation, ydoc: Y.Doc, map?: Y.Map<unknown>): RefreshResult {
  if (!ann.relRange) {
    // Lazy attachment: compute relRange from current flat offsets
    const fromRel = flatOffsetToRelPos(ydoc, ann.range.from, 0);
    const toRel = flatOffsetToRelPos(ydoc, ann.range.to, -1);
    if (!fromRel || !toRel) return { kind: "degraded", annotation: ann };
    const updated = { ...ann, relRange: { fromRel, toRel } };
    if (map) map.set(ann.id, updated);
    return { kind: "attached", annotation: updated };
  }

  // Resolve relRange to current flat offsets
  const newFrom = relPosToFlatOffset(ydoc, ann.relRange.fromRel);
  const newTo = relPosToFlatOffset(ydoc, ann.relRange.toRel);
  if (newFrom === null || newTo === null) {
    if (newFrom !== null || newTo !== null) {
      console.error(
        `[positions] refreshRange: partial CRDT resolution for ${ann.id} ` +
          `(from: ${newFrom !== null ? "ok" : "dead"}, to: ${newTo !== null ? "ok" : "dead"})`,
      );
    }
    // CRDT resolution failed (items deleted after content replacement).
    // Strip the dead relRange and attempt re-anchoring from flat offsets.
    const fromRel = flatOffsetToRelPos(ydoc, ann.range.from, 0);
    const toRel = flatOffsetToRelPos(ydoc, ann.range.to, -1);
    if (fromRel && toRel) {
      const updated: Annotation = { ...ann, relRange: { fromRel, toRel } };
      if (map) map.set(ann.id, updated);
      return { kind: "repaired", annotation: updated };
    }
    // Can't re-anchor — strip dead relRange so lazy path works next time
    const stripped: Annotation = { ...ann };
    delete stripped.relRange;
    if (map) map.set(ann.id, stripped);
    return { kind: "degraded", annotation: stripped };
  }
  if (newFrom > newTo) {
    console.error(
      `[positions] refreshRange: inverted CRDT range for annotation ${ann.id}: ` +
        `resolved [${newFrom}, ${newTo}] from flat [${ann.range.from}, ${ann.range.to}]`,
    );
    return { kind: "failed", annotation: ann };
  }
  if (newFrom === ann.range.from && newTo === ann.range.to) {
    return { kind: "ok", annotation: ann };
  }

  const updated = { ...ann, range: { from: newFrom, to: newTo } };
  if (map) map.set(ann.id, updated);
  return { kind: "updated", annotation: updated };
}

/**
 * Refresh all annotations in a batch, wrapping Y.Map writes in a transaction.
 *
 * When `skipTransact` is true, writes happen inline without wrapping a
 * `ydoc.transact`. The caller is responsible for providing an outer
 * transaction with the appropriate origin. Used by `reloadFromDisk` to merge
 * this pass with the subsequent textSnapshot relocation pass into a single
 * `MCP_ORIGIN` transaction (closes the two-write crash window — GH #622).
 */
export function refreshAllRanges(
  annotations: Annotation[],
  ydoc: Y.Doc,
  map: Y.Map<unknown>,
  opts?: { skipTransact?: boolean },
): RefreshResult[] {
  const results: RefreshResult[] = [];
  const run = () => {
    for (const ann of annotations) {
      results.push(refreshRange(ann, ydoc, map));
    }
  };
  if (opts?.skipTransact) {
    run();
  } else {
    withMcp(ydoc, run);
  }

  // PR #705 review observability: surface CRDT corruption (`failed` kind —
  // inverted CRDT range) at the aggregator boundary. The individual
  // refreshRange already logs via console.error; this lifts a count + IDs
  // above the per-annotation noise so a batched reload makes the corruption
  // visible without log-scraping.
  const failed = results.filter((r) => r.kind === "failed");
  if (failed.length > 0) {
    console.warn(
      `[positions] refreshAllRanges: ${failed.length} annotation(s) failed CRDT refresh: ${failed
        .map((r) => r.annotation.id)
        .join(", ")}`,
    );
  }

  return results;
}

/**
 * Exhaustive-match helper. Use in `switch (result.kind)` defaults so future
 * additions to the `RefreshResult` discriminator produce a compile error
 * at every call site that should branch on the new kind.
 */
export function assertNeverRefreshResult(value: never): never {
  throw new Error(`Unexpected RefreshResult kind: ${JSON.stringify(value)}`);
}
