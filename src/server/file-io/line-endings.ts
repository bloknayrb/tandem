import type * as Y from "yjs";
import { Y_MAP_DOCUMENT_META, Y_MAP_LINE_ENDING } from "../../shared/constants.js";

/**
 * Line-ending preservation (#1448 W2).
 *
 * A CRLF file previously came back MIXED, which is worse than either pure form:
 * `remark-stringify` joins blocks with `\n` while an intra-paragraph soft wrap
 * kept the `\r` it arrived with. Every Windows-authored `.md` was exposed, and
 * the repo corpus can never catch it — `.gitattributes` pins `*.md text eol=lf`,
 * so a committed CRLF fixture arrives as LF.
 *
 * The contract is detect-at-load, restore-at-save, LF everywhere in between.
 * Normalizing to LF instead would rewrite every line of a Windows-authored
 * file — the exact harm this whole effort is about.
 */

export type LineEnding = "\n" | "\r\n" | "\r";

/**
 * The dominant line ending in `text`. A non-LF form only wins on a strict
 * majority, so a mixed file (or one with no newlines at all) resolves to LF —
 * the safer default, since LF is what the model and every downstream consumer
 * already use.
 *
 * Lone `\r` (classic Mac) is a member of this union because `toLf` collapses it
 * like any other ending. While the union held only two members there was no way
 * to record such a file, so it round-tripped as LF: every line ending in the
 * file silently rewritten, with no path back. Detection has to name a form for
 * restoration to have anything to restore.
 */
export function detectLineEnding(text: string): LineEnding {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  // Subtracting `crlf` counts LONE occurrences: every `\r\n` also matches each.
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r/g) ?? []).length - crlf;
  if (crlf >= cr && crlf > lf) return "\r\n";
  if (cr > crlf && cr > lf) return "\r";
  return "\n";
}

/** Collapse every line ending to LF. Handles lone `\r` (classic Mac) too. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Record `text`'s dominant ending on the doc and return the LF-normalized text
 * to feed the parser. Call from a format adapter's `apply`, inside the caller's
 * already-origin-tagged transact.
 */
export function normalizeAndRecordLineEnding(doc: Y.Doc, text: string): string {
  doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_LINE_ENDING, detectLineEnding(text));
  return toLf(text);
}

/**
 * Re-apply the doc's recorded ending to freshly serialized (LF) output.
 *
 * `toLf` first rather than a bare `\n` -> `\r\n` replace: a serializer that
 * emitted a `\r\n` of its own — or verbatim `markdownRaw` content carrying one —
 * would otherwise become `\r\r\n`.
 */
export function restoreLineEndings(doc: Y.Doc, text: string): string {
  const stored = doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_LINE_ENDING);
  if (stored !== "\r\n" && stored !== "\r") return text;
  return toLf(text).replace(/\n/g, stored);
}
