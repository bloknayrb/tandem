/**
 * Shared offset math for the flat-text coordinate system.
 *
 * The server's extractText() builds a flat string from Y.Doc elements by:
 *   1. Prepending heading prefixes ("# ", "## ", "### ") to heading content
 *   2. Joining elements with "\n" separators
 *
 * Both server (Y.Doc → flat offsets) and client (ProseMirror positions ↔ flat offsets)
 * must agree on these conventions. This module is the single source of truth.
 */

/** Flat-text separator between block elements. */
export const FLAT_SEPARATOR = '\n';

/**
 * Length of the heading prefix in flat text for a given heading level.
 * Level 1 → "# " (2 chars), level 2 → "## " (3 chars), etc.
 * Returns 0 for non-heading nodes (level null/undefined/0).
 */
export function headingPrefixLength(level: number | null | undefined): number {
  if (!level) return 0;
  return level + 1;
}

/**
 * Build the heading prefix string for a given level.
 * Level 1 → "# ", level 2 → "## ", etc.
 */
export function headingPrefix(level: number): string {
  return '#'.repeat(level) + ' ';
}
