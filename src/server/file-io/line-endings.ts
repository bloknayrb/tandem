import type * as Y from "yjs";
import { Y_MAP_BOM, Y_MAP_DOCUMENT_META, Y_MAP_LINE_ENDING } from "../../shared/constants.js";

/**
 * Source-encoding facts that must survive a round trip: line endings (#1448 W2)
 * and the UTF-8 BOM (#1823).
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

/**
 * Record whether `text` starts with a UTF-8 BOM and return it stripped (#1823).
 *
 * Strip BEFORE the parser, restore AFTER the serializer. A U+FEFF left in the
 * parsed text lands as a character in the first text node and shifts every flat
 * offset — the annotation coordinate system — by one.
 *
 * Writes a Y.Map, so it must run inside the caller's already-origin-tagged
 * transact, exactly like `normalizeAndRecordLineEnding`; it opens none of its
 * own (a raw `doc.transact` in `src/` is forbidden, Critical Rule 2).
 */
export function stripAndRecordBom(doc: Y.Doc, text: string): string {
  const stripped = stripBom(text);
  doc.getMap(Y_MAP_DOCUMENT_META).set(Y_MAP_BOM, stripped !== text);
  return stripped;
}

/**
 * Drop a leading UTF-8 BOM, recording nothing.
 *
 * The pure half of `stripAndRecordBom`, for the surface that must show a user
 * the markdown source WITHOUT the encoding artefact in it: `GET
 * /api/document/raw`. A BOM served into the source-view textarea is invisible
 * there, and typing at offset 0 puts the caret in FRONT of it \u2014 so the committed
 * string no longer starts with a BOM, `stripAndRecordBom` records `false`, the
 * next save drops the file's BOM, and the U+FEFF survives as a character in the
 * middle of the document. Serving it stripped is what makes that unreachable;
 * `reloadDocumentFromMarkdown` re-attaches the recorded BOM on the way back in.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Re-prepend the doc's recorded BOM to freshly serialized output.
 *
 * Runs after `restoreLineEndings` by convention, so it keeps working if that
 * ever normalizes more than line endings. Not a tested invariant: a BOM carries
 * no line ending, so the two orders are byte-identical today.
 *
 * Idempotent: text that already starts with a BOM is returned untouched. That
 * matters on the source-view commit path, where the string is user-supplied and
 * may carry one of its own \u2014 a second BOM would not be an encoding mark, it
 * would be a stray character at offset 0 of the body.
 *
 * The prefix is spelled as an escape, never pasted literally: a raw U+FEFF in
 * source is invisible in every editor and diff.
 */
export function restoreBom(doc: Y.Doc, text: string): string {
  if (text.charCodeAt(0) === 0xfeff) return text;
  return doc.getMap(Y_MAP_DOCUMENT_META).get(Y_MAP_BOM) === true ? `\uFEFF${text}` : text;
}
