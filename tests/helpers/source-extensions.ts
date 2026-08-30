/**
 * The one extension vocabulary the static-scan guards over `src/` derive from.
 *
 * Three guards walk the source tree and decide what to inspect by extension:
 * `tests/docs/documents-boundary.test.ts` (the `documents/` import inventory),
 * `tests/server/documents-open.test.ts` (who may import the reload family) and
 * `tests/docs/config-writer-set-claims.test.ts` (the durable-writer census).
 * A file the filter rejects is not merely unchecked — it is invisible to every
 * assertion downstream of the walk, and the guard reports clean.
 *
 * Review of ADR-034 Unit 7c found two ways that filter had been defeatable,
 * and both are about the *derivation* rather than about any assertion:
 *
 * 1. **Case.** Every one of the three matched extensions case-sensitively —
 *    `endsWith(".ts")` in one, an un-flagged `/\.(ts|…)$/` in the others. Note
 *    that `"Bypass.TS".endsWith(".ts")` is `false` on every platform, so this
 *    was never a Windows-versus-Linux question; it failed identically
 *    everywhere. `hasExtension` lowercases before comparing.
 * 2. **Disagreement.** The two `documents/` guards each defer part of their
 *    coverage to the other — the boundary file's docblock says bare
 *    `export { X };` laundering is `documents-open`'s to catch — while walking
 *    *different* extension sets (`ts|tsx|mts|cts|svelte` against `ts|svelte`).
 *    A `.mts` consumer that bare re-exported a sanctioned symbol was invisible
 *    to both at once: no specifier edge for the first, outside the extension
 *    for the second. A deferral is only as good as the guard it defers to, and
 *    nothing pinned the two sets equal. Sharing the constant makes them equal
 *    by construction rather than by an assertion someone has to keep writing.
 *
 * Today `src/` holds only `.ts`, `.svelte` and `.css`, so neither fix changes
 * what any guard currently scans. They are hardening against a rename, not the
 * closing of a live hole — which is exactly when this kind of fix is cheap.
 *
 * The census guard keeps its own wider list (it also scans `.js`/`.mjs`/`.cjs`,
 * because a config writer can be plain JavaScript) and passes it to
 * `hasExtension`; only the case-folding is shared there, not the vocabulary.
 */

import { extname } from "path";

/** Extensions that can hold TypeScript or Svelte source under `src/`. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".svelte"] as const;

/**
 * Case-insensitive extension match.
 *
 * `extname` rather than `endsWith`, because `endsWith` also matches a file
 * merely *ending* in the string — `foo.not-ts` ends with `-ts`, and more to the
 * point `x.mts` ends with `ts`. The list may be given in any case.
 */
export function hasExtension(name: string, extensions: readonly string[]): boolean {
  const ext = extname(name).toLowerCase();
  return extensions.some((e) => e.toLowerCase() === ext);
}

/**
 * A file a source-scanning guard must look inside.
 *
 * Declaration files are excluded: they carry no call sites and no runtime
 * imports, and including them would put ambient re-exports into every
 * inventory. The `.d.mts`/`.d.cts` forms are covered too, and the check is
 * case-insensitive for the same reason the extension match is.
 */
export function isSourceFile(name: string): boolean {
  return hasExtension(name, SOURCE_EXTENSIONS) && !/\.d\.[mc]?ts$/i.test(name);
}
