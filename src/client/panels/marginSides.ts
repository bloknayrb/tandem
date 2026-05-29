/**
 * Margin-view side assignment (the C3 side-split, extracted as pure predicates).
 *
 * Two consumers must agree on which side an annotation belongs to, or they
 * drift:
 *  - App.svelte's `marginNotes` / `marginComments` render arrays, and
 *  - `EditorStageModel`'s per-side presence-collapse booleans
 *    (`getLeftHasPending` / `getRightHasPending`).
 * Sharing one predicate (not one array) is what keeps them in lockstep — and is
 * required for loop-freedom: the presence booleans MUST read the UNGATED
 * annotation source through these predicates, never the `effectivelyOn`-gated
 * render arrays (which would close a `$derived` cycle). See stage-c1 plan
 * [MF-11].
 *
 * Side assignment (fixed, never swapped — ADR-027 / C3 lock):
 *  - LEFT  = private notes (`type === "note"`).
 *  - RIGHT = outbound comments + imported Word comments
 *    (`author === "import" || type === "comment"`).
 *  - `highlight` is inline (not margin-rendered) → neither side.
 */
import type { Annotation } from "../../shared/types";

/** True when `a` renders in the LEFT margin (private notes). */
export function isLeftMarginAnnotation(a: Annotation): boolean {
  return a.type === "note";
}

/** True when `a` renders in the RIGHT margin (outbound comments + imports). */
export function isRightMarginAnnotation(a: Annotation): boolean {
  return a.author === "import" || a.type === "comment";
}
