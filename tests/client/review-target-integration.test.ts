import { describe, expect, it } from "vitest";
import type { Annotation } from "../../src/shared/types.js";
import { isPendingReviewTarget, isReviewTarget } from "../../src/shared/types.js";
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
 * allPendingCount includes ALL pending annotations (used for the header badge).
 */
function computeSidePanelCounts(annotations: Annotation[]) {
  const pending = annotations.filter(isPendingReviewTarget);
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

/** Mirrors useReviewCompletion counts and overlay trigger. */
function computeReviewCompletion(annotations: Annotation[]) {
  let pendingCount = 0;
  let acceptedCount = 0;
  let dismissedCount = 0;
  for (const a of annotations) {
    if (!isReviewTarget(a)) continue;
    if (a.status === "pending") pendingCount++;
    else if (a.status === "accepted") acceptedCount++;
    else if (a.status === "dismissed") dismissedCount++;
  }
  const total = acceptedCount + dismissedCount;
  const overlayWouldFire = pendingCount === 0 && total > 0;
  return { pendingCount, acceptedCount, dismissedCount, total, overlayWouldFire };
}

describe("SidePanel counts — mixed-author set", () => {
  it("allPendingCount includes all three pending authors", () => {
    const { allPendingCount } = computeSidePanelCounts(allAnnotations);
    expect(allPendingCount).toBe(3);
  });

  it("pendingCount (action list) excludes user notes — claude + import only", () => {
    const { pendingCount } = computeSidePanelCounts(allAnnotations);
    expect(pendingCount).toBe(2);
  });

  it("reviewAllPendingCount (BulkActions denominator) is claude + import only", () => {
    const { reviewAllPendingCount } = computeSidePanelCounts(allAnnotations);
    expect(reviewAllPendingCount).toBe(2);
  });
});

describe("App.svelte chat tab badge", () => {
  it("badge counts only review targets (claude + import), not user notes", () => {
    expect(computeBadge(allAnnotations)).toBe(2);
  });
});

describe("useReviewCompletion — resolved-only set", () => {
  it("accepted tally counts claude but not user", () => {
    const { acceptedCount, total, overlayWouldFire } = computeReviewCompletion([u2, c2]);
    expect(acceptedCount).toBe(1);
    expect(total).toBe(1);
    expect(overlayWouldFire).toBe(true);
  });
});

describe("useReviewCompletion — overlay edge cases", () => {
  it("user note still pending does not block overlay when no review targets remain", () => {
    // u1 (user, pending) should not contribute to pendingCount
    const { pendingCount, overlayWouldFire } = computeReviewCompletion([u1, c2]);
    expect(pendingCount).toBe(0);
    expect(overlayWouldFire).toBe(true);
  });

  it("claude pending prevents overlay even when user note is also pending", () => {
    const { pendingCount, overlayWouldFire } = computeReviewCompletion([u1, c1]);
    expect(pendingCount).toBe(1);
    expect(overlayWouldFire).toBe(false);
  });
});
