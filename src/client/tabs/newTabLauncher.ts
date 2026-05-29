/**
 * Pure helpers for the a7 new-tab launcher (`NewTabMenu.svelte`).
 *
 * Kept out of the component so the row-shaping, search filter, and match
 * highlighting are unit-testable in isolation — the `.svelte` file is then just
 * rendering + keyboard wiring. Ported from the Claude Design a7 bundle's
 * `new-tab-utils.ts`, adapted to production's stored recents shape
 * (`RecentFileEntry` with a full path + `openedAt`, vs the bundle's pre-split
 * name/path/when/ext mock).
 */

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

export interface NameSegment {
  text: string;
  match: boolean;
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

/** Case-insensitive substring match on the row's name and directory. */
export function matchesQuery(row: LauncherRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.name.toLowerCase().includes(q) || row.dir.toLowerCase().includes(q);
}

/**
 * Split `name` into matched / unmatched segments for substring highlighting.
 * The template renders matched segments inside `<mark>`. An empty/whitespace
 * query yields a single unmatched segment (the whole name).
 */
export function highlightSegments(name: string, query: string): NameSegment[] {
  const q = query.trim();
  if (!q) return [{ text: name, match: false }];
  const lower = name.toLowerCase();
  const ql = q.toLowerCase();
  const out: NameSegment[] = [];
  let i = 0;
  while (i < name.length) {
    const idx = lower.indexOf(ql, i);
    if (idx === -1) {
      out.push({ text: name.slice(i), match: false });
      break;
    }
    if (idx > i) out.push({ text: name.slice(i, idx), match: false });
    out.push({ text: name.slice(idx, idx + ql.length), match: true });
    i = idx + ql.length;
  }
  return out;
}
