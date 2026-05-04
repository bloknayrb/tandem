import { applyAnnotationPatterns } from "./useAnnotationPatterns.js";

export { applyAnnotationPatterns } from "./useAnnotationPatterns.js";

/**
 * Svelte 5 effect that applies [data-annotation-patterns] to <html> whenever
 * the setting changes. Accepts a getter so callers with $state values propagate
 * reactively.
 */
export function createAnnotationPatterns(getEnabled: () => boolean): void {
  $effect(() => {
    const cleanup = applyAnnotationPatterns(getEnabled());
    return cleanup;
  });
}
