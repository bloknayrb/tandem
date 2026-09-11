# K-client — #1709 Critical Rule 7 cannot see two live testids set via `dataset.testid`

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1709. No area-ledger row
(filed standalone, not part of the #1824 v1-review batch). Probe: `grep -c "dataset.testid ="
src/client` should be 0, or every hit also appears in `__snapshots__/testid-set.snap.txt` — the
issue's own review criterion.

## Problem

`tests/design-system-impl/testid-coverage.test.ts` scans `src/client/` for the literal string
`data-testid=` (`ATTR = "data-testid="`, `:117`) and snapshots the normalised set. Two live
selectors are assigned imperatively as a JS property and are invisible to that scan:

- `src/client/editor/slash-menu/extension.ts:367` — `menu.dataset.testid = "slash-command-menu";`
- `src/client/editor/extensions/heading-collapse.ts:315` — `btn.dataset.testid = "heading-chevron";`

Verified on current master: both are absent from `__snapshots__/testid-set.snap.txt` (`grep -c
slash-command-menu` / `grep -c heading-chevron` both return 0), and a repo-wide
`grep -rn "dataset\.testid\s*=" src/client/` returns exactly these two lines — no others exist
today, but the scanner's blind spot is the class of bug, not the count. `heading-chevron` alone
backs seven Playwright locators in `tests/e2e/heading-collapse.spec.ts`; renaming or removing
either selector today breaks its callers with nothing in the snapshot gate going red first — the
exact failure Critical Rule 7 exists to prevent.

## Fix

`tests/design-system-impl/testid-coverage.test.ts`: add a second scan pass, run after the existing
`ATTR = "data-testid="` loop over the same `walk(CLIENT_ROOT)` file list, matching
`/\.dataset\.testid\s*=(?!=)/g` — the negative lookahead excludes `===`/`!==` comparisons, which
would otherwise be misread as an assignment (no such comparison exists in `src/client/` today, but
`tests/client/ActivityTray.svelte.test.ts:60` and `tests/e2e/settings-and-filters.spec.ts:987`
show the shape occurs in test code, so the guard is cheap insurance against a future `src/client/`
site).

After a match, skip leading whitespace and parse the value:
- Both live sites are plain quoted string literals (`"slash-command-menu"`,
  `"heading-chevron"`) — reuse `parseValue`'s quote-handling branch only (its `{expr}` brace
  branch isn't reachable here: `el.dataset.testid = {...}` isn't valid JS, so a bare identifier or
  a template literal are the only other shapes a real site could take).
- **Mirror the existing attribute pass's asymmetry, not its own new one.** The attribute loop
  already treats a bare identifier (`{testId}`) as a wrapper passthrough and silently
  `continue`s — it does not land in `declarations` OR `skipped`. Do the same here: a bare
  identifier value (`el.dataset.testid = someVar;`) is a wrapper reading a testid computed
  elsewhere, so `continue` past it. Only a value that is neither a quoted literal nor a bare
  identifier (multi-line, or some other unparseable expression) goes to `skipped`. Getting this
  backwards — routing every non-literal dataset assignment to `skipped` — would turn a future
  legitimate `el.dataset.testid = someVar` into a permanent, unfixable red on the "no testid
  declarations were skipped" assertion (see Review corrections below).
- Push a quoted-literal match into the same `declarations` array with the same
  `{file, testid, raw}` shape so it flows through the existing `normalise` → dedupe →
  `sortedSet` → `toMatchFileSnapshot` pipeline unchanged.

Regenerate `tests/design-system-impl/__snapshots__/testid-set.snap.txt` in the same commit
(`vitest -u` on this file only) — this is the one sanctioned regeneration in this group per
Critical Rule 7 (adding, not renaming or removing, a tracked selector). The snapshot gains
`heading-chevron` and `slash-command-menu`; no existing entry changes.

No change to `docs/design-system-impl/testid-manifest.md` is required by the fix itself, but since
this group is already touching the snapshot, add the two new selectors there too for the
human-readable copy (CLAUDE.md: "a convenience copy no test reads, so it drifts silently" — adding
them costs one line each and keeps the drift from starting on day one).

## Tests

1. `testid-coverage.test.ts`'s own "matches the committed selector snapshot" assertion is the
   discriminating test: it fails today (before the fix) because the fix's snapshot regeneration
   introduces two lines not yet in `declarations`, and the snapshot only matches once the scanner
   fix + regeneration land together in one commit.
2. Mutation test (required by the wave-5-lesson rule): after landing, revert ONLY the new
   `.dataset.testid` scan loop (keep the regenerated snapshot) and re-run
   `npx vitest run tests/design-system-impl/testid-coverage.test.ts` — the "matches the committed
   selector snapshot" assertion must go red (the snapshot now contains two entries the reverted
   scanner never produces). Restore the scan loop from a file copy, not `git checkout`.
3. No change needed to `tests/e2e/heading-collapse.spec.ts` — its seven locators already reference
   `[data-testid="heading-chevron"]`; they are what the fix makes visible to the contract, not
   something the fix has to touch.
4. New unit case: a synthetic source string containing
   `x.dataset.testid = someVar; y.dataset.testid === "not-an-assignment";` parsed through the
   new pass in isolation — assert the bare identifier produces neither a `declarations` nor a
   `skipped` entry, and the `===` comparison is not treated as an assignment at all (no entry
   either way). This is the regression net for the two asymmetry bugs the round-1 review found.

## Done when

Scanner fix + regenerated snapshot land in one commit; `heading-chevron` and `slash-command-menu`
both appear in `__snapshots__/testid-set.snap.txt`; the mutation test in step 2 above is run once
by hand during implementation and its red result recorded in the PR body; test 4 above passes;
`npm run typecheck` and `npm test` green.

## Not in scope

Converting the two imperative sites to real `data-testid` attributes (the issue's Option 2) —
Option 1 (widen the scanner) is the more complete fix per the issue body, closing the class of
`.dataset.testid = "literal"` assignments rather than the two instances, and is smaller (one file
changed vs. two DOM-construction call sites rewritten). A future third `dataset.testid` site with
a quoted-literal value needs no code change to be covered. Two sibling forms stay uncovered by
design, since neither has a current instance and both are outside this issue's named class:
`el.setAttribute("data-testid", "x")` (the scanner keys on the literal `data-testid=` substring,
which a `setAttribute` call never contains) and `el.dataset["testid"] = "x"` (bracket-property
form). No new drift-guard, CI job, or frozen list — the existing snapshot mechanism is the guard;
this fix only widens what it can see.

## Review corrections (round 1)

**Adopted:**
- Excluded `===`/`!==` from the match regex (`(?!=)` lookahead) — the originally-specified
  `\.dataset\.testid\s*=` would also match an equality comparison and misroute it to `skipped`,
  reddening the "no testid declarations were skipped" assertion with a confusing message.
- Made the new pass symmetric with the existing attribute pass: a bare-identifier value is a
  silent `continue` (wrapper passthrough), not a push to `skipped`. The original spec text routed
  every non-literal `.dataset.testid =` to `skipped`, which would make a future legitimate
  `el.dataset.testid = someVar` permanently red with no way to write it that passes.
- Added a new unit test (Tests item 4) pinning both asymmetry fixes directly, since the mutation
  test in item 2 only exercises the two literal sites and wouldn't catch either regression.
- Narrowed the "closes the class" claim in Not-in-scope: named the two sibling forms
  (`setAttribute("data-testid", ...)` and bracket-property `dataset["testid"]`) that remain
  uncovered, rather than implying full closure of every imperative-assignment shape.

**Not adopted:** none.
