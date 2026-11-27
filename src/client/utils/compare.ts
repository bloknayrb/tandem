/**
 * The rows the compare view shows (ADR-057, PR 4): a unified line diff of
 * another version (a backup, or the file on disk) against the document as it
 * is now. Pure, so it is tested without a DOM.
 *
 * Bounded three times: `diffLines` gives up after `timeoutMs` (it then
 * answers `null`, "too different to compare here"); word-level highlighting
 * is worked out only for a line pair short enough to be cheap, and only until
 * a total budget is spent; and at most `MAX_DIFF_ROWS` rows are returned,
 * the rest counted in a final `more` row, so the view never mounts an
 * unbounded number of lines.
 */

import { type ChangeObject, diffLines, diffWordsWithSpace } from "diff";

/** A piece of a changed line; `changed` marks the words that differ. */
export interface DiffSegment {
  text: string;
  changed: boolean;
}

export type DiffRow =
  /** In both versions. */
  | { kind: "same"; text: string }
  /** Only in the other version (a backup, or the file on disk). */
  | { kind: "remove"; text: string; segments?: DiffSegment[] }
  /** Only in the document now. */
  | { kind: "add"; text: string; segments?: DiffSegment[] }
  /** `count` unchanged lines not shown. */
  | { kind: "gap"; count: number }
  /** `count` further rows past `MAX_DIFF_ROWS`, not shown. */
  | { kind: "more"; count: number };

/** Unchanged lines kept around each change. */
export const DIFF_CONTEXT_LINES = 3;
/** The most rows returned; the rest are counted in one `more` row. */
export const MAX_DIFF_ROWS = 2000;
/** A line pair longer than this gets no word-level highlight. */
const WORD_DIFF_MAX_CHARS = 2000;
/** Characters word-diffed in total; past it, changed lines are shown whole. */
const WORD_DIFF_BUDGET_CHARS = 200_000;
/** How long the line diff may run before giving up. */
const DEFAULT_TIMEOUT_MS = 1500;

/** The lines of one diff change, without the empty string after a final newline. */
function linesOf(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Word segments for a removed/added line pair, one side each. */
function wordSegments(oldLine: string, newLine: string): [DiffSegment[], DiffSegment[]] {
  const before: DiffSegment[] = [];
  const after: DiffSegment[] = [];
  for (const p of diffWordsWithSpace(oldLine, newLine)) {
    if (!p.added) before.push({ text: p.value, changed: Boolean(p.removed) });
    if (!p.removed) after.push({ text: p.value, changed: Boolean(p.added) });
  }
  return [before, after];
}

/**
 * The display rows for `other` against `current`, unchanged runs collapsed
 * to `DIFF_CONTEXT_LINES` around each change. `null` when the diff gave up
 * (the versions are too different to compare within `timeoutMs`). An empty
 * array means no differences.
 */
export function buildDiffRows(
  other: string,
  current: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): DiffRow[] | null {
  // A difference only in the final newline is not shown: the rows drop the
  // newline, so it would read as a line removed and re-added unchanged.
  const changes: ChangeObject<string>[] | undefined = diffLines(other, current, {
    timeout: timeoutMs,
    ignoreNewlineAtEof: true,
  });
  if (changes === undefined) return null;
  if (!changes.some((c) => c.added || c.removed)) return [];

  const rows: DiffRow[] = [];
  let wordBudget = WORD_DIFF_BUDGET_CHARS;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const lines = linesOf(c.value);
    if (c.removed) {
      // An equal-sized added block right after is paired line by line for
      // word-level highlighting.
      const next = changes[i + 1];
      const added = next?.added ? linesOf(next.value) : null;
      if (added && added.length === lines.length) {
        const pairs = lines.map((line, k) => {
          const size = line.length + added[k].length;
          if (size > WORD_DIFF_MAX_CHARS || size > wordBudget) return undefined;
          wordBudget -= size;
          return wordSegments(line, added[k]);
        });
        lines.forEach((text, k) => rows.push({ kind: "remove", text, segments: pairs[k]?.[0] }));
        added.forEach((text, k) => rows.push({ kind: "add", text, segments: pairs[k]?.[1] }));
        i++;
        continue;
      }
      for (const text of lines) rows.push({ kind: "remove", text });
    } else if (c.added) {
      for (const text of lines) rows.push({ kind: "add", text });
    } else {
      // An unchanged run: keep the context next to a change on each side.
      const keepBefore = i === 0 ? 0 : DIFF_CONTEXT_LINES;
      const keepAfter = i === changes.length - 1 ? 0 : DIFF_CONTEXT_LINES;
      if (lines.length > keepBefore + keepAfter + 1) {
        for (const text of lines.slice(0, keepBefore)) rows.push({ kind: "same", text });
        rows.push({ kind: "gap", count: lines.length - keepBefore - keepAfter });
        for (const text of lines.slice(lines.length - keepAfter)) rows.push({ kind: "same", text });
      } else {
        for (const text of lines) rows.push({ kind: "same", text });
      }
    }
  }

  if (rows.length <= MAX_DIFF_ROWS) return rows;
  const shown = rows.slice(0, MAX_DIFF_ROWS);
  shown.push({ kind: "more", count: rows.length - MAX_DIFF_ROWS });
  return shown;
}
