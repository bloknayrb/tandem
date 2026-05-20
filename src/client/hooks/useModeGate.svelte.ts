import type { Annotation, TandemMode } from "../../shared/types.js";
import { shouldShowInMode } from "./useModeGate.js";

export interface ModeGateState {
  readonly visibleAnnotations: Annotation[];
  readonly heldCount: number;
}

/**
 * Svelte 5 port of `useModeGate`.
 *
 * Accepts getter functions for reactive inputs so callers with `$state`
 * values propagate changes without re-calling the factory.
 */
export function createModeGate(
  getAnnotations: () => Annotation[],
  getMode: () => TandemMode,
): ModeGateState {
  const derived = $derived.by(() => {
    const annotations = getAnnotations();
    const mode = getMode();
    const visibleAnnotations: Annotation[] = [];
    for (const a of annotations) {
      if (shouldShowInMode(a, mode)) {
        visibleAnnotations.push(a);
      }
    }
    return { visibleAnnotations, heldCount: 0 };
  });

  return {
    get visibleAnnotations() {
      return derived.visibleAnnotations;
    },
    get heldCount() {
      return derived.heldCount;
    },
  };
}
