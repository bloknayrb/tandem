import type { Annotation, TandemMode } from "../../shared/types.js";

/**
 * Wave M: Solo mode no longer hides any annotations. Comments and notes are
 * de-emphasized via a CSS opacity rule keyed to `[data-tandem-mode="solo"]`
 * (see App.svelte's mode attribute + the fade rule in index.html / component
 * styles), so Claude's pending output stays visible-but-quiet rather than
 * disappearing into a "held" bucket. `heldCount` is therefore always 0 today.
 */
export function shouldShowInMode(_ann: Annotation, _mode: TandemMode): boolean {
  return true;
}
