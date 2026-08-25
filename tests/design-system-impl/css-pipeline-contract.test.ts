import { join, relative } from "node:path";
import { transform } from "lightningcss";
import { resolveConfig } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bundledCssFiles,
  cssRules,
  cssRulesBySelector,
  neutralizeSvelteGlobal,
  styleBlocks,
} from "../helpers/css-source";

/**
 * CSS pipeline contract.
 *
 * `backdrop-filter-guard.test.ts` next door asserts our *source* stays clear of a known
 * footgun. This file asserts the *toolchain assumption underneath that rule* — i.e. that
 * writing the standard property alone is still the safe thing to do. If lightningcss or
 * Vite's baseline ever drifts, that advice silently stops being true and macOS loses its
 * `-webkit-` prefix with nothing to say so. These gates make that drift loud.
 *
 * Two facts drive everything here (both measured against the real toolchain, #1188):
 *
 *  1. **There are two CSS pipelines.** `index.html`'s inline `<style>` is emitted verbatim
 *     — no minification, no autoprefixing (its comments survive into `dist/` intact).
 *     Component `<style>` blocks and `src/client/**\/*.css` go through lightningcss
 *     (`cssMinify: true` falls through to it — see Vite's `minifyCSS`). The same CSS text
 *     therefore compiles differently depending on which file it lives in. That asymmetry —
 *     not the collapse alone — is what shipped the #1189 blur: the recipe's blur survived
 *     verbatim in index.html while the component's reset was collapsed away.
 *
 *  2. **In bundled CSS, hand-writing a vendor prefix is what breaks it.** lightningcss is
 *     an autoprefixer; a hand-written pair fights it. For `backdrop-filter` it collapses
 *     the pair to the `-webkit-` form ALONE, which Chromium does not implement — so the
 *     declaration goes inert. Writing the standard property by itself is correct AND gets
 *     the prefix added for Safari automatically.
 *
 * The rule is deliberately not "never hand-write a prefix": `-webkit-line-clamp` is
 * REQUIRED (lightningcss won't add it), and index.html gets no autoprefixing at all, so
 * prefixes there must be hand-written. Both are pinned below so the rule can't be
 * over-generalised into a blanket ban that breaks shipped UI.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT_ROOT = join(ROOT, "src", "client");
const MODE_TOGGLE = join(CLIENT_ROOT, "editor", "toolbar", "ModeToggle.svelte");
const FORMATTING_BAR = join(CLIENT_ROOT, "shell", "FormattingBar.svelte");

/**
 * A single authored rule, ready to hand to the minifier.
 *
 * Rules are extracted one at a time rather than minifying a whole `<style>`
 * block, because `neutralizeSvelteGlobal` only rewrites `:global(...)` — the
 * rest of Svelte's CSS dialect would still need a real parser.
 */
function authoredRule(file: string, selector: string, mustDeclare?: RegExp): string {
  const matches = cssRulesBySelector(neutralizeSvelteGlobal(styleBlocks(file))).filter(
    (r) => r.selectors.includes(selector) && (!mustDeclare || mustDeclare.test(r.body)),
  );
  expect(
    matches.length,
    `expected exactly one \`${selector}\` rule in ${relative(ROOT, file).replace(/\\/g, "/")}` +
      (mustDeclare ? ` declaring ${mustDeclare}` : "") +
      " — renamed, removed, or the scanner desynced",
  ).toBe(1);
  return matches[0].body;
}

/**
 * Two rules in ModeToggle.svelte carry the exact selector `.thumb` — the base
 * rule and the reduced-motion media override — and the override declares only
 * `transition: none`. `background` picks the one that paints, independent of
 * every placement property under test.
 *
 * The in-app `:global(body.tandem-reduce-motion) .thumb` override is a third
 * `.thumb` rule in the file but not a third *candidate*: it is a descendant
 * selector, and the filter matches selectors exactly. Worth stating, because a
 * reader debugging a count failure would otherwise hunt for a rule that was
 * never in the running.
 */
const paintingRule = (selector: string) => authoredRule(MODE_TOGGLE, selector, /background\s*:/);
const trackRule = () => authoredRule(MODE_TOGGLE, ".mode-toggle");

/**
 * Vite's own esbuild-name -> lightningcss-key table, transcribed from
 * `vite/dist/node/chunks/node.js` (`const map = {...}`, beside `convertTargets`).
 *
 * Do NOT hand-roll this and do NOT route through `browserslist` (not a dependency here).
 * `ios` -> `ios_saf` is the entry that bites: `browserslistToTargets(["ios 16.4"])` yields
 * an `ios` key, which lightningcss **silently ignores** — no error, no warning, and the
 * desktop `safari` entry masks the difference, so the whole iOS axis can be wrong forever
 * while every assertion here stays green. `assertHonouredKeys` exists for exactly that.
 */
const VITE_TARGET_MAP: Record<string, string | false> = {
  chrome: "chrome",
  edge: "edge",
  firefox: "firefox",
  hermes: false,
  ie: "ie",
  ios: "ios_saf",
  node: false,
  opera: "opera",
  rhino: false,
  safari: "safari",
};

/** Keys lightningcss actually honours (`lightningcss/node/targets.d.ts`). */
const LIGHTNINGCSS_KEYS = new Set([
  "android",
  "chrome",
  "edge",
  "firefox",
  "ie",
  "ios_saf",
  "opera",
  "safari",
  "samsung",
]);

type Targets = Record<string, number>;

/** Mirrors Vite's `convertTargets`: name via the map, version as `major << 16 | minor << 8`. */
function convertTargets(cssTarget: string | string[]): Targets {
  const targets: Targets = {};
  for (const entry of [cssTarget].flat()) {
    const index = entry.search(/\d/);
    if (index < 0) throw new Error(`unparseable cssTarget entry: ${entry}`);
    const browser = VITE_TARGET_MAP[entry.slice(0, index)];
    if (browser === false) continue;
    if (!browser) throw new Error(`cssTarget entry not in Vite's map: ${entry}`);
    const [major, minor = 0] = entry
      .slice(index)
      .split(".")
      .map((v) => parseInt(v, 10));
    const version = (major << 16) | (minor << 8);
    if (!targets[browser] || version < targets[browser]) targets[browser] = version;
  }
  return targets;
}

let targets: Targets;

beforeAll(async () => {
  // `root` must be explicit. Resolved from any other cwd, Vite finds no config file and
  // silently returns its DEFAULT cssTarget — which is byte-identical to ours today, since
  // we don't override it. So a missing config would go unnoticed without the assertion in
  // "reads Tandem's real Vite config" below.
  const config = await resolveConfig({ root: ROOT }, "build");
  expect(config.configFile, "resolveConfig must actually find vite.config.ts").toBeDefined();
  const { cssTarget } = config.build;
  if (cssTarget === false) throw new Error("cssTarget must be set for this contract to hold");
  targets = convertTargets(cssTarget);
});

/** Minify one snippet exactly the way the real build's `minifyCSS` would. */
function minify(css: string): string {
  const { code, warnings } = transform({
    filename: "probe.css",
    code: Buffer.from(css),
    minify: true,
    targets,
  });
  // The draft version of this file ignored warnings; a reviewer pointed out that feeding
  // lightningcss something it flags is how you end up asserting against a facsimile.
  expect(warnings, `lightningcss warned on: ${css}`).toEqual([]);
  return code.toString();
}

const declares = (css: string, prop: string) => new RegExp(`[;{]\\s*${prop}\\s*:`).test(css);

describe("the Vite CSS target our authoring rule depends on", () => {
  it("reads Tandem's real Vite config", () => {
    // Guards the beforeAll assertion above from being silently skipped.
    expect(Object.keys(targets).length).toBeGreaterThan(0);
  });

  it("converts every target to a key lightningcss actually honours", () => {
    // The silent-failure gate. An unhonoured key (e.g. `ios` instead of `ios_saf`) is
    // dropped by lightningcss without complaint, so this would otherwise be invisible.
    const unhonoured = Object.keys(targets).filter((k) => !LIGHTNINGCSS_KEYS.has(k));
    expect(unhonoured).toEqual([]);
  });
});

describe("bundled CSS: hand-written vendor pairs keep their standard property", () => {
  it("survives lightningcss in BOTH declaration orders, for every property we pair", () => {
    const pairs = handWrittenPairs();

    // A zero here would pass vacuously. That is not hypothetical: the first prototype of
    // this scan returned 0 pairs while 12 existed (a mangled regex), and looked green.
    expect(
      pairs.length,
      "no hand-written vendor pairs found — extractor desynced?",
    ).toBeGreaterThan(0);

    const dropped: string[] = [];
    for (const { prop, value, where } of pairs) {
      // Order is the load-bearing variable, not the value: `backdrop-filter` collapses only
      // when the -webkit- form comes LAST. Probing one order would report green on the very
      // bug this exists to catch, so probe both and let order stop being a hidden variable.
      for (const css of [
        `.probe{${prop}:${value};-webkit-${prop}:${value}}`,
        `.probe{-webkit-${prop}:${value};${prop}:${value}}`,
      ]) {
        if (!declares(minify(css), prop)) dropped.push(`${where}: ${prop} (${css})`);
      }
    }
    expect(dropped).toEqual([]);
  });
});

describe("bundled CSS: writing the standard property alone is still the safe advice", () => {
  it("autoprefixes backdrop-filter for Safari when written alone", () => {
    // This is what makes "write the standard property, never the pair" correct rather than
    // merely tidy. If Vite's baseline ever moves past safari16.4 this fails, and macOS
    // WKWebView silently losing its prefix becomes a decision instead of an accident.
    const out = minify(".probe{backdrop-filter:blur(8px)}");
    expect(out).toContain("-webkit-backdrop-filter");
    expect(declares(out, "backdrop-filter")).toBe(true);
  });

  it("collapses a hand-written backdrop-filter pair to the inert -webkit- form", () => {
    // The #1189 bug, pinned. Chromium never implemented -webkit-backdrop-filter, so the
    // surviving declaration does nothing there and a scoped reset evaporates.
    // If this ever stops being true, the ban next door can be relaxed — this failing is
    // good news, not a regression.
    const out = minify(".probe{backdrop-filter:none;-webkit-backdrop-filter:none}");
    expect(declares(out, "backdrop-filter")).toBe(false);
  });

  it("does NOT add -webkit-line-clamp, so that pair must stay hand-written", () => {
    // The live counterexample that stops the rule above becoming a blanket "no prefixes"
    // ban. This pins WHY the hand-written pair is required; the gate that protects the
    // actual declaration is the source rule below.
    expect(minify(".probe{line-clamp:1}")).not.toContain("-webkit-line-clamp");
  });

  it("keeps the hand-written -webkit-line-clamp everywhere we clamp", () => {
    // The mirror image of the backdrop-filter ban, and the other half of the contract:
    // there the pair is forbidden (lightningcss adds it), here it is MANDATORY
    // (lightningcss won't). Chromium only implements the prefixed form, so a rule that
    // clamps without it silently stops clamping.
    //
    // This exists because the synthetic fixture above does not guard our source: deleting
    // AnnotationCard's declaration failed nothing until this gate was added.
    const missing = bundledCssFiles(CLIENT_ROOT).flatMap((file) =>
      cssRules(styleBlocks(file))
        .filter(([, body]) => /(^|[;\s])line-clamp\s*:/.test(body))
        .filter(([, body]) => !/-webkit-line-clamp\s*:/.test(body))
        .map(([selector]) => `${relative(ROOT, file).replace(/\\/g, "/")}: ${selector.trim()}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("bundled CSS: the #1302 formatting-bar declarations survive minification", () => {
  it("preserves the :has() z-lift selector", () => {
    // FormattingBar.svelte's wrap lift keys on `:has([aria-expanded="true"])`,
    // and that rule DOES live in a component <style> block, so it really does
    // ship through lightningcss. A future Vite/lightningcss bump that rewrites
    // or drops it re-buries every formatting-bar popover behind the selection
    // popup — and no E2E test would catch it, because Playwright drives
    // `npm run dev`, which never minifies.
    //
    // The real rule, both halves, not a `.w:has(...){z-index:9}` probe. Two
    // mutations, both of which passed a previous spelling of this gate:
    // deleting the rule outright (it was fully synthetic), and deleting it
    // while any other `:has([aria-expanded])` rule remained (the selector was
    // scraped, but taken as `wrap[0]` off an at-least-one guard). Identifying
    // it by the property that makes it the z-lift, and requiring exactly one,
    // closes both.
    const isLift = (s: string) => s.includes(":has(") && s.includes("aria-expanded");
    const lifts = cssRulesBySelector(neutralizeSvelteGlobal(styleBlocks(FORMATTING_BAR))).filter(
      (rule) => rule.selectors.some(isLift),
    );
    expect(
      lifts.map((r) => r.selectors.join(", ")),
      "expected exactly one `:has([aria-expanded])` rule in FormattingBar.svelte — " +
        "the #1302 z-lift was removed, renamed, or joined by a lookalike",
    ).toHaveLength(1);

    // Grouped as authored: counting RULES rather than selectors means a legal
    // `.a:has(…), .b:has(…)` grouping is one rule, not a false red.
    const out = minify(`${lifts[0].selectors.join(", ")}{${lifts[0].body}}`);
    expect(out).toContain(":has(");
    expect(out).toContain("aria-expanded");
    // The lift itself, not just its selector: a surviving `:has()` that no
    // longer raises anything is the bug wearing the gate's own shape.
    expect(out).toContain("z-index");
  });

  it("keeps overflow-x: clip / overflow-y: visible as a clip+visible pair", () => {
    // Forward-looking cover, stated plainly: today these two declarations live
    // in FormattingBar's inline `style=` attribute and therefore never reach
    // lightningcss at all. This exists so that moving them into the <style>
    // block — the tidy-up CLAUDE.md's two-pipeline guidance invites — does not
    // have to re-litigate the axis split.
    //
    // The invariant is the axis split, not the syntax: folding the two longhands
    // into the shorthand is benign and either form passes. Folding EITHER axis
    // to `hidden`/`auto` is not — a scrollable value on one axis silently
    // computes the other's `visible` to `auto` (CSS Overflow 3), which re-clips
    // the popovers.
    const out = minify(".p{overflow-x:clip;overflow-y:visible}");
    expect(out).toMatch(/overflow:\s*clip visible|overflow-x:\s*clip/);
    expect(out).not.toContain("hidden");
    expect(out).not.toContain("auto");
  });
});

describe("bundled CSS: the #1383/#1384 mode-toggle declarations survive minification", () => {
  // ModeToggle.svelte's thumb no longer computes its own box; it is PLACED into
  // the track's first grid column (`grid-area: 1 / 1 / 2 / 2` + `inset: 0`) so
  // that it cannot drift from the segment it selects. Those declarations live in
  // a component <style> block, so they really do ship through lightningcss —
  // and CI's Playwright run drives `npm run dev`, which never minifies, so no
  // E2E gate can see this axis. That blind spot is exactly the one that shipped
  // #1189 inert for six weeks.
  //
  // These gates read the REAL rules and minify those, so they also stand in for
  // the source-shape gates that used to live in mode-toggle-thumb-contract.test
  // .ts, adding minifier drift to what those caught. Not a strict superset,
  // and the exception is the first bullet below: a rewrite to the `inset`
  // longhands failed the old source regex and passes here, because the minifier
  // collapses it back. Deliberate — the two spellings are the same box — but
  // the two statements have to agree, and "fails on everything those did" did
  // not agree with the bullet six lines under it.
  //
  // Two rewrites were investigated and deliberately have no gate, because a test
  // that can only pass is not one — and neither is one that reds on a rename the
  // browser cannot tell apart:
  //
  //  - `top/right/bottom/left: 0` vs `inset: 0`: lightningcss collapses toward
  //    the shorthand at today's targets and expands away from it at older ones
  //    ({safari:13}, {chrome:80}, {ie:11}). Either direction is fine — the two
  //    forms are geometrically identical at every target, so no assertion over
  //    the choice can express a bug.
  //  - `translateX(100%)` → `translate(100%)`: lightningcss DOES rewrite this,
  //    so the axis is falsifiable and a `toContain("translateX")` gate would red.
  //    It has no gate because the rewrite is semantically identical, not because
  //    nothing happens to it.

  it("keeps the real .thumb placement intact", () => {
    // A synthetic `.probe{grid-area:1 / 1 / 2 / 2}` fixture would pass with
    // `.thumb` deleted from the component entirely. Same lesson as the
    // line-clamp gate above: minify what actually ships.
    //
    // The load-bearing assertion is `grid-area`. For an absolutely-positioned
    // grid child an `auto` end line resolves to the container's padding edge,
    // not `span 1` — and lightningcss is measured to collapse both
    // `1/1/auto/auto` and `grid-row:1;grid-column:1` to `1/1`, so the
    // optimization this guards is one it already performs elsewhere.
    const out = minify(`.thumb{${paintingRule(".thumb")}}`);
    for (const decl of ["grid-area:1/1/2/2", "inset:0", "position:absolute"]) {
      expect(out, `#1384: \`${decl}\` did not survive minification of the real rule`).toContain(
        decl,
      );
    }
  });

  it("keeps the real track's equal-column sizing intact", () => {
    const out = minify(`.mode-toggle{${trackRule()}}`);
    expect(
      out,
      "#1384: the thumb IS column 1, so the columns must stay equal at every track width. " +
        "A bare `1fr` floors each column at min-content and they diverge under compression; " +
        "the E2E spec measures that with an injected max-width.",
    ).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(out).toContain("inline-grid");
    // Without `position: relative` the containing block falls through to the
    // next positioned ancestor and the grid placement stops applying entirely.
    expect(out).toContain("position:relative");
    expect(out).toContain("gap:0");
  });
});

/**
 * Every rule body in bundled CSS that hand-writes both `-webkit-X` and `X`.
 *
 * Scoped to rule *bodies* on purpose. `scroll-fade.css`'s
 * `@supports (mask-image: ...) or (-webkit-mask-image: ...)` mentions both spellings in its
 * *condition* while declaring nothing — an occurrence-based scan counts it as a 13th pair
 * and reports a number that is simply wrong. (It is also why the probes below are synthetic:
 * 4 of these rules sit behind Svelte's `:global(...)`, which the real build strips before
 * lightningcss sees it. Feeding raw source selectors would make lightningcss warn on a
 * selector that never reaches it in production. Safe because the collapse is a property of
 * the declaration block, independent of selector and of any @media/@supports/@keyframes
 * wrapper — verified in #1188.)
 */
function handWrittenPairs(): { prop: string; value: string; where: string }[] {
  const found = new Map<string, { prop: string; value: string; where: string }>();
  for (const file of bundledCssFiles(CLIENT_ROOT)) {
    const css = styleBlocks(file);
    for (const [, body] of cssRules(css)) {
      for (const decl of body.matchAll(/-webkit-([a-z-]+)\s*:\s*([^;}]+)/g)) {
        const prop = decl[1];
        if (found.has(prop)) continue;
        if (!new RegExp(`(^|[;\\s])${prop}\\s*:`).test(body)) continue;
        found.set(prop, {
          prop,
          value: decl[2].trim().replace(/\s+/g, " "),
          where: relative(ROOT, file).replace(/\\/g, "/"),
        });
      }
    }
  }
  return [...found.values()];
}
