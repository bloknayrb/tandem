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
 *
 * That same property makes CSS nesting unrepresentable, and unrepresentable in
 * the one direction that fails green: a nested rule's parent does not match as a
 * whole either, so the parent's own declarations are swallowed into the child's
 * captured *selector* and the parent vanishes from the list. A negative scan
 * ("no rule declares a width") then finds nothing and passes while the banned
 * declaration ships. Svelte 5 accepts nesting and lightningcss compiles it, so
 * this is one refactor away, not hypothetical — hence the guard rather than a
 * comment. `&` cannot appear in a flat selector and `;` cannot appear in any
 * selector this repo writes, so both are nesting tells.
 */
export function cssRules(css: string): Array<[string, string]> {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (m) => [m[1], m[2]] as [string, string],
  );
  for (const [selector] of rules) {
    if (selector.includes("&") || selector.includes(";")) {
      throw new Error(
        `css-source: CSS nesting detected near ${JSON.stringify(selector.trim().slice(0, 60))}. ` +
          `The flat splitter drops the parent rule's declarations, so every scan built on it ` +
          `would pass while missing them. Upgrade this helper to a real parser before nesting here.`,
      );
    }
  }
  return rules;
}

/** One authored rule: its selector list already split, and its declaration body. */
export type CssRule = { selectors: string[]; body: string };

/**
 * `cssRules` with the selector list split on `,`, which is what "does this rule
 * apply to `.foo`?" actually needs.
 *
 * Comparing the unsplit list instead is the trap this exists to close: it works
 * until someone groups the selector, and then `.thumb, .x { … }` stops matching
 * `.thumb` and the scan reports the rule *missing* rather than reporting the
 * declaration it was hired to check. Two suites had independently rolled this,
 * and a third arrived comparing the unsplit form — three answers to one question.
 */
export function cssRulesBySelector(css: string): CssRule[] {
  return cssRules(css).map(([selectorList, body]) => ({
    selectors: selectorList.split(",").map((s) => s.trim()),
    body,
  }));
}

/**
 * Rewrite Svelte's `:global(x)` to plain `x` so a component `<style>` block can
 * be handed to a real CSS parser.
 *
 * lightningcss does not *reject* `:global(...)` — measured, it passes the
 * selector through unchanged and emits a `SelectorError` warning. The gates hold
 * because `minify()` asserts the warning list is empty, which is a different
 * mechanism than refusal and permits a different set of safe uses. Without this
 * rewrite a whole-block gate cannot exist, and the fallback — extracting one
 * rule at a time — is what leaves synthetic-probe tests standing in for real
 * ones.
 *
 * Both failure modes below throw, because the alternative is worse than a crash.
 * A `:global()` this cannot rewrite is left verbatim and merely warns, but one
 * it rewrites *wrongly* is silent: `:global(.a, .b) .thumb` flattens to
 * `.a, .b .thumb`, which splits into two selectors that mean something else
 * entirely, and a gate asking "does a rule for `.thumb` exist?" gets a confident
 * "no". Distributing the list correctly (`.a .thumb, .b .thumb`) is the real
 * fix; nothing in the repo needs it yet, and a throw is honest until something
 * does.
 *
 * Known limitation, deliberately not handled: Svelte's `:global { … }` *block*
 * form (live in ToastContainer, ChatPanel, StatusBar). `cssRules` steps past the
 * wrapper and emits the inner rules as though they were scoped, so no
 * declaration is lost and every current gate is unaffected — but a future gate
 * asking "is this rule global?" would get a wrong answer with no signal.
 */
export function neutralizeSvelteGlobal(css: string): string {
  const TOKEN = ":global(";
  let out = "";
  let cursor = 0;
  for (;;) {
    const start = css.indexOf(TOKEN, cursor);
    if (start === -1) return out + css.slice(cursor);
    out += css.slice(cursor, start);
    let depth = 1;
    let i = start + TOKEN.length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "(") depth++;
      else if (css[i] === ")") depth--;
    }
    if (depth !== 0) {
      throw new Error(`css-source: unbalanced \`:global(\` starting at index ${start}.`);
    }
    const inner = css.slice(start + TOKEN.length, i - 1);
    if (inner.includes(",")) {
      throw new Error(
        `css-source: \`:global(${inner})\` holds a selector list. Flattening it in place ` +
          `changes what it matches; distribute the list across the descendant part instead.`,
      );
    }
    out += inner;
    cursor = i;
  }
}
