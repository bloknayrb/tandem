import { describe, expect, it } from "vitest";
import type { Annotation } from "../../src/shared/types.js";
import { isPendingReviewTarget } from "../../src/shared/types.js";
import { makeAnnotation } from "../helpers/ydoc-factory.js";

// Pending annotations covering all three author types
const u1 = makeAnnotation({ id: "u1", author: "user", status: "pending", type: "note" });
const c1 = makeAnnotation({ id: "c1", author: "claude", status: "pending", type: "comment" });
const i1 = makeAnnotation({ id: "i1", author: "import", status: "pending", type: "note" });

// Resolved annotations
const u2 = makeAnnotation({ id: "u2", author: "user", status: "accepted" });
const c2 = makeAnnotation({ id: "c2", author: "claude", status: "accepted" });

const allAnnotations = [u1, c1, i1, u2, c2];

/**
 * Mirrors SidePanel.svelte filteredData.pending and filteredData.reviewAllPending.
 * - filtered: the post-filter subset (user has an active type/author/status filter)
 * - annotations: all unfiltered annotations
 * allPendingCount includes ALL pending annotations (used for the header badge).
 */
function computeSidePanelCounts(annotations: Annotation[], filtered: Annotation[]) {
  const pending = filtered.filter(isPendingReviewTarget);
  const reviewAllPending = annotations.filter(isPendingReviewTarget);
  const allPending = annotations.filter((a) => a.status === "pending");
  return {
    pendingCount: pending.length,
    reviewAllPendingCount: reviewAllPending.length,
    allPendingCount: allPending.length,
  };
}

/** Mirrors App.svelte pendingAnnotationBadge (chat tab badge). */
function computeBadge(annotations: Annotation[]) {
  return annotations.filter(isPendingReviewTarget).length;
}

describe("SidePanel counts — mixed-author set", () => {
  it("allPendingCount includes all three pending authors", () => {
    const { allPendingCount } = computeSidePanelCounts(allAnnotations, allAnnotations);
    expect(allPendingCount).toBe(3);
  });

  it("pendingCount (action list) excludes user notes — claude + import only", () => {
    const { pendingCount } = computeSidePanelCounts(allAnnotations, allAnnotations);
    expect(pendingCount).toBe(2);
  });

  it("reviewAllPendingCount (BulkActions denominator) is claude + import only", () => {
    const { reviewAllPendingCount } = computeSidePanelCounts(allAnnotations, allAnnotations);
    expect(reviewAllPendingCount).toBe(2);
  });

  it("pendingCount diverges from reviewAllPendingCount when a type filter is active", () => {
    // Simulate a type=comment filter: only claude comment passes, dropping user note + import note
    const filteredToComments = allAnnotations.filter((a) => a.type === "comment");
    const { pendingCount, reviewAllPendingCount } = computeSidePanelCounts(
      allAnnotations,
      filteredToComments,
    );
    // Only c1 (claude, comment) is in filteredToComments and isPendingReviewTarget
    expect(pendingCount).toBe(1);
    // Unfiltered: c1 + i1 are both isPendingReviewTarget
    expect(reviewAllPendingCount).toBe(2);
  });
});

describe("App.svelte chat tab badge", () => {
  it("badge counts only review targets (claude + import), not user notes", () => {
    expect(computeBadge(allAnnotations)).toBe(2);
  });
});
