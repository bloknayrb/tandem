import { readFileSync } from "node:fs";

/**
 * Source-level CSS extraction shared by the `tests/design-system-impl/` suites.
 *
 * These suites assert properties of CSS *as authored* — which rules exist, which
 * hand-write a vendor prefix, which declare a token — so they read the source
 * rather than a rendered page. Two files had rolled their own byte-identical
 * copies of the first two helpers below, and the rule splitter was triplicated.
 *
 * These are regexes, not a parser, and that is the reason to have exactly one of
 * each: Svelte's `<style>` syntax can grow (a `lang=` attribute, `module`,
 * nesting), and when it does, a stale copy does not fail loudly — it extracts an
 * empty string, finds zero offenders and reports **green**. That failure mode is
 * documented in-repo: css-pipeline-contract.test.ts records a scan whose first
 * prototype returned 0 pairs while 12 existed and looked passing. One copy is a
 * bug to fix; N copies is a bug plus N-1 silent false negatives.
 *
 * Deliberately NOT migrated: `styleBlock` in activity-message-wrapping.test.ts.
 * It is a different primitive — singular, non-global, no comment stripping —
 * that asserts a block's presence rather than scanning its contents.
 */

/** Strip CSS block comments so commented-out prose can't satisfy or trip a grep. */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * A file's authored CSS, comments removed.
 *
 * `.css` files are returned whole. For `.svelte` / `.html` only `<style>` blocks
 * are returned — an inline `style="…"` attribute is emitted verbatim by the
 * bundler and is therefore not the same artifact (CommandPalette's palette scrim
 * legitimately blurs a translucent backdrop that way).
 */
export function styleBlocks(file: string): string {
  const src = readFileSync(file, "utf-8");
  if (file.endsWith(".css")) return stripCssComments(src);
  return stripCssComments(
    [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n"),
  );
}

/**
 * Flat `[selectorList, declarationBlock]` pairs.
 *
 * Because a body may not contain braces, an at-rule wrapper never matches as a
 * whole — the scan steps past it and matches the rules *inside*, so a
 * declaration hidden in `@media` is still found rather than skipped.
 */
export function cssRules(css: string): Array<[string, string]> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1], m[2]]);
}
