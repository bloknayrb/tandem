import type { Annotation } from "../../shared/types.js";

export interface ReviewCompletionState {
  readonly pendingCount: number;
  readonly showReviewSummary: boolean;
  readonly reviewSummaryData: { accepted: number; dismissed: number; total: number } | null;
  dismissReviewSummary: () => void;
}

/**
 * Svelte 5 port of `useReviewCompletion`.
 *
 * Detects when all pending annotations become resolved and surfaces
 * the review summary overlay. Accepts a getter for `annotations` so
 * callers with `$state` values propagate reactively.
 */
export function createReviewCompletion(getAnnotations: () => Annotation[]): ReviewCompletionState {
  let showReviewSummary = $state(false);
  let reviewSummaryData = $state<{ accepted: number; dismissed: number; total: number } | null>(
    null,
  );
  let prevPending = 0;

  const counts = $derived.by(() => {
    const annotations = getAnnotations();
    let pendingCount = 0;
    let acceptedCount = 0;
    let dismissedCount = 0;
    for (const a of annotations) {
      if (a.status === "pending") pendingCount++;
      else if (a.status === "accepted") acceptedCount++;
      else if (a.status === "dismissed") dismissedCount++;
    }
    return { pendingCount, acceptedCount, dismissedCount };
  });

  $effect(() => {
    const { pendingCount, acceptedCount, dismissedCount } = counts;
    const total = acceptedCount + dismissedCount;
    if (prevPending > 0 && pendingCount === 0 && total > 0) {
      reviewSummaryData = { accepted: acceptedCount, dismissed: dismissedCount, total };
      showReviewSummary = true;
    }
    prevPending = pendingCount;
  });

  const dismissReviewSummary = () => {
    showReviewSummary = false;
  };

  return {
    get pendingCount() {
      return counts.pendingCount;
    },
    get showReviewSummary() {
      return showReviewSummary;
    },
    get reviewSummaryData() {
      return reviewSummaryData;
    },
    dismissReviewSummary,
  };
}
