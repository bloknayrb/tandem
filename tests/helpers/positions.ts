/**
 * Branded-coordinate and anchored-range fixtures for tests.
 *
 * `tests/` was outside every tsconfig until this unit, so a test could pass a
 * raw `number` where a `FlatOffset` was required, or a bare `{ range }` object
 * where an `AnchoredRangeResult` was required, and nothing anywhere said so.
 * Bringing the test tree into a checked program surfaced ~300 such sites. These
 * helpers exist so the fix is one import per file rather than a cast per call,
 * and so the *reason* each cast is sound lives in one place instead of 294 --
 * the measured call count of `off()` alone.
 *
 * @see tsconfig.tests.node.json, tsconfig.tests.client.json
 */
import {
  type AnchoredRangeResult,
  type DocumentRange,
  type FlatOffset,
  type PmPos,
  toFlatOffset,
  toPmPos,
} from "../../src/shared/positions/index.js";

/**
 * A flat text offset, from a literal.
 *
 * Deliberately a thin alias of the production factory rather than a bare
 * `as FlatOffset` cast: if the brand ever gains a runtime component, all ~290
 * call sites follow automatically instead of ~290 casts quietly lying.
 */
export const off = (n: number): FlatOffset => toFlatOffset(n);

/**
 * A ProseMirror position, from a literal. Same reasoning as {@link off}.
 *
 * Imported under an alias in at least one suite (`pm as pmPos` in
 * `tests/client/coordinate-conversion.test.ts`), so a grep for `pm(` under
 * `tests/` reports zero and is wrong. Two separate passes over this file
 * concluded it was dead on exactly that evidence.
 */
export const pm = (n: number): PmPos => toPmPos(n);

/**
 * A flat-offset range, from literals.
 *
 * Throws on `from > to`. `DocumentRange` cannot express the ordering
 * invariant its consumers assume, and production `validateRange()` rejects an
 * inverted range -- so a fixture that builds one is a typo whose symptom would
 * otherwise be a downstream assertion failing for an unrelated-looking reason.
 * A test that deliberately needs an inverted range to exercise that rejection
 * should build the object literal inline, where the intent is visible.
 */
export function range(from: number, to: number): DocumentRange {
  if (from > to) throw new Error(`range(${from}, ${to}): from must not exceed to`);
  return { from: off(from), to: off(to) };
}

/**
 * An `AnchoredRangeResult` for a range that resolved but carries NO CRDT anchor.
 *
 * Named `unanchored`, not `anchored`. A review caught the original name: ~48
 * call sites read `createAnnotation(map, ydoc, "comment", anchored(0, 5), ...)`,
 * which states the opposite of what it constructs, and the honestly-named
 * `anchoredWithRel` sibling had zero callers anywhere. The next author to read
 * `anchored(0, 5)` as "give me an anchored range" would get the flat-only
 * branch and a test that passes for the wrong reason.
 *
 * **`fullyAnchored: false` is deliberate, and changing it changes what the
 * calling tests exercise.** Before this unit these sites passed a bare
 * `{ range: { from, to } }`, so production reading `anchored.fullyAnchored` saw
 * `undefined` — falsy, i.e. this same branch. `false` preserves what those
 * tests have actually been exercising; `true` would be a silent rewrite of
 * their subject matter dressed up as a type fix. Verified: all seven production
 * readers treat it as `fullyAnchored ? relRange : undefined`, so `undefined`
 * and `false` are indistinguishable to every one of them.
 *
 * There is deliberately no `anchoredWithRel` counterpart. One existed, had no
 * callers, and an unused exported fixture is precisely the thing that drifts —
 * a test that genuinely needs the anchored branch should build it through
 * `rangeOf(from, to, ydoc)` in `ydoc-factory.ts`, which produces a real
 * `relRange` rather than a hand-made one.
 */
export function unanchored(from: number, to: number): AnchoredRangeResult {
  return { ok: true, fullyAnchored: false, range: range(from, to) };
}
