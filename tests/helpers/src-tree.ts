/**
 * One read of the `src/` tree, shared by the static-scan guards.
 *
 * **Why a helper rather than another copy.** Every suite that imports
 * `SRC_FILES` walks all of `src/`, and the census's own header records what
 * that costs: they share a worker pool, and a re-read per lookup was
 * *measurably* enough extra Windows filesystem contention to push two of them
 * over their timeouts in the full run. Each new copy of the walk is another
 * pass over ~530 files and ~6.5 MB.
 *
 * The consumer list deliberately is not enumerated here. It was, and it drifted
 * within two units: it named four suites, two of which (`documents-open`,
 * `client-log-callsites`) do their own `readdirSync` and never imported this at
 * all, while three that DO import it were missing. `grep -rl src-tree.js tests/`
 * is the answer, and unlike a comment it cannot be wrong.
 *
 * Module-level, so the read happens once per worker rather than once per suite
 * that imports it.
 *
 * **The sweep is deliberately wider than anything it guards**: every file under
 * `src/`, every extension, `.svelte` included, no filter. A guard scoped to
 * where the answer already is cannot report a new answer somewhere else — and
 * `annotation-remove-seam.test.ts` learned the narrow version's cost the hard
 * way, when review put a caller in a `.tsx` and then a `.js` and both survived
 * green. There are no such files in `src/` today, which is exactly why the
 * extension filter looked harmless.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  // `withFileTypes` so the directory test costs no extra syscall per entry.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Throws on invalid UTF-8 instead of substituting U+FFFD. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Every file under `src/`, repo-relative POSIX path → contents. Read once.
 *
 * **Undecodable content throws rather than entering the map**, because it is the
 * one failure mode a static guard cannot survive: `readFileSync(p, "utf8")` does
 * NOT throw on invalid UTF-8, it substitutes U+FFFD. A mis-encoded file would
 * arrive as a mangled string, every `filesMentioning` would match nothing in it,
 * and each guard built on this helper would report "no new callers" — a false
 * green precisely in the suites whose job is to catch one. The loud failures
 * need no help: a `readdirSync`/`readFileSync` error carries its path and aborts
 * module evaluation, which vitest reports against this file. The decode is
 * strict (`TextDecoder` with `fatal: true`, in `readTree`), so a file that
 * legitimately contains U+FFFD still reads.
 */
export const SRC_FILES: ReadonlyMap<string, string> = readTree(SRC);

/**
 * Every file under `dir`, repo-relative POSIX path → contents, with the same
 * fail-closed decode check as `SRC_FILES` (which is `readTree` of `src/`).
 * `filter` narrows by file name. For a guard over a tree other than `src/`
 * (`tests/server/ownership-module-seam.test.ts` reads `tests/`).
 */
export function readTree(
  dir: string,
  filter: (name: string) => boolean = () => true,
): ReadonlyMap<string, string> {
  return new Map(
    walk(dir)
      .filter((f) => filter(path.basename(f)))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .map((rel) => {
        // A strict decode, not a U+FFFD search: invalid bytes throw here, while
        // a file that legitimately contains U+FFFD (a test about sanitizing it)
        // reads as written.
        let contents: string;
        try {
          contents = STRICT_UTF8.decode(readFileSync(path.join(ROOT, rel)));
        } catch (err) {
          if ((err as { code?: string }).code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw err;
          throw new Error(
            `${rel} did not decode as UTF-8. Every guard reading this tree would silently ` +
              "match nothing in it — so this fails loudly instead.",
          );
        }
        return [rel, contents] as const;
      }),
  );
}

/**
 * Comments removed, so prose *about* a symbol is not counted as a use of it.
 *
 * Strings are deliberately NOT stripped: a module specifier is a string
 * literal, and stripping them made a whole sweep return nothing in
 * `documents-open.test.ts`. Callers that need the string-free form should strip
 * on top of this, and only for a symbol scan.
 *
 * **Line structure is preserved, which is load-bearing for any `^`-anchored
 * caller.** A block comment collapses to its own newlines plus spaces rather
 * than to a single space, because collapsing them defeated the export-set pin in
 * `annotation-create-seam-census.test.ts`: `/* … *\/ export const mint = …`
 * spanning two physical lines stripped onto ONE line, `export` landed mid-line,
 * and `/^export/m` matched neither the name regex nor the line count — so both
 * halves of a two-sided pin stayed green with the extra export present. Biome
 * leaves that comment placement alone, so it survived the formatter gate too.
 * Column offsets are not preserved and nothing should depend on them.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Files under `src/` that mention `identifier` outside a comment, sorted.
 *
 * **Word-bounded, not a substring test.** A substring check is beaten by a
 * longer rename — `removeAnnotationRecordForTests` contains
 * `removeAnnotationRecord` — and the two suites that share this helper had
 * disagreed on that, one bounded and one not.
 *
 * Tests the RAW text before stripping: stripping only ever REMOVES text, so a
 * raw miss is a stripped miss. Same verdict, with the regex pass running over
 * the handful of files that match rather than over all of `src/`.
 */
export function filesMentioning(identifier: string, exclude: readonly string[] = []): string[] {
  const pattern = new RegExp(`\\b${identifier}\\b`);
  return [...SRC_FILES]
    .filter(([rel]) => !exclude.includes(rel))
    .filter(([, contents]) => pattern.test(contents) && pattern.test(stripComments(contents)))
    .map(([rel]) => rel)
    .sort();
}
