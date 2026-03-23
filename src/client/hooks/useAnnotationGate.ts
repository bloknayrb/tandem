import { useMemo } from 'react';
import type { Annotation, InterruptionMode } from '../../shared/types';

/**
 * Pure function: should an annotation be shown given the current mode?
 * Resolved annotations are always visible.
 */
export function shouldShow(ann: Annotation, mode: InterruptionMode): boolean {
  if (ann.status !== 'pending') return true;
  if (mode === 'all') return true;
  if (mode === 'urgent-only') return ann.priority === 'urgent';
  return false; // paused
}

export function useAnnotationGate(annotations: Annotation[], mode: InterruptionMode) {
  return useMemo(() => {
    const visibleAnnotations: Annotation[] = [];
    let heldCount = 0;
    for (const a of annotations) {
      if (shouldShow(a, mode)) {
        visibleAnnotations.push(a);
      } else if (a.status === 'pending') {
        heldCount++;
      }
    }
    return { visibleAnnotations, heldCount };
  }, [annotations, mode]);
}
