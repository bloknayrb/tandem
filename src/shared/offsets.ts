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
 * Is `level` a real heading level — a positive integer?
 *
 * The two functions below must agree on this for EVERY input, because
 * `flatDocLength` is built from the length and `extractText` from the string,
 * and #1752 makes their difference decide whether a bounds check accepts a
 * range. They used to disagree on four inputs, all of them unreachable from
 * today's writers (`document-model.ts`, `mdast-ydoc.ts` and `docx-html.ts` all
 * emit 1-6 or `?? 1`) and therefore invisible to any test that compared
 * `extractText` to itself: level 0 (length 0, prefix `" "`), a non-numeric
 * attribute read as NaN (same), a negative level (length 0, but
 * `"#".repeat(-1)` THROWS), and a fractional level (length 2.5, so
 * `flatDocLength` went non-integer). Levels above 6 are left alone — Tiptap
 * will not emit one, but a longer prefix is at least self-consistent.
 *
 * **The CLIENT does not route through this predicate, and must not be "tidied"
 * into doing so.** Three call sites normalize with `|| 1` before calling in —
 * `src/client/positions.ts:128` (`headingPrefix`), `:232` and `:319`
 * (`headingPrefixLength`) — so for `level: 0` the server charges 0 characters
 * and the client charges 2. Unreachable from today's writers (ProseMirror
 * defaults `level` to 1 and nothing emits 0), and recorded rather than fixed
 * because fixing it is a coordinate-system change with no reachable bug behind
 * it.
 *
 * What this docstring explicitly does NOT bless is the obvious-looking client
 * tidy from `|| 1` to `?? 1`. That would let a literal 0 through to these
 * functions, where it now means "not a heading" and charges 0 — the client would
 * start agreeing with the server about the prefix LENGTH while still rendering a
 * heading, which is a different disagreement, not a fix. No code change on
 * either side belongs here.
 */
function isHeadingLevel(level: number | null | undefined): level is number {
  return typeof level === "number" && Number.isInteger(level) && level >= 1;
}

/**
 * Length of the heading prefix in flat text for a given heading level.
 * Level 1 → "# " (2 chars), level 2 → "## " (3 chars), etc.
 * Returns 0 for anything that is not a positive integer level.
 */
export function headingPrefixLength(level: number | null | undefined): number {
  if (!isHeadingLevel(level)) return 0;
  return level + 1;
}

/**
 * Build the heading prefix string for a given level.
 * Level 1 → "# ", level 2 → "## ", etc.
 * Returns `""` for anything that is not a positive integer level — see
 * {@link isHeadingLevel} for why the two must agree.
 */
export function headingPrefix(level: number): string {
  if (!isHeadingLevel(level)) return "";
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
