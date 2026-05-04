import { applyHighContrast } from "./useHighContrast.js";

export { applyHighContrast } from "./useHighContrast.js";

/**
 * Svelte 5 effect that applies [data-high-contrast] to <html> whenever the
 * setting changes. Accepts a getter so callers with $state values propagate
 * reactively.
 */
export function createHighContrast(getEnabled: () => boolean): void {
  $effect(() => {
    const cleanup = applyHighContrast(getEnabled());
    return cleanup;
  });
}
