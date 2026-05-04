import { applyAccentHue } from "./useAccentHue.js";

export { applyAccentHue } from "./useAccentHue.js";

/**
 * Svelte 5 effect that applies --tandem-accent-h to <html> whenever the
 * hue changes. Accepts a getter so callers with $state values propagate
 * reactively.
 */
export function createAccentHue(getHue: () => number): void {
  $effect(() => {
    const cleanup = applyAccentHue(getHue());
    return cleanup;
  });
}
