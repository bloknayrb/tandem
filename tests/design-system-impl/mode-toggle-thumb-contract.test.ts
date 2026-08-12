import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ModeToggle sliding-thumb geometry gate (#1383, #1384).
 *
 * Both issues are one defect. `.mode-toggle` asked flexbox to split the track
 * in half (`flex: 1 1 0`) and `.thumb` sized itself to that assumed half
 * (`width: calc(50% - 2px)`). Flexbox never delivered it: a flex item's
 * automatic minimum size is its **min-content** size, and "Tandem" is a single
 * unbreakable word, so its segment was clamped up to its natural width and
 * "Solo" took whatever was left. Measured under the shipped SN Pro face:
 *
 *              before                      after
 *   solo seg   50.53px  }  unequal        67.83px  }  equal
 *   tandem seg 67.83px  }                 67.83px  }
 *   thumb      59.17px                    67.83px
 *   thumb vs active button   dL/dR up to 8.64px    0.00 on all four edges
 *   label ink vs thumb centre     4.32px off       0.00
 *   track                    124.36 x 26px         141.66 x 26px (+17.30 wide)
 *
 * The overhang is #1384 directly. #1383 is the same error seen from the user's
 * side: the label is centred in its *button*, but the button is invisible and
 * the thumb is what the eye reads, so the ink lands half the mismatch off the
 * pill's centre.
 *
 * The fix removes the arithmetic rather than correcting it. The segments became
 * the two equal columns of an `inline-grid`, and the thumb is *placed into*
 * grid area 1/1/2/2 with `inset: 0`, so its box IS the first segment's box.
 *
 * **This file pins CSS shape, not effect.** No vitest project in this repo has
 * a layout engine: the `client` project is happy-dom (vitest.config.ts:29) and
 * this file lands in the `node` project (:44-45) with no DOM at all, where
 * `getBoundingClientRect` cannot answer anything. The geometric truth is only
 * observable in a real browser, which is `tests/e2e/mode-toggle-geometry.spec.ts`.
 * The third axis — what the *built* CSS looks like after lightningcss — is
 * covered in `css-pipeline-contract.test.ts`, the only gate that runs the real
 * minifier.
 *
 * A shape gate can red for the right reason and the wrong one. Every failure
 * message below states the invariant, so that a deliberate re-formulation is
 * fixed by updating the pin rather than by routing around it.
 *
 * **Comments are stripped before every grep, and that is mandatory rather than
 * stylistic.** The rules being pinned carry long rationale comments that quote
 * the very literals scanned for here (`grid-area: 1 / 1`, `calc(50% - 2px)`) —
 * the file carried `calc(50% - 2px)` in a comment even before this change. An
 * un-stripped scan reds on the prose, and the path of least resistance under
 * time pressure is deleting the prose. That is exactly how the first attempt at
 * #1383 shipped a comment asserting a property that had never been true, so one
 * test below asserts the prose is still there.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const MODE_TOGGLE = join(ROOT, "src", "client", "editor", "toolbar", "ModeToggle.svelte");

/** Strip CSS block comments so commented-out prose can't trip the greps. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function styleBlock(): string {
  const src = readFileSync(MODE_TOGGLE, "utf-8");
  return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
}

/**
 * Brace scanner in the shape of `backdrop-filter-guard.test.ts`'s
 * `floatingPillRulesIn`. Rules are matched by EXACT selector, never substring:
 * `.thumb.tandem` legitimately declares `translateX(100%)`, and a broadened
 * "no percentages in .thumb" pattern would swallow it and flag a correct
 * declaration. `@media` wrappers are fine — the inner rule is recovered with
 * its own selector.
 */
function rules(): { selector: string; body: string }[] {
  return [...stripCssComments(styleBlock()).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));
}

function ruleWithSelector(selector: string): string {
  const found = rules().filter((r) => r.selector === selector);
  expect(found.length, `no rule with selector \`${selector}\` — scanner desynced?`).toBeGreaterThan(
    0,
  );
  return found.map((r) => r.body).join("\n");
}

/**
 * The `.thumb` selector appears twice: the base rule and the reduced-motion
 * override inside `@media (prefers-reduced-motion: reduce)`, which declares
 * only `transition: none`. The base one is the rule that paints — anchoring on
 * `background` keeps this independent of the placement properties under test.
 */
function thumbBaseRule(): string {
  const candidates = rules().filter(
    (r) => r.selector === ".thumb" && /background\s*:/.test(r.body),
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
    expect(body).toMatch(/grid-template-columns\s*:\s*repeat\(\s*2\s*,\s*1fr\s*\)/);
  });

  it("sizes those columns with a bare 1fr, never minmax(0, …)", () => {
    // Every other grid in src/client writes `minmax(0, 1fr)` (HelpModal,
    // SettingsModal, SettingsAboutTab, editor-stage), so normalizing to the
    // house style is the natural /simplify pass. Here the `auto` minimum that
    // plain `1fr` carries IS the fix: with a 0 minimum a column can be squeezed
    // back under its own label and both issues reopen.
    const columns = /grid-template-columns\s*:([^;]+)/.exec(ruleWithSelector(".mode-toggle"))?.[1];
    expect(columns, "no grid-template-columns declaration").toBeDefined();
    expect(
      columns,
      "#1383/#1384: `1fr` here means `minmax(auto, 1fr)`, and the auto minimum is what stops " +
        "a column being squeezed narrower than its label. Do not normalize to `minmax(0, 1fr)`.",
    ).not.toContain("minmax(0");
  });

  it("stays the thumb's containing block", () => {
    expect(
      ruleWithSelector(".mode-toggle"),
      "Measured: without `position: relative` the absolutely-positioned thumb takes the " +
        "VIEWPORT as its containing block and sizes itself against it. Nothing warns.",
    ).toMatch(/position\s*:\s*relative/);
  });

  it("keeps the column gutter at zero", () => {
    const body = ruleWithSelector(".mode-toggle");
    expect(body).toMatch(/gap\s*:\s*0(?![.\d])/);
    const nonZero = [...body.matchAll(/(?:^|[;\s])(?:row-|column-)?gap\s*:\s*([^;]+)/g)]
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
  it("names all four grid lines", () => {
    expect(
      thumbBaseRule(),
      "#1384: for an ABSOLUTELY-POSITIONED grid child an `auto` end line resolves to the " +
        "container's padding edge, NOT to `span 1` — so a two-line `grid-area: 1 / 1` " +
        "silently stretches the thumb across the whole track. Write all four lines.",
    ).toMatch(/grid-area\s*:\s*1\s*\/\s*1\s*\/\s*2\s*\/\s*2/);
  });

  it("declares inset: 0", () => {
    expect(
      thumbBaseRule(),
      "#1384: without `inset`, the absolutely-positioned box shrink-to-fits its (empty) " +
        "contents and renders 0x0. The grid placement alone does not size it.",
    ).toMatch(/inset\s*:\s*0(?![.\d])/);
  });

  it("carries no percentage-derived sizing", () => {
    const offenders = rules()
      .filter((r) => r.selector === ".thumb")
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

  it("still paints the pill it exists to paint", () => {
    // Guards every gate above from being "passed" by deleting the rule.
    const body = thumbBaseRule();
    expect(body).toMatch(/position\s*:\s*absolute/);
    expect(body).toMatch(/background\s*:/);
    expect(body).toMatch(/border-radius\s*:/);
    expect(body).toMatch(/box-shadow\s*:/);
    expect(body).toMatch(/pointer-events\s*:\s*none/);
  });
});

describe("the rationale that keeps this from being reintroduced", () => {
  it("still explains the padding-edge and inset traps in prose", () => {
    // The positive half of the comment-stripping rule at the top of this file.
    // Both traps fail silently and neither is inferable from the declarations,
    // so the comment is load-bearing documentation, not decoration — and it is
    // the thing a reader under time pressure deletes to make a grep go green.
    const comments = [...styleBlock().matchAll(/\/\*([\s\S]*?)\*\//g)]
      .map((m) => m[1])
      .join("\n")
      .replace(/\s+/g, " ")
      .toLowerCase();
    expect(comments, "the `.thumb` rationale must name the padding-edge trap").toMatch(
      /padding edge/,
    );
    expect(comments, "the `.thumb` rationale must name the 0x0 shrink-to-fit trap").toMatch(
      /inset: 0/,
    );
    expect(comments, "the `.mode-toggle` rationale must warn off `minmax(0, 1fr)`").toMatch(
      /minmax\(0, 1fr\)/,
    );
  });
});
