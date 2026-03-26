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

import type { DocumentRange, RelativeRange } from "../types.js";

/** Result of validating a flat-offset range against a document. */
export type RangeValidation =
  | { ok: true; range: DocumentRange }
  | { ok: false; code: "RANGE_STALE"; gone: true }
  | { ok: false; code: "RANGE_STALE"; gone: false; resolvedFrom: number; resolvedTo: number }
  | { ok: false; code: "INVALID_RANGE"; message: string }
  | { ok: false; code: "HEADING_OVERLAP" };

/** Result of anchoredRange: validated flat + CRDT-anchored range ready to store on an Annotation. */
export interface AnchoredRangeResult {
  ok: true;
  range: DocumentRange;
  relRange?: RelativeRange;
}

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
  from: number;
  to: number;
  /** Which coordinate path was used to resolve the range. */
  method: ResolutionMethod;
}
