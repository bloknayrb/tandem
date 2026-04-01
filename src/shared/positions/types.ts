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

/** Resolution method used by annotationToPmRange, for diagnostic observability. */
export type ResolutionMethod = "rel" | "flat";

/** Result of resolving an annotation to ProseMirror positions. */
export interface PmRangeResult {
  from: PmPos;
  to: PmPos;
  /** Which coordinate path was used to resolve the range. */
  method: ResolutionMethod;
}
