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
`.dataset.testid\s*=` followed by a quoted string literal (both live sites are plain string
literals; a `{expr}`-style JS assignment isn't syntactically valid here, so `parseValue`'s brace
branch isn't needed — reuse only its quote-handling half, or a small dedicated literal parser).
Push matches into the same `declarations` array with the same `{file, testid, raw}` shape so they
flow through the existing `normalise` → dedupe → `sortedSet` → `toMatchFileSnapshot` pipeline
unchanged. Skip (push to `skipped`, same as today) a `.dataset.testid =` whose value isn't a
simple quoted literal, so a future dynamic assignment fails legible rather than silently.

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

## Done when

Scanner fix + regenerated snapshot land in one commit; `heading-chevron` and `slash-command-menu`
both appear in `__snapshots__/testid-set.snap.txt`; the mutation test in step 2 above is run once
by hand during implementation and its red result recorded in the PR body; `npm run typecheck` and
`npm test` green.

## Not in scope

Converting the two imperative sites to real `data-testid` attributes (the issue's Option 2) —
Option 1 (widen the scanner) is the more complete fix per the issue body, closing the class rather
than the two instances, and is smaller (one file changed vs. two DOM-construction call sites
rewritten). A future third `dataset.testid` site needs no code change to be covered. No new
drift-guard, CI job, or frozen list — the existing snapshot mechanism is the guard; this fix only
widens what it can see.
