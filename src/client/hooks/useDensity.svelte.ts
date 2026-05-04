import { applyDensity } from "./useDensity.js";
import type { Density } from "./useTandemSettings.js";

export { applyDensity } from "./useDensity.js";

/**
 * Svelte 5 effect that applies [data-density] to <html> whenever the
 * density setting changes. Accepts a getter so callers with $state values
 * propagate reactively.
 */
export function createDensity(getDensity: () => Density): void {
  $effect(() => {
    const cleanup = applyDensity(getDensity());
    return cleanup;
  });
}
