import type { Annotation } from "../../shared/types";

/** Side-panel annotation ordering: by document anchor position or by creation time. */
export type AnnotationSortMode = "position" | "chronological";

/** Deterministic id tie-break shared by both sort modes. */
function compareIds(a: Annotation, b: Annotation): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Stable order: by `range.from` ASC; ties broken by `id` (string compare) for determinism. */
export function sortAnnotationsByPosition(anns: ReadonlyArray<Annotation>): Annotation[] {
  return [...anns].sort((a, b) => {
    // Defensive: malformed records missing position data sort to the end.
    const fa = Number.isFinite(a.range?.from) ? a.range.from : Number.POSITIVE_INFINITY;
    const fb = Number.isFinite(b.range?.from) ? b.range.from : Number.POSITIVE_INFINITY;
    // Compare without subtraction: Infinity - Infinity is NaN, which would
    // silently bypass the id tie-break for two malformed records.
    if (fa !== fb) return fa < fb ? -1 : 1;
    return compareIds(a, b);
  });
}

/** Stable order: by `timestamp` ASC (oldest first); ties broken by `id` for determinism. */
export function sortAnnotationsByTimestamp(anns: ReadonlyArray<Annotation>): Annotation[] {
  return [...anns].sort((a, b) => {
    // Defensive: records missing a timestamp sort first (treated as oldest).
    const ta = Number.isFinite(a.timestamp) ? a.timestamp : 0;
    const tb = Number.isFinite(b.timestamp) ? b.timestamp : 0;
    const dt = ta - tb;
    if (dt !== 0) return dt;
    return compareIds(a, b);
  });
}

/** Sort by the given mode. `"position"` is the panel default (issue #1056). */
export function sortAnnotations(
  anns: ReadonlyArray<Annotation>,
  mode: AnnotationSortMode,
): Annotation[] {
  return mode === "chronological"
    ? sortAnnotationsByTimestamp(anns)
    : sortAnnotationsByPosition(anns);
}

/** Index of `currentId` in `sorted`; -1 if not present (or `currentId` is null). */
export function indexOfId(sorted: ReadonlyArray<Annotation>, currentId: string | null): number {
  if (!currentId) return -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].id === currentId) return i;
  }
  return -1;
}

/**
 * Returns the id of the annotation AFTER `currentId` (wrapping last → first).
 * If `currentId` is null OR not found, returns the FIRST annotation.
 * Returns null if `sorted` is empty.
 */
export function nextAnnotationId(
  sorted: ReadonlyArray<Annotation>,
  currentId: string | null,
): string | null {
  if (sorted.length === 0) return null;
  const idx = indexOfId(sorted, currentId);
  if (idx === -1) return sorted[0].id;
  return sorted[(idx + 1) % sorted.length].id;
}

/**
 * Returns the id of the annotation BEFORE `currentId` (wrapping first → last).
 * If `currentId` is null OR not found, returns the LAST annotation.
 * Returns null if `sorted` is empty.
 */
export function prevAnnotationId(
  sorted: ReadonlyArray<Annotation>,
  currentId: string | null,
): string | null {
  if (sorted.length === 0) return null;
  const idx = indexOfId(sorted, currentId);
  if (idx === -1) return sorted[sorted.length - 1].id;
  return sorted[(idx - 1 + sorted.length) % sorted.length].id;
}
