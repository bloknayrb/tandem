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
 * Two of the gates below pin INVARIANTS ("no percentage-derived sizing", "no
 * width rule on the buttons") and survive any correct implementation. The rest
 * pin the current SHAPE and are marked accordingly — if a better placement
 * mechanism arrives, those are SUPERSEDED rather than violated, and the right
 * response is deleting them, not re-satisfying them.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const MODE_TOGGLE = join(ROOT, "src", "client", "editor", "toolbar", "ModeToggle.svelte");

/**
 * Rules are matched by EXACT selector, never substring: `.thumb.tandem`
 * legitimately declares `translateX(100%)`, and a broadened "no percentages in
 * .thumb" pattern would swallow it and flag a correct declaration.
 *
 * `styleBlocks` strips comments, which is mandatory rather than stylistic here:
 * the rules being pinned carry rationale comments quoting the very literals
 * scanned for (`grid-area: 1 / 1`, `calc(50% - 2px)`). An un-stripped scan reds
 * on the prose, and the path of least resistance is then deleting the prose.
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

  // SHAPE, not invariant — superseded by any placement that keeps the columns
  // equal under compression.
  it("sizes those columns with minmax(0, 1fr), not a bare 1fr", () => {
    const columns = /grid-template-columns\s*:([^;]+)/.exec(ruleWithSelector(".mode-toggle"))?.[1];
    expect(columns, "no grid-template-columns declaration").toBeDefined();
    expect(
      columns,
      "#1384: the two forms are identical while the track is shrink-to-fit, and diverge under " +
        "compression — measured at a 120px cap, bare `1fr` gives 52/70.97px columns while " +
        "`minmax(0, 1fr)` gives 60/60px. The thumb IS column 1, so unequal columns put it on a " +
        "segment of a different width. A squeezed label overflowing is the accepted trade.",
    ).toContain("minmax(0");
  });

  it("stays the thumb's containing block", () => {
    expect(
      ruleWithSelector(".mode-toggle"),
      "Measured: without `position: relative` the absolutely-positioned thumb takes the " +
        "VIEWPORT as its containing block and sizes itself against it. Nothing warns.",
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

  it("declares no width rule on the buttons", () => {
    // `flex: 1 1 0` was the false-premise line. It is dead under grid anyway,
    // and re-adding any width rule here would re-open the question the grid
    // columns now answer.
    const body = ruleWithSelector(".mode-toggle button");
    expect(body).not.toMatch(/(?:^|[;\s])flex\s*:/);
    expect(body).not.toMatch(/(?:^|[;\s])width\s*:/);
  });
});

describe(".thumb: placed into the first segment, never computed from it", () => {
  // SHAPE, not invariant — superseded if the thumb is ever placed by another
  // mechanism. Delete rather than re-satisfy; the E2E spec holds the invariant.
  it("names all four grid lines", () => {
    expect(
      thumbBaseRule(),
      "#1384: for an ABSOLUTELY-POSITIONED grid child an `auto` end line resolves to the " +
        "container's padding edge, NOT to `span 1` — so a two-line `grid-area: 1 / 1` " +
        "silently stretches the thumb across the whole track. Write all four lines.",
    ).toMatch(/grid-area\s*:\s*1\s*\/\s*1\s*\/\s*2\s*\/\s*2/);
  });

  // SHAPE, not invariant — same note as above.
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
        ...r.body.matchAll(/(?:^|[;\s])(width|height|left|right|top|bottom)\s*:[^;]*(%|calc\()/g),
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
