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
 *     recipe's blur never worked in a real build: lightningcss (Vite's default
 *     CSS minifier — verified against 1.32.0, the version pinned today)
 *     collapses a `backdrop-filter` + `-webkit-backdrop-filter` pair into the
 *     `-webkit-` form ALONE — regardless of configured browser targets, and for
 *     any value, not just `none`. Chromium does not treat
 *     `-webkit-backdrop-filter` as an alias of the standard property, so the
 *     surviving declaration is inert there and the reset evaporated.
 *     That minifier hazard is tracked in #1188. If lightningcss ever stops
 *     collapsing the pair, that only makes this explanation stale — the
 *     assertions below stand on their own, since the recipe wants no blur
 *     either way.
 *
 * Dev never reproduced it: unminified CSS keeps the reset, so the popup looked
 * correct in `npm run dev` and broke only in the packaged app.
 *
 * These two gates are source-level (no build required, so they stay fast):
 * one pins the specific regression, the other forbids the fragile pattern.
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

/** Every file whose CSS is processed by Vite's minifier. */
function bundledCssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) bundledCssFiles(full, out);
    else if (full.endsWith(".svelte") || full.endsWith(".css")) out.push(full);
  }
  return out;
}

/**
 * index.html plus every bundled stylesheet. The recipe lives in index.html
 * today, but nothing stops a future rule targeting it from a component or a
 * standalone .css — those go through the same minifier, so they get the same
 * scrutiny.
 */
function minifiedSources(): string[] {
  return [INDEX_HTML, ...bundledCssFiles(CLIENT_ROOT)];
}

function allFloatingPillRules(): { file: string; selector: string; body: string }[] {
  const rules = minifiedSources().flatMap((f) =>
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
    // lightningcss collapses `backdrop-filter` + `-webkit-backdrop-filter` to
    // the -webkit- form alone, which Chromium ignores. So in minifier-processed
    // CSS the prefixed twin is never a safe companion — it silently converts
    // the pair into a declaration that does nothing on our primary target
    // (WebView2/Chromium). Write the standard property alone, or nothing.
    // index.html is in scope deliberately: its inline <style> is the recipe's
    // home and goes through the same minifier as the component styles.
    const offenders = minifiedSources()
      .filter((f) => /-webkit-backdrop-filter\s*:/.test(styleBlocks(f)))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
