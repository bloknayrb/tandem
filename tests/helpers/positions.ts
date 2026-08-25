/**
 * Branded-coordinate and anchored-range fixtures for tests.
 *
 * `tests/` was outside every tsconfig until this unit, so a test could pass a
 * raw `number` where a `FlatOffset` was required, or a bare `{ range }` object
 * where an `AnchoredRangeResult` was required, and nothing anywhere said so.
 * Bringing the test tree into a checked program surfaced ~300 such sites. These
 * helpers exist so the fix is one import per file rather than a cast per call,
 * and so the *reason* each cast is sound lives in one place instead of 300.
 *
 * @see tsconfig.tests.node.json, tsconfig.tests.client.json
 */
import {
  type AnchoredRangeResult,
  type DocumentRange,
  type FlatOffset,
  type PmPos,
  type RelativeRange,
  toFlatOffset,
  toPmPos,
} from "../../src/shared/positions/index.js";

/**
 * A flat text offset, from a literal.
 *
 * Deliberately a thin alias of the production factory rather than a bare
 * `as FlatOffset` cast: if the brand ever gains a runtime component, every test
 * follows automatically instead of 150 casts quietly lying.
 */
export const off = (n: number): FlatOffset => toFlatOffset(n);

/** A ProseMirror position, from a literal. Same reasoning as {@link off}. */
export const pm = (n: number): PmPos => toPmPos(n);

/** A flat-offset range, from literals. */
export function range(from: number, to: number): DocumentRange {
  return { from: off(from), to: off(to) };
}

/**
 * An `AnchoredRangeResult` for a range that resolved but carries no CRDT anchor.
 *
 * **`fullyAnchored` defaults to `false` on purpose, and changing that default
 * changes what the calling tests exercise.** Before this unit these call sites
 * passed a bare `{ range: { from, to } }`, so production code reading
 * `anchored.fullyAnchored` saw `undefined` — falsy, i.e. the unanchored branch.
 * Defaulting to `false` therefore preserves the behaviour every one of those
 * tests has actually been exercising. Defaulting to `true` would have been a
 * silent rewrite of their subject matter dressed up as a type fix.
 *
 * Use {@link anchoredWithRel} when a test genuinely means the anchored branch.
 */
export function anchored(from: number, to: number): AnchoredRangeResult {
  return { ok: true, fullyAnchored: false, range: range(from, to) };
}

/** An `AnchoredRangeResult` carrying a CRDT anchor — the `fullyAnchored` branch. */
export function anchoredWithRel(
  from: number,
  to: number,
  relRange: RelativeRange,
): AnchoredRangeResult {
  return { ok: true, fullyAnchored: true, range: range(from, to), relRange };
}
