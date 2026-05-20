import type { Annotation, TandemMode } from "../../shared/types.js";

/**
 * Solo mode no longer hides annotations; comments and notes are
 * de-emphasized via the `[data-tandem-mode="solo"]` CSS rule in index.html.
 * Kept as a hook point in case future modes want to filter the list.
 */
export function shouldShowInMode(_ann: Annotation, _mode: TandemMode): boolean {
  return true;
}
