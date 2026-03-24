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

/**
 * Generic node-walking offset calculator. Iterates over a sequence of block nodes
 * and calls `visitor` for each one with the accumulated flat offset and node metadata.
 *
 * This lets both server (Y.XmlFragment) and client (PmNode) share the same
 * accumulation logic while providing their own node accessor.
 */
export interface NodeInfo {
  headingLevel: number | null;
  textLength: number;
}

export function walkFlatOffsets<T>(
  nodeCount: number,
  getNode: (index: number) => NodeInfo,
  visitor: (index: number, node: NodeInfo, accumulatedOffset: number, prefixLen: number) => T | undefined,
): T | undefined {
  let accumulated = 0;

  for (let i = 0; i < nodeCount; i++) {
    const node = getNode(i);
    const prefixLen = headingPrefixLength(node.headingLevel);

    const result = visitor(i, node, accumulated, prefixLen);
    if (result !== undefined) return result;

    accumulated += prefixLen + node.textLength;

    // Separator between elements
    if (i < nodeCount - 1) {
      accumulated += 1;
    }
  }
  return undefined;
}
