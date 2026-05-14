import type { Annotation } from "../../shared/types";

/** Stable order: by `range.from` ASC; ties broken by `id` (string compare) for determinism. */
export function sortAnnotationsByPosition(anns: ReadonlyArray<Annotation>): Annotation[] {
  return [...anns].sort((a, b) => {
    const da = a.range.from - b.range.from;
    if (da !== 0) return da;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
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
