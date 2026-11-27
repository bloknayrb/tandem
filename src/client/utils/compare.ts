/**
 * The rows the compare view shows (ADR-057, PR 4): a unified line diff of
 * another version (a backup, or the file on disk) against the document as it
 * is now. Pure, so it is tested without a DOM.
 *
 * Bounded twice: `diffLines` gives up after `timeoutMs` (it then answers
 * `null`, "too different to compare here"), and word-level highlighting is
 * only worked out for a changed line pair short enough to be cheap.
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
  | { kind: "gap"; count: number };

/** Unchanged lines kept around each change. */
export const DIFF_CONTEXT_LINES = 3;
/** A line pair longer than this gets no word-level highlight. */
const WORD_DIFF_MAX_CHARS = 2000;
/** How long the line diff may run before giving up. */
const DEFAULT_TIMEOUT_MS = 1500;

/** The lines of one diff change, without the empty string after a final newline. */
function linesOf(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Word segments for a removed/added line pair, one side each. */
function wordSegments(oldLine: string, newLine: string): [DiffSegment[], DiffSegment[]] | null {
  if (oldLine.length + newLine.length > WORD_DIFF_MAX_CHARS) return null;
  const parts = diffWordsWithSpace(oldLine, newLine);
  const before: DiffSegment[] = [];
  const after: DiffSegment[] = [];
  for (const p of parts) {
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
  const changes: ChangeObject<string>[] | undefined = diffLines(other, current, {
    timeout: timeoutMs,
  });
  if (changes === undefined) return null;

  // Flatten into rows, pairing an equal-sized removed block with the added
  // block right after it for word-level highlighting.
  const rows: DiffRow[] = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const lines = linesOf(c.value);
    if (c.removed) {
      const next = changes[i + 1];
      const added = next?.added ? linesOf(next.value) : null;
      if (added && added.length === lines.length) {
        const removedRows: DiffRow[] = [];
        const addedRows: DiffRow[] = [];
        lines.forEach((line, k) => {
          const seg = wordSegments(line, added[k]);
          removedRows.push(
            seg ? { kind: "remove", text: line, segments: seg[0] } : { kind: "remove", text: line },
          );
          addedRows.push(
            seg
              ? { kind: "add", text: added[k], segments: seg[1] }
              : { kind: "add", text: added[k] },
          );
        });
        rows.push(...removedRows, ...addedRows);
        i++;
        continue;
      }
      for (const line of lines) rows.push({ kind: "remove", text: line });
    } else if (c.added) {
      for (const line of lines) rows.push({ kind: "add", text: line });
    } else {
      for (const line of lines) rows.push({ kind: "same", text: line });
    }
  }

  if (!rows.some((r) => r.kind !== "same")) return [];
  return collapseUnchanged(rows);
}

/** Replace unchanged runs longer than the context on both sides with a gap row. */
function collapseUnchanged(rows: DiffRow[]): DiffRow[] {
  const out: DiffRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "same") {
      out.push(rows[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < rows.length && rows[j].kind === "same") j++;
    const run = rows.slice(i, j);
    const keepBefore = i === 0 ? 0 : DIFF_CONTEXT_LINES;
    const keepAfter = j === rows.length ? 0 : DIFF_CONTEXT_LINES;
    if (run.length > keepBefore + keepAfter + 1) {
      out.push(...run.slice(0, keepBefore));
      out.push({ kind: "gap", count: run.length - keepBefore - keepAfter });
      out.push(...run.slice(run.length - keepAfter));
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}
