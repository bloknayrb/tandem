import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRules, styleBlocks } from "../helpers/css-source";

/**
 * ModeToggle sliding-thumb geometry gate (#1383, #1384).
 *
 * Both issues are one defect: `.mode-toggle` asked flexbox to split the track
 * in half (`flex: 1 1 0`) and `.thumb` sized itself to that assumed half
 * (`width: calc(50% - 2px)`). Flexbox never delivered it — a flex item's
 * automatic minimum size is its min-content size, so "Tandem" was clamped up to
 * its natural width and "Solo" took the remainder. The pill then matched
 * neither segment (#1384) and each label sat off the pill's optical centre
 * (#1383). The full measurement table lives in the E2E spec, which is the only
 * file that can re-derive it.
 *
 * The fix removes the arithmetic rather than correcting it: the segments became
 * the two equal columns of an `inline-grid`, and the thumb is *placed into*
 * grid area 1/1/2/2 with `inset: 0`, so its box IS the first segment's box.
 *
 * **This file pins CSS shape, not effect.** No vitest project here has a layout
 * engine, so geometric truth is only observable in
 * `tests/e2e/mode-toggle-geometry.spec.ts`; what the *built* CSS looks like
 * after lightningcss is covered in `css-pipeline-contract.test.ts`, the only
 * gate that runs the real minifier. Three axes, none able to see the others.
 *
 * **Exactly one gate below pins an INVARIANT** — "carries no percentage-derived
 * sizing", and even that one is an invariant by SPEC FIAT rather than by
 * geometry: derived-spec.md §3.9 bans the mechanism outright because it is how
 * #1383/#1384 happened, and the ban is deliberately stricter than the geometric
 * requirement. (Measured counterexample: `flex: 1 1 0` + `min-width: 0` with the
 * OLD `width: calc(50% - 2px)` thumb yields solo 59.17 / tandem 59.19 / thumb
 * 59.17, flush to 0.00 — correct geometry, banned mechanism.)
 *
 * **Every other gate in this file pins the current SHAPE.** If a better
 * placement mechanism arrives they are SUPERSEDED rather than violated, and the
 * right response is deleting them, not re-satisfying them. That includes "no
 * width rule on the buttons", which reads like an invariant and is not — see
 * the counterexample above, which it would reject.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const MODE_TOGGLE = join(ROOT, "src", "client", "editor", "toolbar", "ModeToggle.svelte");

/**
 * Rules are matched by EXACT selector, never substring: `.thumb.tandem`
 * legitimately declares `translateX(100%)`, and a broadened "no percentages in
 * .thumb" pattern would swallow it and flag a correct declaration.
 *
 * `styleBlocks` strips comments, which is mandatory rather than stylistic here:
 * ModeToggle.svelte's rationale comment quotes the very literal this file scans
 * for (`grid-area: 1 / 1`, naming the two-line form as the trap). That prose
 * sits immediately BEFORE `.thumb {`, so an un-stripped scan folds it into the
 * selector text and trips `thumbBaseRule()`'s `toBe(1)` — and the cheapest path
 * back to green is then deleting the explanation.
 */
const RULES = cssRules(styleBlocks(MODE_TOGGLE)).map(([selector, body]) => ({
  selectors: selector.split(",").map((x) => x.trim()),
  body,
}));

function ruleWithSelector(selector: string): string {
  const found = RULES.filter((r) => r.selectors.includes(selector));
  expect(found.length, `no rule with selector \`${selector}\` — scanner desynced?`).toBeGreaterThan(
    0,
  );
  return found.map((r) => r.body).join("\n");
}

/**
 * `.thumb` appears twice: the base rule and the reduced-motion override, which
 * declares only `transition: none`. Anchoring on `background` picks the one
 * that paints, independent of the placement properties under test — and its
 * `toBe(1)` is what stops every gate below being "passed" by deleting the rule.
 */
function thumbBaseRule(): string {
  const candidates = RULES.filter(
    (r) => r.selectors.includes(".thumb") && /background\s*:/.test(r.body),
  );
  expect(
    candidates.length,
    "no painting `.thumb` rule found — the base rule was renamed, removed, or the scanner desynced",
  ).toBe(1);
  return candidates[0].body;
}

describe(".mode-toggle: the equal-segment premise the thumb rests on", () => {
  it("lays the segments out as two grid columns, not flex items", () => {
    const body = ruleWithSelector(".mode-toggle");
    expect(
      body,
      "#1383/#1384: `flex: 1 1 0` does NOT equalize these segments — a flex item's " +
        "automatic minimum size is its min-content size, so the longer 'Tandem' label wins " +
        "and the half-width thumb then matches neither segment.",
    ).toMatch(/display\s*:\s*inline-grid/);
    expect(body).toMatch(/grid-template-columns\s*:\s*repeat\(/);
  });

  it("sizes those columns with minmax(0, 1fr), not a bare 1fr", () => {
    const columns = /grid-template-columns\s*:([^;]+)/.exec(ruleWithSelector(".mode-toggle"))?.[1];
    expect(columns, "no grid-template-columns declaration").toBeDefined();
    expect(
      columns,
      "#1384: a guard, not the active fix. The two forms are identical while the track is " +
        "shrink-to-fit, and nothing in the shipped title bar compresses it (`.title-bar-mode` " +
        "is `flex: 0 0 auto`). They diverge once something does — measured at a border-box " +
        "120px cap, bare `1fr` gives 51.08/67.83 while `minmax(0, 1fr)` gives 57/57. The thumb " +
        "IS column 1, so unequal columns put it on a segment of a different width. The E2E " +
        "spec forces that cap with an injected max-width; a squeezed label overflowing is the " +
        "accepted trade.",
    ).toContain("minmax(0");
  });

  it("stays the thumb's containing block", () => {
    expect(
      ruleWithSelector(".mode-toggle"),
      "Measured: without `position: relative` the containing block falls through to " +
        "`.title-bar-mode`, which is itself positioned (TitleBar.svelte) — the grid placement " +
        "stops applying and the thumb covers the whole track with a 3px overhang. Note the " +
        "coupling this pins: correctness here depends on an ancestor rule in another file. " +
        "Nothing warns.",
    ).toMatch(/position\s*:\s*relative/);
  });

  it("keeps the column gutter at zero", () => {
    const nonZero = [
      ...ruleWithSelector(".mode-toggle").matchAll(
        /(?:^|[;\s])(?:row-|column-)?gap\s*:\s*([^;]+)/g,
      ),
    ]
      .map((m) => m[1].trim())
      .filter((v) => !/^0(?:[a-z%]*)?$/.test(v));
    expect(
      nonZero,
      "the thumb slides by exactly one column (`translateX(100%)`); any gutter desyncs " +
        "that translate from the column pitch and the pill lands short of the segment.",
    ).toEqual([]);
  });

  it("declares no width rule on the buttons, in any of their rules", () => {
    // `flex: 1 1 0` was the false-premise line. It is dead under grid anyway,
    // and re-adding any width rule here would re-open the question the grid
    // columns now answer. `min-width` is the one that actually bites: it
    // restores exactly the min-content floor `minmax(0, 1fr)` exists to defeat,
    // and it is invisible at rest — measured, `min-width: 60px` passes the E2E
    // spec and only diverges once the track is compressed.
    //
    // Every `.mode-toggle button*` rule is scanned, not just the base one:
    // `.on` and `:hover:not(.on)` are separate selectors and a width added
    // there would slip past a base-rule-only check.
    const offenders = RULES.filter((r) =>
      r.selectors.some((s) => s.startsWith(".mode-toggle button")),
    )
      .flatMap((r) =>
        [...r.body.matchAll(/(?:^|[;\s])((?:min-|max-)?width|flex)\s*:[^;]*/g)].map((m) => [
          r.selectors.join(", "),
          m[0].trim(),
        ]),
      )
      .map(([selector, decl]) => `${selector} { ${decl} }`);
    expect(offenders).toEqual([]);
  });
});

describe(".thumb: placed into the first segment, never computed from it", () => {
  it("names all four grid lines", () => {
    expect(
      thumbBaseRule(),
      "#1384: for an ABSOLUTELY-POSITIONED grid child an `auto` end line resolves to the " +
        "container's padding edge, NOT to `span 1`. Measured, a two-line `grid-area: 1 / 1` " +
        "breaks BOTH axes — width 136.78 vs 67.39 AND height 23 vs 21 (the track's vertical " +
        "padding). The row-end `2` is not decorative: with no `grid-template-rows` it lives in " +
        "the implicit grid and is what holds the bottom edge flush. Write all four lines.",
    ).toMatch(/grid-area\s*:\s*1\s*\/\s*1\s*\/\s*2\s*\/\s*2/);
  });

  it("declares inset: 0 on an absolutely-positioned box", () => {
    const body = thumbBaseRule();
    expect(
      body,
      "#1384: without `inset`, the absolutely-positioned box shrink-to-fits its (empty) " +
        "contents and renders 0x0. The grid placement alone does not size it.",
    ).toMatch(/inset\s*:\s*0(?![.\d])/);
    // Load-bearing pair: without `absolute`, `inset` is inert and the grid
    // placement makes the thumb a flow item that consumes a column.
    expect(body).toMatch(/position\s*:\s*absolute/);
  });

  it("carries no percentage-derived sizing", () => {
    const offenders = RULES.filter((r) => r.selectors.includes(".thumb"))
      .flatMap((r) => [
        // `inset` is in the list because it is the property the fix itself now
        // uses — `inset: 0 0 0 50%` would otherwise walk straight through the
        // one gate that exists to forbid percentage geometry.
        ...r.body.matchAll(
          /(?:^|[;\s])(inset|width|height|left|right|top|bottom)\s*:[^;]*(%|calc\()/g,
        ),
      ])
      .map((m) => m[0].trim());
    expect(
      offenders,
      "#1383/#1384 were caused by sizing the thumb as a fraction of the track " +
        "(`width: calc(50% - 2px)`), which assumed equal halves the layout never produced. " +
        "The grid area supplies the box; see derived-spec.md §3.9.",
    ).toEqual([]);
  });

  it("still slides exactly one column on a mode flip", () => {
    // Guards the extraction above as much as the declaration: this legal
    // percentage lives one selector away from a rule that must contain none,
    // and a substring-matched scanner would flag it.
    expect(ruleWithSelector(".thumb.tandem")).toMatch(/transform\s*:\s*translateX\(\s*100%\s*\)/);
  });
});
