/**
 * Pure helpers for the a7 new-tab launcher (`NewTabMenu.svelte`).
 *
 * Kept out of the component so the row-shaping, search ranking, and match
 * highlighting are unit-testable in isolation — the `.svelte` file is then just
 * rendering + keyboard wiring. Ported from the Claude Design a7 bundle's
 * `new-tab-utils.ts`, adapted to production's stored recents shape
 * (`RecentFileEntry` with a full path + `openedAt`, vs the bundle's pre-split
 * name/path/when/ext mock). Search converges on the command palette's
 * fuzzy-match stack (`utils/fuzzy-match.ts`) instead of a bespoke substring
 * filter.
 */

import { type MatchSegment, rankByScore, scoreFields, toSegments } from "../utils/fuzzy-match.js";
import { formatWhen, type RecentFileEntry } from "../utils/recentFiles.js";

/** File-type bucket driving the recents-row pip color. */
export type PipClass = "md" | "docx" | "txt" | "html" | "other";

export interface LauncherRow {
  /** Full path — the open target handed back to `onOpen`. */
  path: string;
  /** Basename for display. */
  name: string;
  /** Directory portion for display (forward-slash joined; "" for a bare name). */
  dir: string;
  /** Relative-time label, or "" when the timestamp is unknown (`openedAt === 0`). */
  when: string;
  /** File-type bucket driving the pip color. */
  pip: PipClass;
}

/** A launcher row paired with its name's matched/unmatched highlight runs. */
export interface RankedRow {
  row: LauncherRow;
  nameSegments: MatchSegment[];
}

const PIP_BY_EXT: Record<string, PipClass> = {
  md: "md",
  markdown: "md",
  docx: "docx",
  doc: "docx",
  txt: "txt",
  text: "txt",
  html: "html",
  htm: "html",
};

/** Map a filename to its pip color bucket by extension. Unknown → "other". */
export function pipClassFor(name: string): PipClass {
  const dot = name.lastIndexOf(".");
  // dot <= 0 covers both "no extension" and dotfiles like ".gitignore".
  if (dot <= 0 || dot === name.length - 1) return "other";
  return PIP_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? "other";
}

/** Split a path into [dir, name], tolerating both `/` and `\` separators. */
function splitPath(path: string): { dir: string; name: string } {
  const parts = path.split(/[/\\]/);
  return {
    name: parts.at(-1) ?? path,
    dir: parts.slice(0, -1).join("/"),
  };
}

/** Shape a stored recents entry into a launcher row. */
export function toLauncherRow(entry: RecentFileEntry, now: number = Date.now()): LauncherRow {
  const { dir, name } = splitPath(entry.path);
  return {
    path: entry.path,
    name,
    dir,
    when: formatWhen(entry.openedAt, now),
    pip: pipClassFor(name),
  };
}

/**
 * Search + rank launcher rows with the command palette's fuzzy-match stack.
 *
 * Empty/whitespace query → all rows in input (recency) order, each with a
 * single unmatched segment. Otherwise each row is scored via
 * `scoreFields(q, name, dir)` — name is the primary field (full weight,
 * supplies the highlight indices), dir the secondary (×0.75, indices never
 * map onto the displayed name) — then sorted by `rankByScore` (score desc,
 * recency tiebreak via original index). Non-matching rows are excluded.
 *
 * Deliberate behavior changes vs the old boolean `.includes()` filter:
 * results rank by match quality rather than pure recency; subsequence
 * matches are included (e.g. "chp" matches "chapter.md"); a dir-only match
 * keeps the row but renders its name unhighlighted.
 */
export function searchRows(rows: LauncherRow[], query: string): RankedRow[] {
  const q = query.trim();
  if (!q) {
    return rows.map((row) => ({ row, nameSegments: toSegments(row.name, []) }));
  }
  const scored: Array<{ result: RankedRow; score: number; origIndex: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const fieldScore = scoreFields(q, row.name, row.dir);
    if (!fieldScore) continue;
    scored.push({
      result: { row, nameSegments: toSegments(row.name, fieldScore.indices) },
      score: fieldScore.score,
      origIndex: i,
    });
  }
  return rankByScore(scored);
}
