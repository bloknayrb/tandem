import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * backdrop-filter regression gate.
 *
 * The selection popup shipped a stray frosted-glass rectangle for ~6 weeks
 * (#798, 2026-06-03 → #1189, 2026-07-16), visible ONLY in production builds.
 * Two facts combined to cause it:
 *
 *  1. `.tandem-floating-pill` (index.html) carried `backdrop-filter: blur(8px)`.
 *     Every consumer of that recipe has an opaque `--tandem-surface` background
 *     that hides the blur — except the selection-popup SHELL, which #798 made
 *     deliberately transparent (the A8 two-pill design). There the blur painted
 *     across the shell's whole box, including the dead space beside the
 *     narrower Annotate capsule. (The popup had consumed the recipe since #762
 *     without incident, precisely because it was an opaque card back then.)
 *  2. The `backdrop-filter: none` reset #798 wrote onto that shell to cancel the
 *     recipe's blur never worked in a real build. `Toolbar.svelte`'s CSS goes
 *     through lightningcss (Vite's default CSS minifier — measured against
 *     1.32.0, the version pinned today), which collapses a hand-written
 *     `backdrop-filter` + `-webkit-backdrop-filter` pair into the `-webkit-`
 *     form ALONE when the prefixed line comes LAST. Chromium never implemented
 *     `-webkit-backdrop-filter`, so the surviving declaration is inert there and
 *     the reset evaporated.
 *
 * The two facts are not independent — the bug needed BOTH, and the reason is an
 * asymmetry worth knowing before you touch either file: **`index.html`'s inline
 * `<style>` is not processed at all** (emitted verbatim, comments and all), while
 * component `<style>` blocks and `src/client/**\/*.css` are. Pre-fix, the recipe
 * and the reset were *identical* hand-written pairs — the recipe's survived
 * because index.html is untouched, the reset's collapsed because Toolbar.svelte
 * is not. Had both gone through the same pipeline there'd have been no bug at
 * all. See #1188, the CLAUDE.md gotcha, and lesson 83.
 *
 * Two corrections to what an earlier version of this comment claimed, both
 * measured (#1188): the collapse is **order**-dependent, not value-dependent
 * (reverse the two lines and both survive), and browser targets very much do
 * matter — the standard property written ALONE is autoprefixed correctly for
 * Safari. Writing the pair by hand is what breaks it; lightningcss is an
 * autoprefixer and a hand-written pair fights it. `css-pipeline-contract.test.ts`
 * pins that behaviour executably, so it can't rot back into prose.
 *
 * Dev never reproduced it: dev runs no lightningcss at all, so the reset
 * survived and the popup looked correct in `npm run dev`.
 *
 * These gates are source-level (no build required, so they stay fast): one pins
 * the specific regression, the other forbids the fragile pattern.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const INDEX_HTML = join(ROOT, "index.html");
const CLIENT_ROOT = join(ROOT, "src", "client");

/** Strip CSS block comments so commented-out prose can't trip the greps. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Only `<style>` blocks go through the minifier. An inline `style="..."`
 * attribute is emitted verbatim, so it is exempt (CommandPalette's palette
 * scrim legitimately blurs a translucent backdrop that way).
 */
function styleBlocks(file: string): string {
  const src = readFileSync(file, "utf-8");
  if (file.endsWith(".css")) return stripCssComments(src);
  return stripCssComments(
    [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n"),
  );
}

/**
 * Matches a selector that targets the recipe class itself.
 *
 * Deliberately just the class token: the leading `\.` already rules out
 * `.not-tandem-floating-pill`, and the trailing lookahead rules out
 * `.tandem-floating-pill-foo`. An earlier version also demanded a preceding
 * boundary (`(^|[\s,>+~])`) — that guard bought nothing and silently dropped
 * `:where(.tandem-floating-pill)`, `:is(...)`, and compound selectors like
 * `.selection-popup.tandem-floating-pill`. The fixtures below pin all of it.
 */
const RECIPE_SELECTOR = /\.tandem-floating-pill(?![\w-])/;

/**
 * Every rule in `css` whose selector targets the recipe — not just the first,
 * and not just the base one. The recipe is also overridden per theme
 * (`[data-theme="dark"] .tandem-floating-pill`); a blur re-added to any variant
 * is the same bug.
 *
 * Caveat: this is a brace scanner, not a CSS parser. `@media`/`@supports`
 * wrappers are fine (the inner rule is recovered), but native CSS nesting
 * (`&`) would desync it — that surfaces as the "no rule found" throw below,
 * loudly, rather than as a silent pass. Reach for a real parser if we ever
 * nest this recipe.
 */
function floatingPillRulesIn(css: string): { selector: string; body: string }[] {
  return [...stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1].trim(), body: m[2] }))
    .filter((r) => RECIPE_SELECTOR.test(r.selector));
}

/**
 * Every file whose CSS Vite routes through lightningcss. Deliberately excludes
 * `index.html`: its inline `<style>` is emitted verbatim, so it is NOT a bundled
 * source and the collapse cannot reach it. The two obey different rules — see
 * `allRecipeSources` and the `-webkit-` gate below.
 */
function bundledCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) bundledCssFiles(full, out);
    else if (full.endsWith(".svelte") || full.endsWith(".css")) out.push(full);
  }
  return out;
}

/**
 * Everywhere the recipe could be declared or overridden: index.html (its home)
 * plus every bundled stylesheet. A blur re-added to the recipe is a bug wherever
 * it is written — index.html's exemption from the minifier makes the collapse
 * impossible there, not the blur.
 */
function allRecipeSources(): string[] {
  return [INDEX_HTML, ...bundledCssFiles(CLIENT_ROOT)];
}

function allFloatingPillRules(): { file: string; selector: string; body: string }[] {
  const rules = allRecipeSources().flatMap((f) =>
    floatingPillRulesIn(styleBlocks(f)).map((r) => ({ file: relative(ROOT, f), ...r })),
  );
  if (rules.length === 0) throw new Error("no .tandem-floating-pill rule found — parser desynced?");
  return rules;
}

describe(".tandem-floating-pill declares no backdrop-filter", () => {
  it("carries neither the standard nor the -webkit- property, in any variant", () => {
    // The recipe reaches one transparent consumer (the selection-popup shell),
    // so a blur here is a visible bug there — and it buys nothing on the opaque
    // consumers, whose --tandem-surface background occludes it entirely.
    const offenders = allFloatingPillRules()
      .filter((r) => /backdrop-filter\s*:/.test(r.body))
      .map((r) => `${r.file}: ${r.selector}`);
    expect(offenders).toEqual([]);
  });

  it("still carries the chrome the recipe exists to provide", () => {
    // Guards against the gate above being "passed" by deleting the whole rule.
    const base = allFloatingPillRules().find((r) => r.selector === ".tandem-floating-pill");
    expect(base, "base .tandem-floating-pill rule").toBeDefined();
    expect(base?.body).toMatch(/background\s*:/);
    expect(base?.body).toMatch(/border\s*:/);
    expect(base?.body).toMatch(/box-shadow\s*:/);
  });
});

/**
 * The gate above is only as good as the selector matcher underneath it, and a
 * hole there fails SILENTLY — it reports green. Both blind spots found in
 * review were exactly that: the matcher skipping a rule that does declare a
 * blur. Negative controls written from the same mental model as the matcher
 * can't find those, so pin the tricky shapes as fixtures instead.
 */
describe("the recipe matcher itself", () => {
  const BLUR = "{ backdrop-filter: blur(8px); }";
  const cases: [label: string, css: string, matched: boolean][] = [
    ["the base rule", `.tandem-floating-pill ${BLUR}`, true],
    ["a theme override", `[data-theme="dark"] .tandem-floating-pill ${BLUR}`, true],
    ["a :where() grouping", `:where(.tandem-floating-pill):hover ${BLUR}`, true],
    ["an :is() grouping", `:is(.tandem-floating-pill, .x) ${BLUR}`, true],
    ["a compound selector", `.selection-popup.tandem-floating-pill ${BLUR}`, true],
    ["a selector list", `.x, .tandem-floating-pill ${BLUR}`, true],
    ["an @media wrapper", `@media (min-width: 40em) { .tandem-floating-pill ${BLUR} }`, true],
    ["a different class", `.tandem-floating-pill-foo ${BLUR}`, false],
    ["a lookalike class", `.not-tandem-floating-pill ${BLUR}`, false],
  ];

  for (const [label, css, matched] of cases) {
    it(`${matched ? "sees" : "ignores"} ${label}`, () => {
      expect(floatingPillRulesIn(css).length > 0).toBe(matched);
    });
  }
});

describe("no bundled CSS declares a prefixed backdrop-filter", () => {
  it("declares no -webkit-backdrop-filter in any <style> block", () => {
    // In lightningcss-processed CSS the prefixed twin is never a safe companion:
    // written last it collapses the pair into a declaration that does nothing on
    // our primary target (WebView2/Chromium, which never implemented
    // `-webkit-backdrop-filter`). Write the standard property alone — targets
    // then add the Safari prefix for you. `css-pipeline-contract.test.ts` pins
    // both halves of that against the real minifier.
    //
    // Scoped to BUNDLED CSS on purpose. index.html was previously in scope with
    // the false rationale that it "goes through the same minifier" — it doesn't.
    // Nothing autoprefixes it, so a hand-written pair there is *correct*
    // authoring, and banning it would block correct code for a wrong reason. The
    // recipe itself is covered in index.html regardless, by the gate above.
    const offenders = bundledCssFiles(CLIENT_ROOT)
      .filter((f) => /-webkit-backdrop-filter\s*:/.test(styleBlocks(f)))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
