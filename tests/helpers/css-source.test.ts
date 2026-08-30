import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundledCssFiles,
  cssRulesBySelector,
  markupOutsideStyleBlocks,
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

describe("cssRulesBySelector: atRules and start (#1425's reduce-motion guard check)", () => {
  // Added alongside two new CssRule fields with no case here yet — precisely the
  // gap this file's own header warns about: a defect found by review, not by a
  // test, until one is added. `atRules` is deliberately independent of
  // `resolveSelectors`'s at-rule-transparent walk (see that function's doc
  // comment); this pins that it still walks the FULL chain, outermost first,
  // for a nested at-rule — the shape a single-level fixture cannot distinguish
  // from "stops after one level".
  it("returns the full enclosing at-rule chain, outermost first, for a nested at-rule", () => {
    const css = "@media (min-width: 1px) { @supports (display: grid) { .a { color: red } } }";
    expect(rules(css).find((r) => r.selectors[0] === ".a")?.atRules).toEqual([
      "@media (min-width: 1px)",
      "@supports (display: grid)",
    ]);
  });

  it("returns an empty at-rule chain for a rule with no at-rule ancestor", () => {
    expect(rules(".a{color:red}")[0].atRules).toEqual([]);
  });

  // `start` falls back to -1 when postcss's source map is absent
  // (`rule.source?.start?.offset ?? -1`). Every consumer compares two `start`s
  // with `toBeGreaterThan` to prove source order; a silent -1 on both sides
  // would make that comparison pass or fail for the wrong reason (-1 is not
  // greater than -1, so it fails closed here, but nothing enforces that this
  // fallback is never silently reached in practice — this pins that ordinary
  // parsed CSS never needs it).
  it("increases monotonically across two sibling rules, matching source order", () => {
    const [a, b] = rules(".a{color:red} .b{color:blue}");
    expect(a.start).toBeGreaterThanOrEqual(0);
    expect(b.start).toBeGreaterThan(a.start);
  });
});

/**
 * The markup half. Same rationale as the fixtures above: the property that
 * matters is invisible to every caller, because they all feed it well-formed
 * `.svelte` files where a single-pass strip and a fixpoint strip return the
 * same string.
 *
 * And the failure is the quiet direction again. A scan that silently retains a
 * `<style>` block does not throw — it sweeps in class names that were only ever
 * mentioned in CSS, which is a false POSITIVE in suites whose assertions are
 * mostly `toEqual([])`. Nothing downstream would say so.
 *
 * Fixtures go to disk because this helper takes a path, not a string.
 */
describe("markupOutsideStyleBlocks", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tandem-css-source-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fixture(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content, "utf-8");
    return path;
  }

  it("removes a style block and keeps the markup around it", () => {
    const file = fixture(
      "plain.svelte",
      '<button class="ctl">Go</button>\n<style>\n  .ctl { color: red; }\n</style>\n',
    );
    const markup = markupOutsideStyleBlocks(file);
    expect(markup).toContain('class="ctl"');
    expect(markup).not.toContain("color: red");
  });

  // Svelte's own `<style lang="postcss">` form. The opening tag is matched as
  // `<style[^>]*>`, so an attribute must not let the block survive.
  it("removes a style block carrying attributes", () => {
    const file = fixture(
      "attrs.svelte",
      '<div class="a"></div><style lang="postcss">.a{color:red}</style>',
    );
    expect(markupOutsideStyleBlocks(file)).not.toContain("color:red");
  });

  // The property CodeQL's js/incomplete-multi-character-sanitization names:
  // removing the inner block splices `<sty` onto `le>`, reintroducing exactly
  // the sequence that was removed. One pass leaves a live `<style>` in what it
  // calls "the markup".
  it("strips to a fixpoint, so a spliced-together block cannot survive", () => {
    const file = fixture("nested.svelte", "<sty<style>x</style>le>.a{color:red}</style>");
    expect(markupOutsideStyleBlocks(file)).not.toContain("<style");
  });

  it("returns nothing for a .css file, which is style all the way down", () => {
    expect(markupOutsideStyleBlocks(fixture("sheet.css", ".a{color:red}"))).toBe("");
  });

  // The two are used by sibling scans in the same suites — one asserting a
  // property of the CSS, one of the markup — so a disagreement about where the
  // boundary lies would let a declaration fall into neither half and be
  // asserted by nothing.
  it("is the complement of styleBlocks over the same file", () => {
    const file = fixture(
      "complement.svelte",
      '<span class="mark">hi</span>\n<style>\n  .mark { --x: 1; }\n</style>\n',
    );
    expect(styleBlocks(file)).toContain("--x: 1");
    expect(markupOutsideStyleBlocks(file)).not.toContain("--x: 1");
    expect(markupOutsideStyleBlocks(file)).toContain('class="mark"');
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
