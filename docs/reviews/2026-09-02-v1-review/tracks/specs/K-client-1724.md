# K-client — #1724 Forced-colors type reveal: "Suggested replacement" unmeasured

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1724. Probe:
`tests/e2e/forced-colors.spec.ts` gains a suggestion-card variant of its existing
`headerClipped`/`authorClipped`/`authorWidth` assertions.

## Problem

`tests/e2e/forced-colors.spec.ts:442-448` names the gap directly: the existing "annotation type
survives forcing" test measures only "Private note" (12 chars) against `.ach-row`/`.ach-type`'s
`flex-wrap`/`row-gap` fix (`AnnotationCardHeader.svelte`, `@media (forced-colors: active)`,
`:307-317`). "Suggested replacement" (21 chars) is the longest label in
`ANNOTATION_TYPE_GLYPHS` and is unmeasured. The wrap fix should generalize — wrapping doesn't
care how wide the badge is — but that's a hypothesis; #1724 exists to confirm it with a real
measurement, not to add a second fix pre-emptively. Both CSS declarations already target
`.ach-row, .ach-type` together, so "only one wraps" cannot occur on current master.

## Fix

No CSS change — this is a coverage gap, not a known defect. If the new test fails, widen the
existing `flex-wrap`/`row-gap` rule (no new selector) and record it as a finding in the PR body.

`tests/e2e/forced-colors.spec.ts`: add a test alongside the short-label one, reusing this file's
own MCP fixture wiring (`beforeEach`/`afterEach`, `mcp.callTool`, `sample.md` via
`createFixtureDir`):

```ts
test("the longest type label survives forcing without clipping the header", async ({ page }) => {
  await mcp.callTool("tandem_comment", {
    from: 2, to: 15, text: "forced-colors longest-label check",
    textSnapshot: "Test Document", suggestedText: "Test Doc",
  });
  await boot(page);
  await switchToAnnotationsTab(page); // import from helpers.ts
  // locate .annotation-type-badge, assert wordText contains "suggested replacement",
  // then the same headerClipped/authorClipped/authorWidth measurement as the short-label test.
});
```

`[2, 15)` mirrors `margin-view.spec.ts`'s constants for the same `sample.md` fixture
(`# Test Document`, `:1`) and its interior holds no heading-prefix character by direct
inspection of the fixture text. Passing `suggestedText` routes this through the SUGGESTION arm
(Critical Rule 6: `rejectHeadingInterior`), a stricter check `margin-view.spec.ts`'s plain
comment on the same range never exercises. `switchToAnnotationsTab` is required here (unlike the
short-label test, which reaches the card incidentally via the popup-UI flow).

## Tests

The new E2E test is the discriminating test. Mutation-test by reverting `flex-wrap` alone (the
load-bearing half per the file's own docblock, not `row-gap`) in the forced-colors media query
and confirming the new test goes red **by itself** — the 12-char short-label test may not be
wide enough to prove the fix generalizes to 21 chars.

## Done when

The new test passes against current master's CSS (confirming generalization) OR the
`flex-wrap`/`row-gap` rule is widened until it passes, with the finding recorded in the PR body;
`npm run test:e2e` green; the mutation-test result recorded once by hand.

## Not in scope

Shortening `ANNOTATION_TYPE_GLYPHS` labels (already rejected — the label is the accessible
name). Changing `.ach-badge`'s `flex-shrink: 0` (already rejected — would truncate the only
surviving type carrier).

## Review corrections (scope cut)

No blocking findings remain against this spec. Condensed the prior round's line-by-line
justification for the range's heading-safety and the mutation-target precision into direct
statements. No mechanism removed — the coverage-gap framing (no pre-emptive CSS change) and the
mutation test against `flex-wrap` alone are both load-bearing per the issue's own premise.
