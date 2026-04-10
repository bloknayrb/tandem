import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "../../shared/types";

/**
 * Detects when all pending annotations become resolved (accepted/dismissed)
 * and surfaces the review summary overlay.
 */
export function useReviewCompletion(annotations: Annotation[]) {
  const [showReviewSummary, setShowReviewSummary] = useState(false);
  const [reviewSummaryData, setReviewSummaryData] = useState<{
    accepted: number;
    dismissed: number;
    total: number;
  } | null>(null);
  const prevPendingRef = useRef<number>(0);

  const { pendingCount, acceptedCount, dismissedCount } = useMemo(() => {
    let pendingCount = 0,
      acceptedCount = 0,
      dismissedCount = 0;
    for (const a of annotations) {
      if (a.status === "pending") pendingCount++;
      else if (a.status === "accepted") acceptedCount++;
      else if (a.status === "dismissed") dismissedCount++;
    }
    return { pendingCount, acceptedCount, dismissedCount };
  }, [annotations]);

  useEffect(() => {
    const total = acceptedCount + dismissedCount;

    if (prevPendingRef.current > 0 && pendingCount === 0 && total > 0) {
      setReviewSummaryData({ accepted: acceptedCount, dismissed: dismissedCount, total });
      setShowReviewSummary(true);
    }
    prevPendingRef.current = pendingCount;
  }, [pendingCount, acceptedCount, dismissedCount]);

  const dismissReviewSummary = useCallback(() => {
    setShowReviewSummary(false);
  }, []);

  return {
    pendingCount,
    showReviewSummary,
    reviewSummaryData,
    dismissReviewSummary,
  };
}
