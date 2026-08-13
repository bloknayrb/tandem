import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";

/**
 * Source-level CSS extraction shared by the `tests/design-system-impl/` suites.
 *
 * These suites assert properties of CSS *as authored* — which rules exist, which
 * hand-write a vendor prefix, which declare a token — so they read the source
 * rather than a rendered page. Two files had rolled their own byte-identical
 * copies of the first two helpers below, and the rule splitter was triplicated.
 * One copy is a bug to fix; N copies is a bug plus N-1 silent false negatives.
 *
 * **Rule extraction is a real parse (postcss), not a brace regex**, and the
 * reason is that the regex form failed silently in the one direction that
 * matters. A brace splitter cannot represent CSS nesting: a nested rule's
 * PARENT does not match as a whole either, so the parent's declarations are
 * swallowed and the parent vanishes from the list. Measured:
 *
 *     ".thumb{span{color:red}width:50%}"  ->  [["span", "color:red"]]
 *
 * `.thumb`'s banned `width: 50%` is simply gone, and every negative scan built
 * on the splitter reports green. Svelte 5 accepts nesting and lightningcss
 * compiles it, so this is one tidy-up away rather than hypothetical. A guard
 * was tried first and is why the parse is here: keying on `&`/`;` appearing in
 * a captured selector catches `&`-nesting and misses the bare-selector form
 * above entirely, which is a tell rather than a detector.
 *
 * postcss specifically, over lightningcss (also a dependency): it is LOSSLESS.
 * `handWrittenPairs` and the `-webkit-line-clamp` gate ask "is this prefix
 * hand-written in the source?", which a normalizing parser cannot answer
 * because it has already rewritten the answer. postcss round-trips authored
 * text, so `d.prop` is what the developer typed. It also leaves `:global(...)`
 * alone as opaque selector text, and parses Svelte's `:global { … }` block form
 * rather than rejecting it.
 *
 * Deliberately NOT migrated: `styleBlock` in activity-message-wrapping.test.ts.
 * It is a different primitive — singular, non-global, no comment stripping —
 * that asserts a block's presence rather than scanning its contents.
 */

/**
 * Every file whose CSS Vite routes through lightningcss. Deliberately excludes
 * `index.html`: its inline `<style>` is emitted verbatim, so it is NOT a bundled
 * source and the collapse cannot reach it. The two obey different rules.
 *
 * `withFileTypes` rather than a `statSync` per entry — measured 1.8ms against
 * 13.2ms over this corpus, and there are four call sites.
 */
export function bundledCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) bundledCssFiles(full, out);
    else if (full.endsWith(".svelte") || full.endsWith(".css")) out.push(full);
  }
  return out;
}

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

/** One authored rule: its selector list already split, and its declaration body. */
export type CssRule = { selectors: string[]; body: string };

/**
 * Every style rule in `css`, at any nesting depth and inside any at-rule.
 *
 * `selectors` comes from postcss, which splits a grouped selector list the way
 * CSS does rather than the way `String.split(",")` does — so `:is(.a, .b)`
 * stays one selector instead of becoming two nonsense ones. Comparing the
 * UNSPLIT list is the older trap this closes: `.thumb, .x { … }` stops matching
 * `.thumb`, and the scan reports the rule *missing* rather than reporting the
 * declaration it was hired to check.
 *
 * `body` is re-serialized from the declaration nodes as `prop: value` pairs, so
 * it holds exactly what was authored (postcss does not normalize) minus
 * comments and whitespace noise. Scans regex it, and every one of them anchors
 * on `(?:^|[;\s])`, which the `; ` join satisfies.
 *
 * Nested children are returned as their OWN rules, carrying their authored
 * relative selector (`&:hover`, or a bare `span`). No scan in the repo needs
 * them resolved against the parent, and resolving would mean re-implementing
 * the nesting cascade; what matters is that the parent keeps its declarations,
 * which is precisely what the brace splitter got wrong.
 */
export function cssRulesBySelector(css: string): CssRule[] {
  const out: CssRule[] = [];
  postcss.parse(css).walkRules((rule) => {
    const body = rule.nodes
      .filter((node) => node.type === "decl")
      .map((decl) => `${decl.prop}: ${decl.value}${decl.important ? " !important" : ""}`)
      .join("; ");
    out.push({ selectors: rule.selectors.map((s) => s.trim()), body });
  });
  return out;
}

/**
 * `cssRulesBySelector` as flat `[selectorList, declarationBlock]` pairs, for
 * callers that only scan bodies and never ask which selector they belong to.
 */
export function cssRules(css: string): Array<[string, string]> {
  return cssRulesBySelector(css).map((rule) => [rule.selectors.join(", "), rule.body]);
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
 * Throws rather than mis-rewrites, because flattening a selector LIST in place
 * is silent and wrong: `:global(.a, .b) .thumb` becomes `.a, .b .thumb`, two
 * selectors meaning something else entirely, and a gate asking "does a rule for
 * `.thumb` exist?" gets a confident "no". Distributing it (`.a .thumb, .b
 * .thumb`) is the real fix; nothing needs it yet, and a throw is honest until
 * something does.
 *
 * Only a TOP-LEVEL comma is a list. A comma nested inside a functional
 * pseudo-class — `:global(:is(.a, .b))`, `:global(.x:not(.a, .b))` — is one
 * selector and flattens safely, so throwing on it would be a false positive
 * that reds three test files. `App.svelte` already carries
 * `:global(body:not(…))`, one added class away from that shape.
 *
 * Known limitation, deliberately not handled: Svelte's `:global { … }` *block*
 * form (live in ToastContainer, ChatPanel, StatusBar). postcss parses it as an
 * ordinary rule with children, so no declaration is lost and every current gate
 * is unaffected — but a gate asking "is this rule global?" would get a wrong
 * answer with no signal.
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
    let topLevelComma = false;
    let i = start + TOKEN.length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "(") depth++;
      else if (css[i] === ")") depth--;
      else if (css[i] === "," && depth === 1) topLevelComma = true;
    }
    if (depth !== 0) {
      throw new Error(`css-source: unbalanced \`:global(\` starting at index ${start}.`);
    }
    const inner = css.slice(start + TOKEN.length, i - 1);
    if (topLevelComma) {
      throw new Error(
        `css-source: \`:global(${inner})\` holds a selector list. Flattening it in place ` +
          `changes what it matches; distribute the list across the descendant part instead.`,
      );
    }
    out += inner;
    cursor = i;
  }
}
