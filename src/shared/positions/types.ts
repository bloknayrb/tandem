/**
 * Shared types for the position/coordinate system.
 *
 * Three coordinate systems exist in Tandem:
 *   1. Flat text offsets — server-side, includes heading prefixes and \n separators
 *   2. ProseMirror positions — client-side, structural node positions
 *   3. Yjs RelativePositions — CRDT-anchored, survive concurrent edits
 *
 * This module defines the shared vocabulary. Environment-specific logic lives in:
 *   - src/server/positions.ts (Y.Doc operations)
 *   - src/client/positions.ts (ProseMirror operations)
 */

// ---------------------------------------------------------------------------
// Branded types — compile-time guards against mixing coordinate systems
// ---------------------------------------------------------------------------

declare const FlatOffsetBrand: unique symbol;
declare const PmPosBrand: unique symbol;
declare const SerializedRelPosBrand: unique symbol;

/** Flat text offset (includes heading prefixes & \n separators). Server/MCP boundary. */
export type FlatOffset = number & { readonly [FlatOffsetBrand]: true };

/** ProseMirror position (structural node boundaries). Client-side only. */
export type PmPos = number & { readonly [PmPosBrand]: true };

/** JSON-serialized Y.js RelativePosition. Opaque — only created/consumed by position modules. */
export type SerializedRelPos = unknown & { readonly [SerializedRelPosBrand]: true };

// ---------------------------------------------------------------------------
// Factory functions — cast raw values into branded types
// ---------------------------------------------------------------------------

export const toFlatOffset = (n: number): FlatOffset => n as FlatOffset;
export const toPmPos = (n: number): PmPos => n as PmPos;
export const toSerializedRelPos = (json: unknown): SerializedRelPos => json as SerializedRelPos;

// ---------------------------------------------------------------------------
// Range and result types
// ---------------------------------------------------------------------------

/** Flat-offset range used by MCP tools and annotations. */
export interface DocumentRange {
  from: FlatOffset;
  to: FlatOffset;
}

/** CRDT-anchored range that survives concurrent edits. Serialized via Y.relativePositionToJSON(). */
export interface RelativeRange {
  fromRel: SerializedRelPos;
  toRel: SerializedRelPos;
}

/** Result of validating a flat-offset range against a document. */
export type RangeValidation =
  | { ok: true; range: DocumentRange }
  | { ok: false; code: "RANGE_GONE" }
  | { ok: false; code: "RANGE_MOVED"; resolvedFrom: FlatOffset; resolvedTo: FlatOffset }
  | { ok: false; code: "INVALID_RANGE"; message: string }
  | { ok: false; code: "HEADING_OVERLAP" };

/** Result of anchoredRange: validated flat + CRDT-anchored range ready to store on an Annotation. */
export type AnchoredRangeResult =
  | { ok: true; fullyAnchored: true; range: DocumentRange; relRange: RelativeRange }
  | { ok: true; fullyAnchored: false; range: DocumentRange; relRange?: undefined };

/** A resolved element position inside a Y.Doc XmlFragment. */
export interface ElementPosition {
  elementIndex: number;
  /** Character offset within the element's text. Always 0 when clampedFromPrefix is true. */
  textOffset: number;
  /** True if the original offset fell inside a heading prefix and was clamped to 0 */
  clampedFromPrefix: boolean;
}

/**
 * A flat offset resolved all the way down to the textblock that owns it.
 *
 * `ElementPosition` stops at the top level, which is right for the cross-element
 * edit path (it needs `fragment.delete` indices) and wrong for everything else:
 * an offset inside a list resolves to the `bulletList` CONTAINER, whose flat
 * span covers every item. This carries the deepest textblock instead.
 *
 * There is deliberately no `topIndex` convenience field. It would be `path[0]`,
 * and an equality test on it is a corruption trap: two different list items
 * share a top-level index, so `startPos.topIndex === endPos.topIndex` reads a
 * cross-item range as a same-block one and edits with offsets measured against
 * two different elements — inside the transaction, which Y.js does not roll
 * back. The two questions have distinct tests: "is this top-level?" is
 * `path.length === 1`, and "same block?" is full path equality (`sameTextblock`).
 */
export interface TextblockPosition {
  /** Child indices from the fragment root down to the textblock. Never empty. */
  path: number[];
  /** Flat offset relative to the textblock's own start. */
  textOffset: number;
  /**
   * True if the offset fell inside a heading prefix and was clamped to 0.
   * Top-level headings only — `extractTextWithBreaks` emits a prefix in its own
   * top-level loop, while a nested heading is traversed by `collectElementFlat`,
   * which emits none.
   */
  clampedFromPrefix: boolean;
}

/**
 * Whether two resolved positions land in the very same textblock.
 *
 * Named for the block rather than the path because `samePath` is already taken
 * by an unrelated filesystem-path comparison in `launcher/supervisor.ts`, and
 * two exported `samePath`s with different meanings is a trap.
 */
export function sameTextblock(a: TextblockPosition, b: TextblockPosition): boolean {
  return a.path.length === b.path.length && a.path.every((v, i) => v === b.path[i]);
}

/** Whether a resolved position is a direct child of the fragment root. */
export function isTopLevel(p: TextblockPosition): boolean {
  return p.path.length === 1;
}

/** Resolution method used by annotationToPmRange, for diagnostic observability. */
export type ResolutionMethod = "rel" | "flat";

/** Result of resolving an annotation to ProseMirror positions. */
export interface PmRangeResult {
  from: PmPos;
  to: PmPos;
  /** Which coordinate path was used to resolve the range. */
  method: ResolutionMethod;
}

/**
 * Tagged variant for the outcome of `refreshRange` (ADR-032).
 *
 * Each kind names a distinct resolution path the function previously
 * collapsed into a bare `Annotation` return:
 *  - `ok`        — annotation unchanged; range was already healthy
 *  - `updated`   — `relRange` resolved to new offsets; flat `range` was rewritten
 *  - `attached`  — annotation had no `relRange`; one was computed from the flat range
 *  - `repaired`  — dead `relRange` was re-anchored from the flat range
 *  - `degraded`  — dead `relRange` was stripped; annotation is now flat-only and will
 *                  be lazy-attached on a later read if conditions improve
 *  - `failed`    — `from > to` after refresh ("inverted CRDT range" — concurrent
 *                  edits moved the anchors past each other). Annotation is returned
 *                  unchanged for the caller's inspection.
 */
export type RefreshResult = {
  kind: "ok" | "updated" | "attached" | "repaired" | "degraded" | "failed";
  annotation: import("../types.js").Annotation;
};
