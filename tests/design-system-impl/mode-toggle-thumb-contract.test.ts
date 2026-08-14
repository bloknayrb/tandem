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
 * **Mostly NEGATIVE scans, and that is deliberate.** The positive literals this
 * file used to assert — `inline-grid`, `minmax(0,`, `grid-area: 1/1/2/2`,
 * `inset: 0`, `position: relative` — moved to css-pipeline-contract.test.ts,
 * which reads the same source and then runs it through the real minifier. What
 * stayed is what a positive scan cannot express: that something is ABSENT. No
 * percentage geometry, no width rule, no gutter — each a property admitting
 * infinitely many spellings, which is exactly the shape a `toContain` cannot
 * pin. (The translate check at the end is positive, and belongs here because it
 * guards the extraction as much as the declaration; see its comment.)
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

/** The same existence assertion, for a scan that needs the proof but not the body. */
function assertRuleExists(selector: string): void {
  ruleWithSelector(selector);
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
    //
    // Anchor on the exact base selector first, because a negative scan proves
    // nothing without evidence it scanned something — and this one is defeated
    // by a rename that changes no behaviour. `.mode-toggle > button` selects the
    // same elements and fails `startsWith`, so the filter yields zero rules and
    // `offenders` is `[]` by construction. Mutation-proved: that rename carrying
    // `min-width: 60px`, the exact bug this gate exists to catch, passed the
    // whole suite.
    //
    // `ruleWithSelector` is called for its assertion, not its value. Named so a
    // "remove the unused expression" cleanup cannot quietly reopen the hole.
    assertRuleExists(".mode-toggle button");

    // `fullSelectors`, not `selectors`: a `.mode-toggle { button { … } }` CSS
    // nesting rewrite gives the inner rule a bare local selector (`"button"`),
    // which never carries the `.mode-toggle` prefix a `startsWith` scan needs —
    // `fullSelectors` resolves it against the ancestor chain first. Reintroduces
    // the exact hole `assertRuleExists` above already guards against by name.
    const offenders = RULES.filter((r) =>
      r.fullSelectors.some((s) => s.startsWith(".mode-toggle button")),
    ).flatMap((r) =>
      [...r.body.matchAll(/(?:^|[;\s])((?:min-|max-)?width|flex)\s*:[^;]*/g)].map(
        (m) => `${r.fullSelectors.join(", ")} { ${m[0].trim()} }`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("carries no percentage-derived sizing on the thumb", () => {
    // A ban on VALUES, not an enumeration of properties, because §3.9 states it
    // that way — "no percentage or `calc` sizing or positioning on the thumb" —
    // and because every enumeration of this has been short. The last one listed
    // ten properties and still let `transform: translateX(50%)` through, which
    // is percentage positioning AND half of the literal #1383/#1384 mechanism
    // (`width: calc(50% - 2px)` plus a translate). `padding` and the individual
    // `translate` property were missing too.
    //
    // This costs nothing to hold: the shipped `.thumb` rule declares position,
    // grid-area, inset, background, border-radius, box-shadow, pointer-events,
    // z-index and transition, and the reduced-motion override declares
    // `transition: none` — not one `%` or `calc(` between them. The legal
    // `translateX(100%)` lives in `.thumb.tandem`, a different rule that
    // exact-selector matching never hands to this scan, and which the test
    // below pins positively.
    expect(
      ruleWithSelector(".thumb"),
      "#1383/#1384 were caused by sizing the thumb as a fraction of the track " +
        "(`width: calc(50% - 2px)`), which assumed equal halves the layout never produced. " +
        "The grid area supplies the box; see derived-spec.md §3.9.",
    ).not.toMatch(/%|calc\(/);
  });

  it("still slides exactly one column on a mode flip", () => {
    // Guards the extraction as much as the declaration: this legal percentage
    // lives one selector away from a rule that must contain none, so a
    // substring-matched scanner would flag it. Exact-selector matching is what
    // keeps the gate above honest.
    expect(ruleWithSelector(".thumb.tandem")).toMatch(/transform\s*:\s*translateX\(\s*100%\s*\)/);
  });
});
