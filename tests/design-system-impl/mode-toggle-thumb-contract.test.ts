import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssRulesBySelector, styleBlocks } from "../helpers/css-source";

/**
 * ModeToggle sliding-thumb geometry gate (#1383, #1384).
 *
 * The mechanic is documented on the declarations themselves in
 * ModeToggle.svelte; this file pins the shape of that fix rather than
 * re-explaining it. What a failure means is in each message below.
 *
 * **These are all NEGATIVE scans, and that is deliberate.** The positive
 * literals this file used to assert — `inline-grid`, `minmax(0,`,
 * `grid-area: 1/1/2/2`, `inset: 0`, `position: relative` — moved to
 * css-pipeline-contract.test.ts, which reads the same source and then runs it
 * through the real minifier, so it fails on everything these did *plus*
 * minifier drift. Mutation-tested both ways: those five gates were strictly
 * subsumed, and this file's own rule is that a superseded gate should be
 * deleted rather than re-satisfied.
 *
 * What survives is what a positive scan cannot express: that something is
 * ABSENT. No percentage geometry, no width rule, no gutter — each of them a
 * property that admits infinitely many spellings, which is exactly the shape a
 * `toContain` cannot pin.
 *
 * One of them is a genuine invariant, and by SPEC FIAT rather than by geometry:
 * derived-spec.md §3.9 bans percentage-derived thumb sizing outright because it
 * is how #1383/#1384 happened, deliberately stricter than the geometric
 * requirement. The other two pin the current shape and are superseded — not
 * violated — by any mechanism that keeps the segments equal.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const MODE_TOGGLE = join(ROOT, "src", "client", "editor", "toolbar", "ModeToggle.svelte");

/**
 * `styleBlocks` strips comments, which is mandatory rather than stylistic here:
 * ModeToggle.svelte's rationale comments quote CSS literals, and prose sitting
 * immediately before a `{` is folded into the selector text by a brace-based
 * splitter. The cheapest path back to green would then be deleting the
 * explanation.
 */
const RULES = cssRulesBySelector(styleBlocks(MODE_TOGGLE));

/** Bodies of every rule whose selector list contains `selector` exactly. */
function ruleWithSelector(selector: string): string {
  const found = RULES.filter((r) => r.selectors.includes(selector));
  expect(found.length, `no rule with selector \`${selector}\` — scanner desynced?`).toBeGreaterThan(
    0,
  );
  return found.map((r) => r.body).join("\n");
}

describe("ModeToggle: the mechanisms that must stay absent", () => {
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
    // `min-width` is the one that bites: it restores the min-content floor
    // `minmax(0, 1fr)` exists to defeat, and it is invisible at rest — only the
    // compression test in the E2E spec sees its effect.
    //
    // Every `.mode-toggle button*` rule is scanned, not just the base one:
    // `.on` and `:hover:not(.on)` are separate selectors and a width added
    // there would slip past a base-rule-only check.
    const offenders = RULES.filter((r) =>
      r.selectors.some((s) => s.startsWith(".mode-toggle button")),
    ).flatMap((r) =>
      [...r.body.matchAll(/(?:^|[;\s])((?:min-|max-)?width|flex)\s*:[^;]*/g)].map(
        (m) => `${r.selectors.join(", ")} { ${m[0].trim()} }`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("carries no percentage-derived sizing on the thumb", () => {
    // The property list tracks the ban, not the current implementation:
    // `inset` because the fix itself now uses it, `margin` because
    // `margin-left: 50%` is percentage positioning the spec forbids and an
    // earlier list let through.
    const offenders = [
      ...ruleWithSelector(".thumb").matchAll(
        /(?:^|[;\s])(inset|margin|width|height|left|right|top|bottom)[a-z-]*\s*:[^;]*(%|calc\()/g,
      ),
    ].map((m) => m[0].trim());
    expect(
      offenders,
      "#1383/#1384 were caused by sizing the thumb as a fraction of the track " +
        "(`width: calc(50% - 2px)`), which assumed equal halves the layout never produced. " +
        "The grid area supplies the box; see derived-spec.md §3.9.",
    ).toEqual([]);
  });

  it("still slides exactly one column on a mode flip", () => {
    // Guards the extraction as much as the declaration: this legal percentage
    // lives one selector away from a rule that must contain none, so a
    // substring-matched scanner would flag it. Exact-selector matching is what
    // keeps the gate above honest.
    expect(ruleWithSelector(".thumb.tandem")).toMatch(/transform\s*:\s*translateX\(\s*100%\s*\)/);
  });
});
