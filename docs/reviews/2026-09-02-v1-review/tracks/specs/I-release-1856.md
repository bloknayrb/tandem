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
  **Verify the version before writing it, and this is a required step, not a nicety.**
  `CONTRIBUTING.md:250-260` states that a 40-hex ref is *a shape, not an identity* — GitHub
  resolves `owner/repo@<sha>` against the whole fork network and **no check in CI can detect
  that** — so for each bumped action a human must confirm the SHA is reachable in the *upstream*
  repo and is what the trailing comment claims. Dependabot's own commit metadata (`2cbacf4f`) is
  the artefact CONTRIBUTING says to check **against**, not with, so it is not sufficient basis for
  writing `# v3.0.2`. Run:

  ```bash
  gh api repos/Azure/login/git/ref/tags/v3.0.2 --jq '.object.sha,.object.type'
  # if .object.type is "tag" (annotated), dereference it:
  gh api repos/Azure/login/git/tags/<that sha> --jq .object.sha
  ```

  and confirm the final SHA equals `7ddb5af1ef8758cf1353cf3b42f940aee27ba21c`. **Paste that
  command and its output into the PR body.** If it does not match, stop and report — do not write
  a version comment the check contradicts.
- **`:125`, `:224`, `:280` — drop the version qualifier**, since these are prose about the action's
  behaviour and the version is irrelevant to what they say: `azure/login@v2` → `azure/login`.
- **`:228-237`** — the ten-line `# Deliberately NOT re-resolved…` block that sits **above** the
  `uses:` line, not below it. (Measured on `origin/master` fff8e312: the block runs `:228`
  `# Deliberately NOT re-resolved to current v2 (7184910... as of` through `:237`
  `# Audited 2026-09-02.`. **Lines `:239-241` are `with:` / `client-id:` / `tenant-id:` — the OIDC
  binding this step's own comment calls "the highest-privilege step here". They are `with:` values
  and this spec forbids touching them; leave `:238-241` byte-identical.**)

  Two facts in that block are now false and the rewrite is bounded to exactly those two — this is
  not an invitation to re-argue the pinning policy:

  1. *"current v2 (7184910… as of 2026-09-02)"* names the v2 branch tip the pin was being held
     back **from**. The pin no longer sits on the v2 line at all, so the sentence compares against
     the wrong lineage.
  2. *"a stale pin at a SHA that has been audited and in service since 2026-05-15"* was true of
     `a457da9e` (2.3.0). It is false of `7ddb5af1` (3.0.2), which landed on 2026-09-03 in
     `2cbacf4f` — **after** the audit stamp below it.

  Either re-state the rationale against v3.0.2 (the argument still holds: hold this SHA, upgrade
  only by reviewed Dependabot bump) or delete those two sentences. Do not leave the block naming
  v2.
- **The `Audited <date>` line at `:237`.** Update it to today **only if** the `gh api` check above
  was actually run — the stamp's entire meaning is that a human looked, and writing today's date
  without looking is the drift this bullet exists to catch. **If the check was not run, leave
  `2026-09-02` untouched and add one sentence to the block saying the pin post-dates the audit.**
  Note that this is already the situation on master: the stamp reads `2026-09-02` while the SHA it
  stamps arrived `2026-09-03`.

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
**No experiment in `docs/reviews/2026-09-02-v1-review/experiments/` covers this issue; there is no
still-broken-when output to convert into an assertion.**

Discriminating check for the implementer (a command, not a spec): after the edit,
`grep -c 'azure/login@v2\|# v2$' .github/workflows/tauri-release.yml` returns 0, and
`npx vitest run tests/scripts/workflow-action-pin.test.ts` stays green (it must — nothing it
asserts changes).

## Done when

Four comment sites corrected; the pin's trailing comment is a full `vX.Y.Z`; the `gh api`
tag-to-SHA check run and its output in the PR body; the `Audited` date advanced **only** on the
strength of that run (otherwise left at `2026-09-02` with the post-dating stated in the block);
`:238-241` byte-identical; `grep azure/login` shows no `v2` anywhere in the file;
`workflow-action-pin.test.ts` green; the PR body records that #1856's body was wrong about line
238 and why, and that the note block is at `:228-237` rather than where the issue implies.

## Not in scope

Re-resolving the `azure/login` pin to a newer SHA (the step's own comment explains why it moves
only via a reviewed Dependabot bump). Any other stale comment in the file. Widening
`workflow-action-pin.test.ts`'s version-comment assertion.

## Review corrections (round 1)

**Adopted.**

- **The `:239-241` edit instruction pointed at the wrong lines, and at lines the spec itself
  forbids touching.** The `# Deliberately NOT re-resolved…` note is at `:228-237`, above the
  `uses:`; `:239-241` are the `with:` / `client-id:` / `tenant-id:` OIDC binding. Bullet replaced,
  with the two specific false facts named so the rewrite is bounded, and an explicit instruction to
  leave `:238-241` byte-identical.
- **Writing `# v3.0.2` and refreshing `Audited <date>` were two unverified provenance claims with
  no verification step and, by the spec's own decision, no test.** Added the `gh api
  repos/Azure/login/git/ref/tags/v3.0.2` check (with the annotated-tag dereference) as a required
  step whose output goes in the PR body, and made the `Audited` stamp conditional on it having been
  run — otherwise the date stays `2026-09-02` and the block says the pin post-dates the audit. This
  is CONTRIBUTING.md:250-260's stated rule; Dependabot's own commit metadata is the artefact to
  check against, not with.
- **No experiment covers this issue** — stated in `## Tests` so the ship stage does not have to
  re-derive "no experiment existed" from "the experiment's output was dropped".

**Not adopted.** None.

**File set:** unchanged (`.github/workflows/tauri-release.yml`, comments only). The added `gh api`
check touches no tracked file.
