# K-client — #1709 Critical Rule 7 cannot see two live testids set via `dataset.testid`

Branch `fix/client-lows-editor-ui-a11y-and-product-copy-1709`. Closes #1709. Probe: `grep -rn
"dataset\.testid\s*=" src/client/` finds `slash-command-menu` (`editor/slash-menu/extension.ts:367`)
and `heading-chevron` (`editor/extensions/heading-collapse.ts:315`) — both absent from
`__snapshots__/testid-set.snap.txt`, verified on current master.

## Problem

`tests/design-system-impl/testid-coverage.test.ts` scans for the literal `data-testid=` and
snapshots the set. A testid assigned via `el.dataset.testid = "..."` is invisible to that scan —
`heading-chevron` alone backs seven Playwright locators, and renaming/removing it today breaks
nothing in the snapshot gate first.

## Fix

`tests/design-system-impl/testid-coverage.test.ts`: add a second scan pass over the same file
list, matching `/\.dataset\.testid\s*=(?!=)/g` (the lookahead excludes `===`/`!==`). Parse the
value:
- A quoted literal → push to `declarations` with the same `{file, testid, raw}` shape as the
  existing attribute pass, flowing through the same normalise/dedupe/snapshot pipeline.
- A bare identifier (`el.dataset.testid = someVar`) → silent `continue`, mirroring the existing
  attribute pass's own wrapper-passthrough treatment. **This is load-bearing**: routing every
  non-literal assignment to `skipped` instead would make a future legitimate
  `el.dataset.testid = someVar` permanently, unfixably red.

Regenerate `__snapshots__/testid-set.snap.txt` in the same commit (`vitest -u` on this file
only) — the sanctioned regeneration under Critical Rule 7 (adding, not renaming/removing). Add
the two selectors to `docs/design-system-impl/testid-manifest.md` too, while already here.

## Tests

1. The snapshot-match assertion is the discriminating test: red before the fix (new lines not
   yet produced by the old scanner), green once scanner + regenerated snapshot land together.
2. Mutation test: revert only the new scan loop (keep the regenerated snapshot), confirm the
   snapshot-match assertion goes red; restore from a file copy, not `git checkout`.
3. New unit case: a synthetic source string `x.dataset.testid = someVar; y.dataset.testid ===
   "not-an-assignment";` — assert neither line produces a `declarations` or `skipped` entry.
   This pins both asymmetry fixes above.
4. No change needed to `tests/e2e/heading-collapse.spec.ts` — its locators already work; the fix
   only makes the contract see them.

## Done when

Scanner fix + regenerated snapshot in one commit; both selectors appear in the snapshot; test 2's
red result recorded once by hand in the PR body; `npm run typecheck` + `npm test` green.

## Not in scope

Converting the two imperative sites to real `data-testid` attributes (smaller, more complete fix
per the issue body: closes the whole `.dataset.testid = "literal"` class, not two instances).
`el.setAttribute("data-testid", ...)` and bracket-property `dataset["testid"]` stay uncovered by
design — no current instance, outside this issue's named class. No new drift-guard or CI job:
the existing snapshot mechanism is the guard, this only widens what it can see.

## Review corrections (scope cut)

No blocking findings were raised against this spec. Condensed the prior round's prose
(duplicated "why we changed our mind" narration for the `===`-exclusion lookahead and the
bare-identifier asymmetry fix) into the Fix section directly, since both are now stated as the
one correct mechanism rather than narrated as a correction. No mechanism removed — the scanner
change, mutation test, and asymmetry unit test are all load-bearing per the issue's own review
criterion and stay.
