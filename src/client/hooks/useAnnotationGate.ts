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
  const visible = useMemo(
    () => annotations.filter(a => shouldShow(a, mode)),
    [annotations, mode],
  );
  const heldCount = useMemo(
    () => annotations.filter(a => a.status === 'pending' && !shouldShow(a, mode)).length,
    [annotations, mode],
  );
  return { visibleAnnotations: visible, heldCount };
}
