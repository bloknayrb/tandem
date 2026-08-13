import { readFileSync } from "node:fs";

/**
 * Source-level CSS extraction shared by the `tests/design-system-impl/` suites.
 *
 * These suites assert properties of CSS *as authored* — which rules exist, which
 * hand-write a vendor prefix, which declare a token — so they read the source
 * rather than a rendered page. That means every one of them needs the same two
 * primitives, and before this module three files had rolled their own.
 *
 * The extractor is a regex, not a parser, and that is the reason to have exactly
 * one of it: Svelte's `<style>` syntax can grow (a `lang=` attribute, `module`,
 * nesting), and when it does, a stale copy does not fail loudly — it extracts an
 * empty string, finds zero offenders and reports **green**. That failure mode is
 * documented in-repo: css-pipeline-contract.test.ts records a scan whose first
 * prototype returned 0 pairs while 12 existed and looked passing. One copy is a
 * bug to fix; four copies is a bug plus three silent false negatives.
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
