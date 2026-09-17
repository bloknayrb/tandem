import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The open-issues sweep ledger's STATUS table is the sweep's record of what
 * shipped. A row whose column count does not match the header renders every
 * cell after the defect under the wrong heading — and in the worst case a row
 * with no newline before it is swallowed into the previous row's last cell and
 * does not render at all, which is how the Gc2a group sat invisible for eight
 * days (#2045).
 *
 * The defect is invisible in a diff and in most editors, and it had recurred
 * thirteen times before anyone counted. Nothing pinned this table, so this is
 * the guard #2045 asked for.
 *
 * A pipe inside a `code span` still splits a cell — backticks do not protect
 * it. Only a backslash does. So the field count must be computed by a scan
 * that tracks the escape, not by `split("|")`, which is exactly the mistake
 * that makes correct rows look broken and broken rows look correct.
 */

const LEDGER = resolve(__dirname, "../../docs/plans/2026-09-06-open-issues-sweep.md");

/** Byte offsets of every pipe NOT preceded by a backslash. */
function unescapedPipePositions(line: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === "\\") {
      i += 1; // skip the escaped character, whatever it is
      continue;
    }
    if (line[i] === "|") out.push(i);
  }
  return out;
}

/** Cells between the leading and trailing unescaped pipes, or null if not a row. */
function cellsOf(line: string): string[] | null {
  const pos = unescapedPipePositions(line);
  if (pos.length < 2) return null;
  const cells: string[] = [];
  for (let i = 0; i < pos.length - 1; i += 1) {
    cells.push(line.slice(pos[i] + 1, pos[i + 1]));
  }
  return cells;
}

function isSeparatorRow(line: string): boolean {
  return /^[\s|:-]+$/.test(line);
}

interface StatusTable {
  headerLine: number;
  columns: number;
  names: string[];
  rows: Array<{ line: number; cells: string[] }>;
}

function readStatusTable(): StatusTable {
  const lines = readFileSync(LEDGER, "utf8").replace(/\r\n/g, "\n").split("\n");

  // The PLANNING table's header also begins "| Wave | Group | Issues |" and is
  // five columns, and it comes FIRST. Matching on that would audit every status
  // row against the wrong width. "Skill ver" appears only in the status header.
  const headerIdx = lines.findIndex((l) => l.startsWith("| Wave ") && l.includes("Skill ver"));
  expect(headerIdx, "status-table header (the one carrying 'Skill ver') not found").toBeGreaterThan(
    -1,
  );

  const headerCells = cellsOf(lines[headerIdx]);
  expect(headerCells, "status-table header did not parse as a table row").not.toBeNull();

  // Bound the table. The "Wave 0 record" table further down is two columns, so
  // scanning to end-of-file would report all of its rows as defects.
  let end = headerIdx + 1;
  while (end < lines.length && lines[end].startsWith("|")) end += 1;

  const rows: Array<{ line: number; cells: string[] }> = [];
  for (let i = headerIdx + 1; i < end; i += 1) {
    if (isSeparatorRow(lines[i])) continue;
    const cells = cellsOf(lines[i]);
    if (cells) rows.push({ line: i + 1, cells });
  }

  return {
    headerLine: headerIdx + 1,
    columns: (headerCells as string[]).length,
    names: (headerCells as string[]).map((c) => c.trim()),
    rows,
  };
}

describe("open-issues sweep ledger: status table shape", () => {
  it("has the nine-column header the rows are written against", () => {
    const table = readStatusTable();
    expect(table.names).toEqual([
      "Wave",
      "Group",
      "Issues",
      "Branch",
      "PR",
      "Skill ver",
      "Hooks armed",
      "State",
      "Notes",
    ]);
  });

  it("scans a non-trivial number of rows", () => {
    // Guards the guard: a bounding bug that finds zero rows would make every
    // other assertion here pass vacuously.
    const table = readStatusTable();
    expect(table.rows.length).toBeGreaterThan(30);
  });

  it("gives every row exactly as many fields as the header", () => {
    const table = readStatusTable();
    const offenders = table.rows
      .filter((r) => r.cells.length !== table.columns)
      .map((r) => {
        const wave = r.cells[0]?.trim() ?? "";
        const group = r.cells[1]?.trim() ?? "";
        const delta = r.cells.length - table.columns;
        return `L${r.line} fields=${r.cells.length} (${delta > 0 ? `+${delta}` : delta}) — ${wave} | ${group}`;
      });

    expect(
      offenders,
      [
        "Rows below do not match the status table's column count.",
        "A pipe splits a cell even inside a `code span` — escape it as \\| .",
        "An over-wide row can also be TWO rows on one line: check for a missing newline.",
      ].join(" "),
    ).toEqual([]);
  });

  it("has no row that is two rows concatenated onto one line", () => {
    const table = readStatusTable();
    // A swallowed row shows as an EMPTY cell (two adjacent unescaped pipes) in
    // an over-wide row. An ordinary blank cell is "| |" — a space between — so
    // it does not match this.
    const concatenated = table.rows
      .filter((r) => r.cells.length > table.columns && r.cells.slice(0, -1).some((c) => c === ""))
      .map((r) => `L${r.line} — ${r.cells[0]?.trim()} | ${r.cells[1]?.trim()}`);

    expect(
      concatenated,
      "a row with no newline before it is invisible in the rendered table",
    ).toEqual([]);
  });
});
