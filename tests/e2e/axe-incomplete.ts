/**
 * A per-surface ceiling on axe's `color-contrast` **incomplete** nodes (#1721).
 *
 * `accessibility.spec.ts` asserted `results.violations` only. axe has three
 * buckets, and a contrast failure that lands in `incomplete` was therefore
 * unasserted by construction — measured: a mid-grey annotation card behind dark
 * body text reported `violations: []` in all three themes.
 *
 * This is option 3 from the issue: a count pin. It makes a JUMP loud. It does
 * NOT say any individual incomplete node is acceptable, and it is not a contrast
 * gate — deciding what these nodes mean is what keeps #1721 open, and the gate
 * deliberately does not depend on that answer.
 *
 * Not a `.spec.ts`/`.test.ts`: Playwright's default `testMatch` under
 * `testDir: "tests/e2e"` must not collect it, and neither must vitest's node
 * project. It imports nothing, so it resolves into either program.
 */

export type AxeBucketEntry = { id: string; nodes: unknown[] };

/** Nodes of the `color-contrast` entry in an axe bucket; `0` when absent. */
export function colorContrastNodeCount(entries: AxeBucketEntry[]): number {
  return entries.find((e) => e.id === "color-contrast")?.nodes.length ?? 0;
}

/**
 * `null` when `observed` is within the committed ceiling, else a message.
 *
 * Fails CLOSED on a key with no baseline row: a surface added to `SURFACES`
 * must be measured, not silently unmeasured — an unmeasured surface is the same
 * gap this issue is about, and `check` would stay green over it forever.
 */
export function checkIncompleteBaseline(
  key: string,
  observed: number,
  baseline: Record<string, number>,
): string | null {
  const limit = baseline[key];
  if (typeof limit !== "number") {
    return `${key}: no baseline row (observed ${observed}). Measure this surface and commit its count to tests/e2e/axe-incomplete-baseline.json.`;
  }
  if (observed <= limit) return null;
  return `${key}: ${observed} color-contrast incomplete nodes, baseline ${limit}. Something changed what axe cannot evaluate on this surface — investigate before re-seeding.`;
}
