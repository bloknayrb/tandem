/**
 * The pure half of #1721's per-surface ceiling on axe's `color-contrast`
 * **incomplete** nodes. Why the ceiling exists, what it measured, and what it
 * does NOT buy are on `INCOMPLETE_BASELINE` in `accessibility.spec.ts`; kept
 * there so the history has one home.
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
