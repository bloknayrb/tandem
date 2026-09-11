# K-client — #1724 Forced-colors type reveal: "Suggested replacement" unmeasured

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1724. No area-ledger row
(filed standalone, out of the #1723 review). Probe: `tests/e2e/forced-colors.spec.ts` gains a
suggestion-card variant of its existing `headerClipped`/`authorClipped`/`authorWidth` assertions.

## Problem

`tests/e2e/forced-colors.spec.ts:442-448` names this gap explicitly in a comment: the existing
"annotation type survives forcing" test measures only the SHORT label ("Private note", 12 chars)
against `.ach-row`/`.ach-type`'s `flex-wrap`/`row-gap` fix (`AnnotationCardHeader.svelte`, inside
the `@media (forced-colors: active)` block, `:307-317`). "Suggested replacement" (21 chars, ~75%
wider) is the longest label in `ANNOTATION_TYPE_GLYPHS` (`annotation-type-icon.ts`) and is still
unmeasured. The wrap fix should generalize — wrapping doesn't care how wide the badge is, only
that the badge itself fits one line — but that is a hypothesis: #1724 exists to confirm it with a
real measurement, not to add a second fix pre-emptively.

`AnnotationCardHeader.svelte:307-310`'s own docblock states the fix's two halves have different
weight: `flex-wrap` is load-bearing and pinned by the existing `headerClipped` assertion; `row-gap`
is "cosmetic... and is NOT pinned by anything." Both already apply to `.ach-row` **and** `.ach-type`
together (`:311-315`), so the failure mode "only `.ach-row` wraps but `.ach-type` doesn't" cannot
occur on current master — that risk is forward-looking (a future edit narrowing the selector back
to `.ach-row` alone), not a live gap this test discovers today.

## Fix

No CSS change — this issue is a coverage gap, not a known defect (the reviewer's own hypothesis is
that the existing fix already generalizes; #1724 exists to confirm it, not to add a second fix).
If the new test fails, the smallest correction is widening the `@media (forced-colors: active)`
block's `flex-wrap`/`row-gap` rule already in `AnnotationCardHeader.svelte` (no new selector, no
new mechanism) — record that as a finding in the PR body rather than pre-emptively touching CSS
the measurement hasn't shown broken yet.

`tests/e2e/forced-colors.spec.ts`: add a new test alongside "the annotation type survives forcing
as a word, not just an icon", using the MCP document-open sequence already wired into this file's
own `beforeEach`/`afterEach` (`mcp: McpTestClient`, `tandem_open` on `sample.md` via
`createFixtureDir`, `:66-72` — no new fixture or client setup needed, contrary to the test
comment's earlier read that this "needs" new scaffolding; the scaffolding already exists in this
file, just unused for a suggestion):

```ts
test("the longest type label survives forcing without clipping the header", async ({ page }) => {
  await mcp.callTool("tandem_comment", {
    from: TITLE_FROM,
    to: TITLE_TO,
    text: "forced-colors longest-label check",
    textSnapshot: TITLE_TEXT,
    suggestedText: "Test Doc",
  });
  await boot(page);
  await switchToAnnotationsTab(page);
  // ...locate `.annotation-type-badge`, assert `wordText` contains
  // "suggested replacement", then the same headerClipped/authorClipped/
  // authorWidth measurement as the existing test.
});
```

`TITLE_FROM`/`TITLE_TO`/`TITLE_TEXT` mirror `tests/e2e/margin-view.spec.ts`'s constants for the
same shared `sample.md` fixture (`from: 2, to: 15, text: "Test Document"`) — define them locally in
`forced-colors.spec.ts` (or hoist to `helpers.ts` if a third spec wants them; not required by this
fix). The range is heading-prefix-free by direct inspection of the fixture:
`tests/e2e/fixtures/sample.md:1` is `"# Test Document"`, so `[2, 15)` starts immediately after the
two-character `"# "` prefix and its interior holds none of it. This test also passes
`suggestedText`, which routes the range through the SUGGESTION arm (Critical Rule 6:
`YDocStore.anchorRange({purpose: "suggestion"})` and `rejectHeadingInterior`), not the endpoint-only
plain-comment arm — a stricter check the pre-existing `margin-view.spec.ts` comment on the same
range never exercises, since that comment carries no `suggestedText`. The range being clean is
established by inspecting the fixture text directly, not by that precedent.

Import `switchToAnnotationsTab` from `helpers.ts` (already used by
`tests/e2e/accessibility.spec.ts` and `tests/e2e/annotation-lifecycle.spec.ts`) and call it after
`boot(page)`, before locating `.annotation-type-badge` — the existing short-label test reaches the
card through the popup UI flow (`openAnnotatePopup` + `submitAnnotation`), which the new
MCP-seeded test doesn't go through, so nothing else opens the annotations panel for it.

## Tests

The new E2E test IS the test — this is a coverage-gap issue, so there is no separate
"discriminating unit test" beyond it. It discriminates two ways at once:
1. Against a regressed CSS fix: reverting the `flex-wrap` declaration (not `row-gap` — see below)
   in `AnnotationCardHeader.svelte`'s forced-colors media query must turn `headerClipped` true
   here on its own, independent of the existing short-label test. Mutation-test by reverting
   `flex-wrap` alone and confirming the NEW test goes red by itself (not just "both together",
   which the original draft of this spec understated) — the short-label test at 12 characters may
   not be wide enough to prove the fix generalizes to the 21-character label; the new test is the
   one required to fail here.
2. Against a badge-specific overflow the short label can't reach: if a future edit narrows the
   `flex-wrap`/`row-gap` selector back to `.ach-row` alone (dropping `.ach-type`), so the word
   wraps mid-label instead of the row wrapping around it, `wordWidth`/`wordHeight` or the header
   measurement will show it. This is a forward-looking regression guard, not a live gap on current
   master — both declarations already target `.ach-row, .ach-type` together today.

## Done when

The new test passes against current master's CSS (confirming the wrap fix generalizes) OR, if it
fails, the `flex-wrap`/`row-gap` rule is widened until it passes and the finding is recorded in the
PR body; `npm run test:e2e` green; the mutation-test in step 1 above (reverting `flex-wrap` alone
and confirming the new test specifically goes red) run once by hand and its red result recorded.

## Not in scope

Any change to `ANNOTATION_TYPE_GLYPHS` labels themselves (shortening them was already rejected in
the issue body — the label is the accessible name). No change to `.ach-badge`'s `flex-shrink: 0`
(shrinking the badge was already rejected — it would truncate the only type carrier that survives
forcing).

## Review corrections (round 1)

**Adopted:**
- Corrected the justification for the range's heading safety: the interior of `[2, 15)` holds no
  heading-prefix character by direct inspection of the fixture, not because
  `margin-view.spec.ts`'s comment on the same range "confirms it works" — that precedent uses a
  plain comment with no `suggestedText` and therefore takes the endpoint-only plain-comment arm,
  never the stricter suggestion arm (`rejectHeadingInterior`) this new test's `suggestedText`
  actually exercises.
- Added the missing `switchToAnnotationsTab(page)` call before locating `.annotation-type-badge` —
  the existing short-label test reaches the card via the popup UI flow, which incidentally
  surfaces the panel; the new MCP-seeded test has no such incidental step and would otherwise
  measure nothing or measure the wrong context.
- Restated discrimination claim 2 as the forward-looking regression guard it is (both CSS
  declarations already target `.ach-row, .ach-type` together on current master, so the "only one
  wraps" scenario cannot occur today) rather than an active gap.
- Specified the mutation target precisely: revert `flex-wrap` alone (the load-bearing half per
  the file's own docblock), and require the new test to go red on its own, not only in
  combination with the existing short-label test.

**Not adopted:** none.
