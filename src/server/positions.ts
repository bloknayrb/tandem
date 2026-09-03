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
  RangeInvalidReason,
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
import { collectXmlTexts, extractText, flatDocLength } from "./mcp/document-model.js";

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

/** How `validateRange`/`validateFlatRange` treat an offset that splits a surrogate pair. */
export type SurrogatePolicy = "reject" | "ignore";

/** The opts that apply to the text-only checks, shared with `validateFlatRange`. */
export interface FlatRangeOpts {
  /** Permit `from === to`. Point comments (Word insertion markers) need it. */
  allowEmpty?: boolean;
  /**
   * `"ignore"` skips the surrogate check. For STORED/derived offsets only —
   * after a CRDT edit inside an emoji a refreshed range can legitimately end
   * mid-pair (Word's own offsets are UTF-16), and rejecting those would score a
   * real comment as lost. The new rule is for the caller-supplied tool
   * boundary. Default `"reject"`.
   */
  surrogates?: SurrogatePolicy;
}

/** Options shared by `validateRange` and `anchoredRange`. */
export interface RangeValidationOpts extends FlatRangeOpts {
  textSnapshot?: string;
  rejectHeadingOverlap?: boolean;
  /**
   * A pre-computed `extractText(ydoc)` for THIS call, so a loop over an
   * unchanging document builds the string once instead of per iteration.
   *
   * Two guards below, one of them in production — and the production one is a
   * SMOKE ALARM, not a contract: it catches only a length-CHANGING mutation. A
   * same-length edit, or a sibling document of equal length, passes it and
   * silently changes the staleness and surrogate verdicts. Pass it only from a
   * genuine loop over a document that does not change across the loop.
   */
  text?: string;
}

function invalid(reason: RangeInvalidReason, message: string): RangeValidation & { ok: false } {
  return { ok: false, code: "INVALID_RANGE", message, reason };
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Is this UTF-16 code unit the TRAILING half of a surrogate pair?
 *
 * Exported for the one caller that must SNAP rather than reject: the .docx
 * comment export resolver, which carries stored offsets and writes a file.
 */
export function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Does offset `i` fall BETWEEN the two halves of a surrogate pair?
 *
 * The paired form is the whole point. A one-sided "the unit at `i` is any
 * surrogate" check passes every `"a<emoji>b"` case and then rejects offset 2 of
 * `"<emoji><emoji>"` — the legal boundary between two adjacent astral
 * characters, which has no alternative offset. At `i === text.length`
 * `charCodeAt` is NaN, which is neither, so the document end is always legal.
 */
export function splitsSurrogatePair(text: string, i: number): boolean {
  if (i <= 0) return false;
  return isHighSurrogate(text.charCodeAt(i - 1)) && isLowSurrogate(text.charCodeAt(i));
}

/**
 * The checks that need no document text: integrality, ordering, lower bound.
 *
 * Split out because `validateRange` must run these BEFORE the staleness gate
 * and the rest AFTER it. `String.prototype.slice` wraps a negative start
 * (`"hello world".slice(-3, 11) === "rld"`), so a negative `from` with a
 * coincidentally matching snapshot would pass staleness, and a non-matching one
 * would be answered with a relocation instead of `out-of-bounds`.
 */
function checkOffsetShape(from: number, to: number): (RangeValidation & { ok: false }) | null {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return invalid(
      "non-integer",
      `Invalid range: from (${from}) and to (${to}) must both be integers.`,
    );
  }
  if (from > to) {
    return invalid("inverted", `Invalid range: from (${from}) must be <= to (${to}).`);
  }
  if (from < 0) {
    return invalid("out-of-bounds", `Invalid range: from (${from}) must be >= 0.`);
  }
  return null;
}

/** Upper bound, emptiness and surrogate safety, against the materialized text. */
function checkAgainstText(
  text: string,
  from: number,
  to: number,
  opts: FlatRangeOpts | undefined,
): (RangeValidation & { ok: false }) | null {
  if (to > text.length) {
    return invalid(
      "out-of-bounds",
      `Invalid range: to (${to}) exceeds document length (${text.length}).`,
    );
  }
  if (from === to && !opts?.allowEmpty) {
    return invalid("empty", `Invalid range: [${from}, ${to}) is empty.`);
  }
  if ((opts?.surrogates ?? "reject") === "reject") {
    if (splitsSurrogatePair(text, from)) {
      return invalid("surrogate", `Invalid range: from (${from}) splits a surrogate pair.`);
    }
    if (splitsSurrogatePair(text, to)) {
      return invalid("surrogate", `Invalid range: to (${to}) splits a surrogate pair.`);
    }
  }
  return null;
}

/**
 * Validate a flat-offset range against a plain string — no Y.Doc needed.
 *
 * The pure core of {@link validateRange}, and the entry point for the two
 * callers that hold the flat text but deliberately no `Y.Doc`
 * (`tandem_getContext` through a `YDocStore`, and the `.docx` comment export
 * resolver, which resolves through `refreshRange`).
 *
 * Order: integer, ordering, lower bound, upper bound, emptiness, surrogate.
 */
export function validateFlatRange(
  text: string,
  from: number,
  to: number,
  opts?: FlatRangeOpts,
): RangeValidation {
  const shape = checkOffsetShape(from, to);
  if (shape) return shape;
  const against = checkAgainstText(text, from, to, opts);
  if (against) return against;
  return { ok: true, range: { from: toFlatOffset(from), to: toFlatOffset(to) } };
}

/**
 * The flat text for this call, honouring a hoisted `opts.text` when it is safe.
 *
 * Guard (a) runs ALWAYS and costs no materialization: `flatDocLength` walks the
 * tree reading `child.length` and builds no string. It is still a walk per
 * call — the hoist buys one string build per loop, not one walk.
 *
 * Guard (b) runs under `process.env.VITEST === "true"` — deliberately not
 * `NODE_ENV` (a tsup-built server started without one evaluates
 * `!== "production"` as true; precedent: `integrations/api-routes.ts`).
 *
 * Both recover by recomputing rather than throwing: this runs inside MCP tool
 * handlers, where a throw is a worse outcome than a slow correct answer.
 */
function resolveDocText(ydoc: Y.Doc, provided: string | undefined): string {
  if (provided === undefined) return extractText(ydoc);
  const trueLength = flatDocLength(ydoc);
  if (provided.length !== trueLength) {
    console.error(
      `[positions] validateRange: hoisted text length ${provided.length} != document length ` +
        `${trueLength} — recomputing. The caller's document changed under the hoist.`,
    );
    return extractText(ydoc);
  }
  if (process.env.VITEST === "true") {
    const actual = extractText(ydoc);
    if (provided !== actual) {
      console.error(
        "[positions] validateRange: hoisted text has the right LENGTH but the wrong content — recomputing.",
      );
      return actual;
    }
  }
  return provided;
}

/**
 * Validate a flat-offset range against a Y.Doc.
 *
 * Order (#1752), and the order is the contract:
 *   integer → ordering → lower bound → **staleness** → upper bound → empty →
 *   surrogate → heading overlap.
 *
 * Two placements are load-bearing rather than arbitrary:
 *
 *  - **Lower bound BEFORE staleness**, because `slice` wraps a negative start.
 *  - **Upper bound AFTER staleness.** After an external edit shortens the file,
 *    the watcher's relocation probe passes stale offsets past the new end WITH
 *    a snapshot and relies on `RANGE_MOVED`. Bounds-first would answer
 *    `INVALID_RANGE` and pin the annotation to dead offsets — silent annotation
 *    loss. Same for `tandem_edit`'s documented retry path. So with a mismatched
 *    `textSnapshot`, a staleness outcome WINS over `out-of-bounds`, and the
 *    surrogate check applies only to a range about to be returned `ok`;
 *    relocated coordinates are re-checked on the caller's retry.
 *
 * Two accidents are pinned by tests rather than redesigned: the staleness gate
 * is truthiness-checked, so an empty `textSnapshot` skips it (do not change to
 * `!== undefined`); and with a snapshot `from === to` never reaches `"empty"`,
 * because the slice is `""` and staleness fires first.
 */
export function validateRange(
  ydoc: Y.Doc,
  from: FlatOffset,
  to: FlatOffset,
  opts?: RangeValidationOpts,
): RangeValidation {
  const rejectHeadingOverlap = opts?.rejectHeadingOverlap ?? false;

  const shape = checkOffsetShape(from, to);
  if (shape) return shape;

  // ONE materialization, shared by staleness, bounds and the surrogate check.
  // Previously computed only when a snapshot was given; making it unconditional
  // adds a full-document walk to every `anchoredRange` caller (~3.5 ms at
  // 460 KB per `flatDocLength`'s own docstring). Accepted.
  const fullText = resolveDocText(ydoc, opts?.text);

  // Staleness check
  if (opts?.textSnapshot) {
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

  const against = checkAgainstText(fullText, from, to, opts);
  if (against) return against;

  // Heading overlap check
  if (rejectHeadingOverlap) {
    const fragment = ydoc.getXmlFragment("default");
    const startPos = resolveToElement(fragment, from);
    const endPos = resolveToElement(fragment, to);
    if (!startPos || !endPos) {
      return invalid("unresolvable", `Cannot resolve offset range [${from}, ${to}] in document.`);
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
  opts?: Omit<RangeValidationOpts, "textSnapshot">,
): AnchoredRangeResult | (RangeValidation & { ok: false }) {
  const validation = validateRange(ydoc, from, to, { ...opts, textSnapshot });
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
