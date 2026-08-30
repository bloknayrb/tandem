/**
 * One read of the `src/` tree, shared by the static-scan guards.
 *
 * **Why a helper rather than a fourth copy.** Four suites now walk all of
 * `src/` — `annotation-create-seam-census.test.ts`,
 * `annotation-remove-seam.test.ts`, `documents-open.test.ts` and
 * `client-log-callsites.test.ts` — and the census's own header records what
 * that costs: they share a worker pool, and a re-read per lookup was
 * *measurably* enough extra Windows filesystem contention to push two of them
 * over their timeouts in the full run. Each new copy of the walk is another
 * pass over ~530 files and ~6.5 MB.
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

/** Every file under `src/`, repo-relative POSIX path → contents. Read once. */
export const SRC_FILES: ReadonlyMap<string, string> = new Map(
  walk(SRC)
    .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
    .map((rel) => [rel, readFileSync(path.join(ROOT, rel), "utf8")] as const),
);

/**
 * Comments removed, so prose *about* a symbol is not counted as a use of it.
 *
 * Strings are deliberately NOT stripped: a module specifier is a string
 * literal, and stripping them made a whole sweep return nothing in
 * `documents-open.test.ts`. Callers that need the string-free form should strip
 * on top of this, and only for a symbol scan.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
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
