import { useMemo } from "react";
import type { Annotation, TandemMode } from "../../shared/types.js";

export function shouldShowInMode(ann: Annotation, mode: TandemMode): boolean {
  if (ann.status !== "pending") return true;
  if (mode === "tandem") return true;
  return ann.author !== "claude";
}

export function useModeGate(annotations: Annotation[], mode: TandemMode) {
  return useMemo(() => {
    const visibleAnnotations: Annotation[] = [];
    let heldCount = 0;
    for (const a of annotations) {
      if (shouldShowInMode(a, mode)) {
        visibleAnnotations.push(a);
      } else if (a.status === "pending") {
        heldCount++;
      }
    }
    return { visibleAnnotations, heldCount };
  }, [annotations, mode]);
}
