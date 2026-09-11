# K-client — #1724 Forced-colors type reveal: "Suggested replacement" unmeasured

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1724. No area-ledger row
(filed standalone, out of the #1723 review). Probe: `tests/e2e/forced-colors.spec.ts` gains a
suggestion-card variant of its existing `headerClipped`/`authorClipped`/`authorWidth` assertions.

## Problem

`tests/e2e/forced-colors.spec.ts:442-448` names this gap explicitly in a comment: the existing
"annotation type survives forcing" test measures only the SHORT label ("Private note", 12 chars)
against `.ach-row`'s `flex-wrap`/`row-gap` fix (`AnnotationCardHeader.svelte`, inside the
`@media (forced-colors: active)` block). "Suggested replacement" (21 chars, ~75% wider) is the
longest label in `ANNOTATION_TYPE_GLYPHS` (`annotation-type-icon.ts`) and is still unmeasured. The
wrap fix should generalize — wrapping doesn't care how wide the badge is, only that the badge
itself fits one line — but that is Option 2 in the issue body (measure without E2E) is a weaker
substitute for Option 1 (render a real suggestion card and run the same three assertions), which
the test file's own comment already prefers ("Seeding a suggestion... needs the MCP document-open
sequence the other specs do").

## Fix

No CSS change — this issue is a coverage gap, not a known defect (the reviewer's own hypothesis is
that the existing fix already generalizes; #1724 exists to confirm it, not to add a second fix).
If the new test fails, the smallest correction is widening the `@media (forced-colors: active)`
block's `flex-wrap`/`row-gap` rule already in `AnnotationCardHeader.svelte` (no new selector, no
new mechanism) — record that as a finding in the PR body rather than pre-emptively touching CSS
the measurement hasn't shown broken yet.

`tests/e2e/forced-colors.spec.ts`: add a new test alongside "the annotation type survives forcing
as a word, not just an icon", using the MCP document-open sequence already wired into this file's
own `beforeEach`/`afterEach` (`mcp: McpTestClient`, `tandem_open` on `sample.md` — no new fixture
or client setup needed, contrary to the test comment's earlier read that this "needs" new
scaffolding; the scaffolding already exists in this file, just unused for a suggestion):

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
  // ...locate `.annotation-type-badge`, assert `wordText` contains
  // "suggested replacement", then the same headerClipped/authorClipped/
  // authorWidth measurement as the existing test.
});
```

`TITLE_FROM`/`TITLE_TO`/`TITLE_TEXT` mirror `tests/e2e/margin-view.spec.ts`'s constants for the
same shared `sample.md` fixture (`from: 2, to: 15, text: "Test Document"`) — define them locally in
`forced-colors.spec.ts` (or hoist to `helpers.ts` if a third spec wants them; not required by this
fix). Comment on the shared range must land in `text` content only, not the heading markup prefix
(Critical Rule 6) — offset 2 already clears a `"# "` prefix, which the pre-existing
`margin-view.spec.ts` comment on the identical range confirms works today.

## Tests

The new E2E test IS the test — this is a coverage-gap issue, so there is no separate
"discriminating unit test" beyond it. It discriminates two ways at once:
1. Against a regressed CSS fix: reverting the `flex-wrap`/`row-gap` block in
   `AnnotationCardHeader.svelte`'s forced-colors media query must turn `headerClipped` true here,
   exactly as it already does for the short-label test (mutation-test both together — revert once,
   confirm both new and existing tests go red, restore from a file copy).
2. Against a badge-specific overflow the short label can't reach: if the wrap fix generalizes
   incompletely (e.g. only `.ach-row` wraps but `.ach-type` itself doesn't, so the word wraps mid
   -label), `wordWidth`/`wordHeight` or the header measurement will show it — this is exactly the
   "could still force `.ach-type` itself to wrap internally" risk the issue names.

## Done when

The new test passes against current master's CSS (confirming the wrap fix generalizes) OR, if it
fails, the `flex-wrap`/`row-gap` rule is widened until it passes and the finding is recorded in the
PR body; `npm run test:e2e` green; the mutation-test in step 1 above run once by hand and its red
result recorded.

## Not in scope

Any change to `ANNOTATION_TYPE_GLYPHS` labels themselves (shortening them was already rejected in
the issue body — the label is the accessible name). No change to `.ach-badge`'s `flex-shrink: 0`
(shrinking the badge was already rejected — it would truncate the only type carrier that survives
forcing).
