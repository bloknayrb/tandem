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
export const FLAT_SEPARATOR = "\n";

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
  return "#".repeat(level) + " ";
}

/**
 * Collapse newlines in a heading's text to spaces.
 *
 * A heading must never present as multiple lines. Since `paragraph` gained
 * `whitespace: "pre"` (#1448) a soft-wrapped paragraph promoted to a heading —
 * toolbar, `Mod-Alt-1`, a slash command — carries a literal newline along with
 * it, because `setBlockType` does not re-split content by the target type's
 * whitespace spec.
 *
 * There are four independent readers of heading text and each needs this:
 * `yxmlToMdast` (what gets written to disk), `extractText` (the flat-text
 * coordinate system, and what `tandem_getTextContent` returns), `getOutline`
 * (what `tandem_getOutline` hands the AI), and the CLIENT's `pmDocFlatText`
 * (which rebuilds the same projection from ProseMirror to verify a suggestion
 * before accepting it). Fixing only the disk writer leaves the AI reading a
 * heading that spans two lines.
 *
 * It lives HERE, beside {@link headingPrefix}, because those four readers span
 * both halves of the app — the client one is why it is not in `document-model`
 * any more, and a second copy for the client would be a copy of the flat-text
 * contract itself.
 *
 * **Must be a 1:1 character substitution, never a trim or a collapse of runs.**
 * `extractText` is the annotation coordinate system and `getElementTextLength`
 * counts the raw `Y.XmlText` length; anything that changed the character count
 * would desync every annotation offset after the heading. The client's flat
 * LENGTH model relies on the same property — it counts a hard break as one
 * character without knowing it will be rendered as a space.
 */
export function flattenHeadingText(text: string): string {
  // Character class, not `/\r?\n/` — a CRLF must become TWO spaces, not one,
  // or the offsets shift by one for every CRLF in the heading.
  return text.replace(/[\r\n]/g, " ");
}
