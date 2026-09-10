# I-release — #1856 stale `azure/login@v2` comments in `tauri-release.yml` after the v3 bump

Branch `fix/release-and-ci-hygiene-1856`. **Closes #1856.** Track home: `tracks/I-supply-chain.md`
(this one arrived from #1835's Dependabot bump, so it has no `areas/ci-build.md` row).
Probe: `grep -n 'azure/login' .github/workflows/tauri-release.yml`.

## Problem

Dependabot bumped `azure/login` 2.3.0 → 3.0.2 in `2cbacf4f`, changing exactly one line — the SHA.
Four comments still say v2. **The issue body is wrong about the load-bearing one:** it claims
"line 238 pin is now v3 (trailing comment updated by Dependabot)". Measured on `origin/master`
(fff8e312), `:238` is `uses: azure/login@7ddb5af1ef8758cf1353cf3b42f940aee27ba21c # v2` — a v3.0.2
SHA behind a `# v2` comment, so the human-readable half of the pin lies.
`tests/scripts/workflow-action-pin.test.ts:222-236` cannot see it: that assertion is deliberately
presence-not-truth (`/@[0-9a-f]{40}\s+#\s*\S/`), because a stricter regex breaks on this repo's own
`# stable` rust-toolchain pin.

`azure/login` is also the only pin here carrying a bare major; every other one carries a full
`vX.Y.Z`, and Dependabot rewrites the version string it wrote. The bare major is why the comment
went stale, so the full version is part of the fix, not cosmetics.

## Fix

`.github/workflows/tauri-release.yml`, **comments only** — no `uses:`, `run:`, `env:` or `with:`
value changes anywhere in the file, and `:238-241` (the pin plus its OIDC `with:` block) stays
byte-identical apart from `:238`'s trailing comment.

- **`:238` trailing comment `# v2` → `# v3.0.2`.** Verify the version before writing it —
  `CONTRIBUTING.md:250-260` says a 40-hex ref is a shape, not an identity, and no CI check can
  detect a fork-network SHA, so Dependabot's own metadata is the thing to check *against*:

  ```bash
  gh api repos/Azure/login/git/ref/tags/v3.0.2 --jq '.object.sha,.object.type'
  # if .object.type is "tag" (annotated), dereference: gh api repos/Azure/login/git/tags/<sha> --jq .object.sha
  ```

  The final SHA must equal `7ddb5af1ef8758cf1353cf3b42f940aee27ba21c`. Paste the command and its
  output into the PR body. If it does not match, stop and report — do not write a version the check
  contradicts.
- **`:125`, `:224`, `:280` — drop the version qualifier** (`azure/login@v2` → `azure/login`). These
  are prose about the action's behaviour; the version is irrelevant to what they say.
- **`:228-237`, the `# Deliberately NOT re-resolved…` block above the `uses:` line.** Two facts in
  it are now false and the rewrite is bounded to exactly those two — this is not an invitation to
  re-argue the pinning policy: (1) "current v2 (7184910… as of 2026-09-02)" names the v2 branch tip
  the pin was held back *from*, and the pin no longer sits on that lineage; (2) "a stale pin at a
  SHA … in service since 2026-05-15" was true of `a457da9e` (2.3.0), not of `7ddb5af1` (3.0.2),
  which landed 2026-09-03 — after the audit stamp below it. Either restate the rationale against
  v3.0.2 (the argument holds: hold this SHA, upgrade only by reviewed Dependabot bump) or delete
  those two sentences.
- **The `Audited <date>` line at `:237`.** Advance it to today **only** on the strength of the
  `gh api` run above — the stamp's whole meaning is that a human looked. If the check was not run,
  leave `2026-09-02` and add one sentence saying the pin post-dates the audit (which is the state on
  master today).

This file runs only on `push: tags: ["v*"]`, so nothing here is exercised by any PR-time check. The
change is comments-only precisely so that "the YAML still parses" is the whole claim — state it that
way in the PR body, never under a Verification heading.

## Tests

**None, and the absence is the decision.** The natural guard — assert the trailing comment matches
the SHA's tag — cannot be written offline, and asserting `# v` shape goes red on
`dtolnay/rust-toolchain@… # stable`, which `workflow-action-pin.test.ts:222-236` already rejected
with a written reason. What replaces a test is the root-cause fix: with `# v3.0.2` in place the next
bump updates the comment itself. No experiment in
`docs/reviews/2026-09-02-v1-review/experiments/` covers this issue.

Discriminating check, one, stated once: `grep -n 'azure/login' .github/workflows/tauri-release.yml`
must show **four lines, none containing `v2`**, with `:238`'s trailing comment reading exactly
`# v3.0.2`. Paste that output into the PR body. `npx vitest run tests/scripts/workflow-action-pin.test.ts`
stays green — nothing it asserts changes.

## Done when

Four comment sites corrected; the pin carries a full `vX.Y.Z`; the `gh api` check run with its
output in the PR body; the `Audited` date advanced only on that basis; `:238-241` otherwise
byte-identical; the grep shows four `v2`-free lines; `workflow-action-pin.test.ts` green; the PR
body records that #1856's body was wrong about `:238`.

**Group commit shape, stated here because #1856 is the first commit.** Six issues land on one
branch, **one commit per issue in the brief's order** (#1856 → #1831 → #1832 → #1830 → #1748 →
#1825), each with its issue number in the subject, so a reviewer can read it commit-by-commit.

## Not in scope

Re-resolving the pin to a newer SHA. Any other stale comment in the file. Widening
`workflow-action-pin.test.ts`'s version-comment assertion.

## Review corrections (scope cut)

**Removed.** The round-1/round-2 correction logs (their adopted content is folded into the body
above); the root-cause essay on Dependabot's rewrite behaviour, compressed to two lines; the
duplicate/contradictory `grep -c` check, already superseded in round 2 and now stated once.

**Kept, with reasons.** The `gh api` tag-to-SHA check — it is a one-command provenance check
required by `CONTRIBUTING.md:250-260`, not a repo mechanism, and it is the only thing that makes
`# v3.0.2` a fact rather than a guess. The no-test decision is unchanged.

**File set:** `.github/workflows/tauri-release.yml`, comments only.
