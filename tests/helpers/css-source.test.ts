import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundledCssFiles,
  cssRulesBySelector,
  neutralizeSvelteGlobal,
  styleBlocks,
} from "./css-source";

/**
 * The extractor that every `tests/design-system-impl/` gate is built on.
 *
 * This file exists because two real defects in `css-source.ts` were found by
 * code review rather than by any test, and both had the same shape: the helper
 * mishandled a LEGAL input and returned a smaller, confident answer instead of
 * failing. A scan built on it then finds no offenders and reports green. Every
 * gate downstream inherits that, so a hole here is not one wrong test, it is
 * every test quietly asserting less than it says.
 *
 * Two complementary halves, and the split is deliberate:
 *
 *  - **Fixtures** pin the shapes that are hard, rare, or not in the repo yet —
 *    exactly the ones a corpus sweep cannot see, because the corpus does not
 *    contain them. This is the pattern backdrop-filter-guard.test.ts already
 *    uses for its recipe matcher, with the same rationale: negative controls
 *    written from the same mental model as the matcher cannot find its blind
 *    spots, so pin the tricky shapes directly.
 *  - **The corpus sweep** pins that the extractor still understands what this
 *    repo actually authors today. It fails the day someone adopts a form the
 *    helper cannot represent — which is the day the other gates would otherwise
 *    start passing vacuously.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT_ROOT = join(ROOT, "src", "client");

const rules = (css: string) => cssRulesBySelector(css);
/** Declarations of the one rule whose selector list contains `selector` exactly. */
const declsOf = (css: string, selector: string) =>
  rules(css)
    .filter((r) => r.selectors.includes(selector))
    .map((r) => r.body);

describe("cssRulesBySelector: shapes that must not lose declarations", () => {
  // THE regression. A brace-splitting regex cannot represent nesting: the
  // parent rule does not match as a whole either, so its declarations are
  // swallowed into the child's captured selector and the parent vanishes.
  // Measured on the old implementation, this returned [["span","color:red"]] —
  // `.thumb`'s banned `width: 50%` simply gone, with every scan green.
  it("keeps a parent's declarations when a bare selector is nested inside it", () => {
    expect(declsOf(".thumb{span{color:red}width:50%}", ".thumb")).toEqual(["width: 50%"]);
  });

  // The `&` form. A guard keyed on `&` appearing in a captured selector caught
  // this one and missed the bare form above, which is why detection was
  // replaced by a parse rather than made stricter.
  it("keeps a parent's declarations when an & rule is nested inside it", () => {
    const css = ".mode-toggle button{padding:3px 14px;min-width:60px;&:hover{color:blue}}";
    expect(declsOf(css, ".mode-toggle button")).toEqual(["padding: 3px 14px; min-width: 60px"]);
  });

  it("reaches rules wrapped in an at-rule", () => {
    const css = '@media (forced-colors: active){ .x[aria-pressed="true"]{outline:2px solid X} }';
    expect(declsOf(css, '.x[aria-pressed="true"]')).toEqual(["outline: 2px solid X"]);
  });

  it("drops commented-out CSS rather than reporting it as a rule", () => {
    expect(rules("/* .fake { width: 50% } */ .real{gap:0}").map((r) => r.selectors)).toEqual([
      [".real"],
    ]);
  });

  // Losslessness, which is the reason for postcss over lightningcss: two gates
  // ask "is this prefix HAND-WRITTEN in the source?", and a normalizing parser
  // has already rewritten the answer by the time they ask.
  it("preserves a hand-written vendor prefix exactly as authored", () => {
    expect(declsOf(".c{-webkit-line-clamp:2;line-clamp:2}", ".c")).toEqual([
      "-webkit-line-clamp: 2; line-clamp: 2",
    ]);
  });
});

describe("cssRulesBySelector: fullSelectors resolves nesting against ancestors", () => {
  // THE bypass: `selectors` on a nested rule is only its own local text
  // (`"button"`), which never carries `.mode-toggle`'s prefix — a
  // `startsWith(".mode-toggle button")` scan built on `selectors` reports zero
  // offenders no matter what the nested rule declares. Reproduced against
  // mode-toggle-thumb-contract.test.ts's real gate before fullSelectors existed.
  it("resolves a bare nested selector against its ancestor", () => {
    const css = ".mode-toggle{button{min-width:60px}}";
    expect(rules(css).find((r) => r.selectors[0] === "button")?.fullSelectors).toEqual([
      ".mode-toggle button",
    ]);
  });

  it("substitutes & with the ancestor rather than prefixing it", () => {
    const css = ".mode-toggle button{&:hover{color:blue}}";
    expect(rules(css).find((r) => r.selectors[0] === "&:hover")?.fullSelectors).toEqual([
      ".mode-toggle button:hover",
    ]);
  });

  it("cross-multiplies grouped selectors at both levels", () => {
    const css = ".a, .b { .c, .d { color: red } }";
    expect(rules(css).find((r) => r.selectors[0] === ".c")?.fullSelectors).toEqual([
      ".a .c",
      ".a .d",
      ".b .c",
      ".b .d",
    ]);
  });

  it("does not resolve past an at-rule boundary, but still resolves within it", () => {
    const css = ".mode-toggle{@media (forced-colors: active){button{min-width:60px}}}";
    expect(rules(css).find((r) => r.selectors[0] === "button")?.fullSelectors).toEqual([
      ".mode-toggle button",
    ]);
  });

  // A top-level (non-nested) rule's fullSelectors equals its selectors —
  // resolution is a no-op when there is no rule ancestor to resolve against.
  it("leaves an unnested rule's fullSelectors equal to its selectors", () => {
    expect(rules(".thumb{width:50%}")[0].fullSelectors).toEqual([".thumb"]);
  });
});

describe("cssRulesBySelector: selector lists split the way CSS splits them", () => {
  it("splits a grouped selector", () => {
    expect(rules(".a, .b { color: red }")[0].selectors).toEqual([".a", ".b"]);
  });

  // `String.split(",")` turns this into `[":is(.a", ".b)"]` — two selectors
  // that match nothing. `:has()` is already in use in FormattingBar.svelte and
  // is consumed by a gate, so this is one authored comma away from mattering.
  it("does NOT split a comma inside a functional pseudo-class", () => {
    expect(rules(".x:is(.a, .b) { color: red }")[0].selectors).toEqual([".x:is(.a, .b)"]);
  });
});

describe("neutralizeSvelteGlobal", () => {
  it("rewrites the plain form", () => {
    expect(neutralizeSvelteGlobal(":global(body.x) .thumb{a:b}")).toBe("body.x .thumb{a:b}");
  });

  // Live in App.svelte and ReplyThread.svelte. The original `[^()]*` regex
  // could not match these at all and left `:global(` in the output.
  it("rewrites a form holding nested parentheses", () => {
    expect(neutralizeSvelteGlobal(":global(body:not(.x)) .rail{a:b}")).toBe(
      "body:not(.x) .rail{a:b}",
    );
    expect(neutralizeSvelteGlobal('.w:has(:global([aria-expanded="true"])){a:b}')).toBe(
      '.w:has([aria-expanded="true"]){a:b}',
    );
  });

  // Flattening a list in place is silent and WRONG: `.a, .b .thumb` is two
  // selectors meaning something else, so a gate asking whether a `.thumb` rule
  // exists gets a confident "no".
  it("throws on a top-level selector list rather than flattening it", () => {
    expect(() => neutralizeSvelteGlobal(":global(.a, .b) .thumb{a:b}")).toThrow(
      /holds a selector list/,
    );
  });

  // The other side of that: a nested comma is ONE selector and flattens
  // safely. Throwing here would be a false positive, and App.svelte's
  // `:global(body:not(…))` is one added class from this shape.
  it("does not throw on a comma nested inside a functional pseudo-class", () => {
    expect(neutralizeSvelteGlobal(":global(:is(.a, .b)) .thumb{a:b}")).toBe(
      ":is(.a, .b) .thumb{a:b}",
    );
  });
});

describe("the extractor still reads what this repo authors", () => {
  const files = bundledCssFiles(CLIENT_ROOT);

  it("extracts a plausible number of rules from the real corpus", () => {
    // Counting FILES would not do: 45 of them legitimately have no `<style>`
    // block at all, so an empty extraction is already normal and a file count
    // survives total extractor failure untouched. Rules are the thing that
    // would go to zero, and every downstream scan is a filter over them.
    expect(files.length, "corpus walk found nothing — did the tree move?").toBeGreaterThan(50);

    const total = files.reduce(
      (sum, file) => sum + cssRulesBySelector(neutralizeSvelteGlobal(styleBlocks(file))).length,
      0,
    );
    expect(total, "extractor returned almost nothing — every gate is now vacuous").toBeGreaterThan(
      500,
    );
  });

  it("parses every bundled file without throwing", () => {
    const broken = files.flatMap((file) => {
      try {
        cssRulesBySelector(neutralizeSvelteGlobal(styleBlocks(file)));
        return [];
      } catch (err) {
        return [`${file.replace(/\\/g, "/").split("/src/client/")[1]}: ${(err as Error).message}`];
      }
    });
    expect(broken).toEqual([]);
  });
});
