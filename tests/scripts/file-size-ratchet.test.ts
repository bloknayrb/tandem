import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripRustComments, stripRustTestModules } from "../docs/rust-sources.js";

/**
 * A size ceiling on source files, as a ratchet.
 *
 * Large files are where agents lose their way: a 5,000-line module cannot be
 * read whole, so every change to it is made from a partial view. Nothing in the
 * repo pushed back on growth before this — no `max-lines`, no Biome linter, no
 * script — so files only ever got bigger.
 *
 * The rule, in three parts:
 *  1. A file over its limit (`LIMITS`) must have an entry in
 *     `scripts/file-size-baseline.json`, with a reason.
 *  2. An entry's `lines` is a **ceiling**: the file may not grow past it.
 *  3. The ceiling is also **exact**: when a file shrinks, the entry must be
 *     lowered to match (or removed once the file is back under the limit). A
 *     ceiling left above the real size would let the file regrow for free, which
 *     is how a ratchet quietly stops being one.
 *
 * Rust is counted with its `#[cfg(test)]` modules removed
 * (`stripRustTestModules`), so adding a regression test to a large file never
 * trips its ceiling — the ratchet must not make tests the expensive thing.
 *
 * The failure messages print the exact JSON to write, so fixing a failure is
 * mechanical. They never write the file themselves: adding an entry is a
 * decision that needs a reason, and an auto-seeding mode would make that
 * decision for you.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "file-size-baseline.json");

interface Limit {
  dir: string;
  ext: RegExp;
  max: number;
  rust: boolean;
}

const LIMITS: Limit[] = [
  { dir: "src", ext: /\.(ts|svelte)$/, max: 800, rust: false },
  { dir: join("src-tauri", "src"), ext: /\.rs$/, max: 1000, rust: true },
];

interface BaselineEntry {
  lines: number;
  reason: string;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Lines in a Rust file, not counting its `#[cfg(test)]` items.
 *
 * `stripRustTestModules` needs comment-free input (a brace in a comment would
 * derail its brace counter), and `stripRustComments` drops block comments'
 * newlines, so neither output can be counted directly. Instead: the raw count,
 * minus the lines the test strip removes from the comment-free text.
 */
function rustLinesWithoutTests(raw: string): number {
  const code = stripRustComments(raw);
  return countLines(raw) - (countLines(code) - countLines(stripRustTestModules(code)));
}

/** Every scanned file over its limit, repo-relative and forward-slashed. */
function measure(): {
  oversize: Map<string, number>;
  scanned: number;
  limitFor: Map<string, number>;
} {
  const oversize = new Map<string, number>();
  const limitFor = new Map<string, number>();
  let scanned = 0;
  for (const limit of LIMITS) {
    const abs = join(REPO_ROOT, limit.dir);
    for (const e of readdirSync(abs, { recursive: true, withFileTypes: true })) {
      if (!e.isFile() || !limit.ext.test(e.name)) continue;
      const file = join(e.parentPath, e.name);
      const rel = file.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
      const raw = readFileSync(file, "utf8");
      const lines = limit.rust ? rustLinesWithoutTests(raw) : countLines(raw);
      scanned++;
      limitFor.set(rel, limit.max);
      if (lines > limit.max) oversize.set(rel, lines);
    }
  }
  return { oversize, scanned, limitFor };
}

function baseline(): Record<string, BaselineEntry> {
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
    files: Record<string, BaselineEntry>;
  };
  return parsed.files;
}

function entryJson(path: string, lines: number, reason = "<why this file may stay large>"): string {
  return `    ${JSON.stringify(path)}: { "lines": ${lines}, "reason": ${JSON.stringify(reason)} }`;
}

describe("source file size ratchet", () => {
  it("scans a real tree", () => {
    // The control: a walk that found nothing would make every check below pass.
    const { scanned, oversize } = measure();
    expect(scanned, "the size scan found almost no source files").toBeGreaterThan(300);
    // Named without a line count, so shrinking it does not break this control.
    expect(oversize.has("src/client/App.svelte"), "App.svelte must be in the scan").toBe(true);
  });

  it("lists every file over its limit, with a reason", () => {
    const { oversize, limitFor } = measure();
    const files = baseline();
    const missing = [...oversize]
      .filter(([path]) => !(path in files))
      .sort(([a], [b]) => a.localeCompare(b));
    expect(
      missing.map(([path]) => path),
      `These files exceed their size limit (.ts/.svelte ${LIMITS[0].max}, .rs ${LIMITS[1].max} ` +
        `lines excluding test modules) and have no entry in scripts/file-size-baseline.json. ` +
        `Split the file, or add an entry with a real reason:\n` +
        missing.map(([path, lines]) => entryJson(path, lines)).join(",\n") +
        `\n(limits: ${missing.map(([p]) => `${p}=${limitFor.get(p)}`).join(", ")})`,
    ).toEqual([]);

    const unexplained = Object.entries(files)
      .filter(([, entry]) => typeof entry.reason !== "string" || entry.reason.trim().length < 10)
      .map(([path]) => path);
    expect(unexplained, "baseline entries need a reason of at least 10 characters").toEqual([]);
  });

  it("holds every listed file at exactly its recorded ceiling", () => {
    const { oversize, limitFor } = measure();
    const files = baseline();
    const grew: string[] = [];
    const shrank: string[] = [];
    const stale: string[] = [];
    for (const [path, entry] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
      const lines = oversize.get(path);
      if (lines === undefined) {
        stale.push(
          limitFor.has(path)
            ? `${path} is now within its ${limitFor.get(path)}-line limit — delete its entry`
            : `${path} no longer exists or is no longer scanned — delete its entry`,
        );
      } else if (lines > entry.lines) {
        grew.push(`${path}: ${lines} lines, ceiling ${entry.lines}`);
      } else if (lines < entry.lines) {
        shrank.push(entryJson(path, lines, entry.reason));
      }
    }
    expect(
      grew,
      "These files grew past their recorded ceiling. Split them, or move code out, " +
        "rather than raising the ceiling — the baseline only ever goes down.",
    ).toEqual([]);
    expect(
      shrank,
      "These files shrank — well done. Lower their ceilings to match, so they cannot " +
        "regrow for free:\n" +
        shrank.join(",\n"),
    ).toEqual([]);
    expect(stale, "Stale baseline entries").toEqual([]);
  });
});
