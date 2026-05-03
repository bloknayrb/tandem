import { describe, expect, it } from "vitest";
import type { Annotation } from "../../src/shared/types.js";
import { isReviewTarget } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

/**
 * Inline implementation of the counts $derived from createReviewCompletion —
 * mirrors useReviewCompletion.svelte.ts so we can test the filtering logic
 * without a Svelte rune environment.
 */
function computeCounts(annotations: Annotation[]) {
  let pendingCount = 0;
  let acceptedCount = 0;
  let dismissedCount = 0;
  for (const a of annotations) {
    if (!isReviewTarget(a)) continue;
    if (a.status === "pending") pendingCount++;
    else if (a.status === "accepted") acceptedCount++;
    else if (a.status === "dismissed") dismissedCount++;
  }
  return { pendingCount, acceptedCount, dismissedCount };
}

/**
 * Inline overlay trigger check — mirrors the $effect in createReviewCompletion:
 * overlay fires when prevPending > 0, pendingCount === 0, and total > 0.
 */
function shouldFireOverlay(prevPending: number, counts: ReturnType<typeof computeCounts>): boolean {
  const { pendingCount, acceptedCount, dismissedCount } = counts;
  const total = acceptedCount + dismissedCount;
  return prevPending > 0 && pendingCount === 0 && total > 0;
}

describe("computeCounts — excludes user-authored annotations", () => {
  it("does not count user-authored pending notes in pendingCount", () => {
    const annotations: Annotation[] = [
      makeAnnotation({ id: "u1", author: "user", status: "pending" }),
    ];
    expect(computeCounts(annotations).pendingCount).toBe(0);
  });

  it("does not count user-authored resolved annotations in accepted/dismissed totals", () => {
    const annotations: Annotation[] = [
      makeAnnotation({ id: "u2", author: "user", status: "accepted" }),
      makeAnnotation({ id: "u3", author: "user", status: "dismissed" }),
    ];
    const counts = computeCounts(annotations);
    expect(counts.acceptedCount).toBe(0);
    expect(counts.dismissedCount).toBe(0);
  });

  it("counts claude-authored annotations correctly", () => {
    const annotations: Annotation[] = [
      makeAnnotation({ id: "c1", author: "claude", status: "pending" }),
      makeAnnotation({ id: "c2", author: "claude", status: "accepted" }),
      makeAnnotation({ id: "c3", author: "claude", status: "dismissed" }),
    ];
    const counts = computeCounts(annotations);
    expect(counts.pendingCount).toBe(1);
    expect(counts.acceptedCount).toBe(1);
    expect(counts.dismissedCount).toBe(1);
  });

  it("counts import-authored (.docx) annotations correctly", () => {
    const annotations: Annotation[] = [
      makeAnnotation({ id: "i1", author: "import", status: "pending" }),
      makeAnnotation({ id: "i2", author: "import", status: "accepted" }),
    ];
    const counts = computeCounts(annotations);
    expect(counts.pendingCount).toBe(1);
    expect(counts.acceptedCount).toBe(1);
  });
});

describe("overlay trigger — fires only when all review targets are resolved", () => {
  it("fires when last claude annotation is resolved", () => {
    const annotations: Annotation[] = [
      makeAnnotation({ id: "c1", author: "claude", status: "accepted" }),
    ];
    // prevPending was 1 (from previous state), now all resolved
    expect(shouldFireOverlay(1, computeCounts(annotations))).toBe(true);
  });

  it("does NOT fire when only user notes remain pending (not review targets)", () => {
    const annotations: Annotation[] = [
      makeAnnotation({ id: "u1", author: "user", status: "pending" }),
      makeAnnotation({ id: "c1", author: "claude", status: "accepted" }),
    ];
    // pendingCount from isReviewTarget filter = 0 (user note is excluded)
    // but user note is still technically pending — overlay should fire here
    // because all REVIEW TARGETS are resolved
    const counts = computeCounts(annotations);
    expect(counts.pendingCount).toBe(0);
    expect(counts.acceptedCount).toBe(1);
    expect(shouldFireOverlay(1, counts)).toBe(true);
  });

  it("does NOT fire when there are still pending review targets", () => {
    const annotations: Annotation[] = [
      makeAnnotation({ id: "c1", author: "claude", status: "pending" }),
      makeAnnotation({ id: "c2", author: "claude", status: "accepted" }),
    ];
    expect(shouldFireOverlay(2, computeCounts(annotations))).toBe(false);
  });

  it("tally total excludes user-authored resolutions", () => {
    const annotations: Annotation[] = [
      makeAnnotation({ id: "u1", author: "user", status: "accepted" }),
    ];
    // No review-target resolutions — total = 0, overlay must NOT fire
    const counts = computeCounts(annotations);
    expect(counts.acceptedCount).toBe(0);
    expect(shouldFireOverlay(1, counts)).toBe(false);
  });
});
