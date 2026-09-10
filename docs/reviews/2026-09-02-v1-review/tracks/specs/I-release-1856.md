# I-release — #1856 stale `azure/login@v2` comments in `tauri-release.yml` after the v3 bump

Branch `fix/release-and-ci-hygiene-1856`. **Closes #1856.** Ledger:
`docs/reviews/2026-09-02-v1-review/areas/ci-build.md` (this one arrived from #1835's Dependabot
bump, not from the review sweep — it has no ledger row of its own; its track home is
`tracks/I-supply-chain.md`). Probe: `grep -n 'azure/login' .github/workflows/tauri-release.yml`.

## Problem

Dependabot bumped `azure/login` from 2.3.0 to 3.0.2 in `2cbacf4f`, changing exactly one line —
the SHA. Four comments still name v2. **The issue body is wrong about one of them and it is the
load-bearing one:** it says "Line 238 pin is now v3 (trailing comment updated by Dependabot)".
Measured on `origin/master` (fff8e312), line 238 reads

```
        uses: azure/login@7ddb5af1ef8758cf1353cf3b42f940aee27ba21c # v2
```

— a v3.0.2 SHA behind a `# v2` comment. So the human-readable half of the pin actively lies, and
`tests/scripts/workflow-action-pin.test.ts:222-236` cannot see it: that assertion is documented as
presence-not-truth (`/@[0-9a-f]{40}\s+#\s*\S/`), deliberately, because a stricter regex breaks on
this repo's own `# stable` rust-toolchain pin.

**Root cause, and it is why this will recur if only the prose is fixed.** `azure/login` is the
only pin in the repo carrying a bare major (`# v2`); every other one carries a full `vX.Y.Z`
(`# v7.0.1`, `# v9.0.0`, `# v2.9.2`, `# v1.0.213`), and Dependabot rewrote all of those in place
(`e783e3af` moved `# v6.5.0` → `# v7.0.0`). Dependabot matches and rewrites the *version string*
it wrote; a hand-written major it never wrote is not a pattern it updates. The bare major is the
defect, not just the digit.

## Fix

`.github/workflows/tauri-release.yml`, comments only — no `uses:`, `run:`, `env:` or `with:` value
changes anywhere in the file.

- **`:238` trailing pin comment `# v2` → `# v3.0.2`.** This is the fix that stops the recurrence:
  a full version is the shape Dependabot maintains. Do not drop this comment —
  `workflow-action-pin.test.ts` requires a trailing comment on every pinned ref.
- **`:125`, `:224`, `:280` — drop the version qualifier**, since these are prose about the action's
  behaviour and the version is irrelevant to what they say: `azure/login@v2` → `azure/login`.
- **`:239-241`** (inside the same step, the "Deliberately NOT re-resolved to current v2
  (7184910… as of 2026-09-02)" note): read this block at implementation time and re-state it
  against the version actually pinned. That SHA-and-date sentence was written when the pin was
  2.3.0 and has been false since `2cbacf4f`. Correct it or delete it; do not leave it naming v2.
  **Keep the `Audited <date>` line and update the date** — it is the record that a human looked.

Rules that bite: this file runs only on `push: tags: ["v*"]`, so nothing here is exercised by any
PR-time check. The change is comments-only precisely so that "the YAML still parses" is the whole
claim being made — state it that way in the PR body, never under a Verification heading that
implies a run.

## Tests

**None, and the absence is the decision.** The natural guard — assert the trailing comment's
version matches the SHA's tag — cannot be written offline (the SHA-to-tag mapping lives on
GitHub), and asserting `# v` *shape* would go red on `dtolnay/rust-toolchain@… # stable`, which
`workflow-action-pin.test.ts:222-236` already rejected with a written reason. What replaces a test
here is the root-cause fix: with `# v3.0.2` in place, the next bump updates the comment itself.

Discriminating check for the implementer (a command, not a spec): after the edit,
`grep -c 'azure/login@v2\|# v2$' .github/workflows/tauri-release.yml` returns 0, and
`npx vitest run tests/scripts/workflow-action-pin.test.ts` stays green (it must — nothing it
asserts changes).

## Done when

Four comment sites corrected; the pin's trailing comment is a full `vX.Y.Z`; `grep azure/login`
shows no `v2` anywhere in the file; `workflow-action-pin.test.ts` green; the PR body records that
#1856's body was wrong about line 238 and why.

## Not in scope

Re-resolving the `azure/login` pin to a newer SHA (the step's own comment explains why it moves
only via a reviewed Dependabot bump). Any other stale comment in the file. Widening
`workflow-action-pin.test.ts`'s version-comment assertion.
