# I-release — #1748 four CI/release hygiene findings (RC auto-update, Test-before-Build, NPM_TOKEN, inert CodeQL config)

Branch `fix/release-and-ci-hygiene-1856`. **Closes #1748 — but only because all four findings are
resolved: 1, 2 and 4 in this PR, 3 already shipped in #1878.** If any of the four is dropped during
implementation, the PR body must move #1748 to `## Refs (partial — issue stays open)` naming which
remain. Ledger: `areas/ci-build.md` rows 5–8. Decision **G** (Bryan, 2026-09-06) governs item 1.

## Problem

Four independent findings, treated as four.

1. **An RC tag would auto-update every user — on BOTH distribution channels.**
   - *Desktop.* `tauri-release.yml:116` sets `prerelease: false` unconditionally on the created
     draft; `.claude/skills/release/SKILL.md:171` publishes with
     `gh release edit … --draft=false --latest`; `src-tauri/tauri.conf.json:107-109` points the
     updater at `releases/latest/download/latest.json`. A `v1.0.0-rc.1` tag therefore becomes the
     update every desktop install pulls. #1825 bounds it: WiX rejects a non-numeric prerelease so
     the Windows MSI leg fails first — NSIS, macOS and Linux do not.
   - *npm.* **This half is not in the issue body and is the one the fix would otherwise create.**
     `publish.yml:20-22` triggers on `release: types: [published]`, which fires for a prerelease
     exactly as for a release; its tag/`package.json` equality check (`:100-111`) passes for
     `v1.0.0-rc.1`; and its last step (`:121`) is `npm publish --provenance --access public` with
     **no `--tag`**, so npm stamps the `latest` dist-tag and every `npm i -g tandem` — a shipped
     channel — gets the RC. Teaching the release skill to publish an RC release is precisely the
     event that fires `publish.yml`, so fixing only the desktop half reproduces the finding's
     user-visible effect through the other channel.
2. **Test runs before Build.** `ci.yml:374` (`Test`) precedes `:431` (`Build`).
   `tests/build/version-baked.test.ts:21` is `describe.skipIf(!existsSync(bundlePath))` and skips
   every CI run. `tests/monitor/build-artifact.test.ts` is worse than skipped: both its `it`s
   `return` early when the bundle is absent, so they **pass with zero assertions** and are counted
   as passing tests in the summary and by `vitest-file-anchor.mjs`.
3. **`NPM_TOKEN` expiry.** **Already resolved, verified on `origin/master` fff8e312**:
   `publish.yml` has no `NPM_TOKEN`; its header comment documents npm Trusted Publishing (OIDC) and
   the v0.25.0 failure that forced it. Bryan's own 2026-09-06 comment records it as closed by
   #1878. No code change here; the PR body states this and cites the file, not the comment.
4. **CodeQL config is inert.** `.github/codeql/codeql-config.yml` holds one `paths-ignore` entry.
   Measured 2026-09-10: `code-scanning/default-setup` is `{"state":"configured"}`, there is no
   CodeQL workflow in `.github/workflows/`, and `repos/bloknayrb/tandem/properties/values` **404s**
   — custom properties are an organization feature and this is a user-owned repo, so the
   `github-codeql-config-file` route the issue offers is **not available**, not merely unset. There
   are also **zero open alerts** on `rename-recovery.ts` (10 open alerts total, none in that file),
   so the `paths-ignore` suppresses nothing today.

## Fix

**Item 1 — derive `prerelease` from the tag, all three halves (decision G).**
- `tauri-release.yml`, the `create-release` `github-script` body: `prerelease: false` becomes
  `prerelease: tag.includes('-')`. `tag` is already in scope at `:84`. One line. The `-` test, not
  a semver parse: the tag is already pinned equal to `v${tauri.conf.json.version}` by the step at
  `:69-78`, and any prerelease identifier there necessarily carries a hyphen.
- **Same script, the reuse branch (`:104-108`).** `create-release` reuses an existing draft
  (`if (existing.length === 1) { core.setOutput('release_id', …); return; }`) and only ever sets
  `prerelease` on the `createRelease` call, so a tag whose **first** run created the draft and then
  failed downstream comes back on re-run carrying whatever `prerelease` that first run wrote — and
  re-runs are the normal case for a four-platform signed build. Add, before the `return`:
  `await github.rest.repos.updateRelease({ owner, repo, release_id: existing[0].id, prerelease: tag.includes('-') })`,
  so a re-run converges rather than inheriting.
- `.claude/skills/release/SKILL.md` step 7: split the publish command. For a tag with **no** `-`,
  unchanged (`--draft=false --latest`). For a tag **with** `-`, publish as
  `gh release edit v<version> --draft=false --prerelease --latest=false`, and say why in one
  sentence: GitHub's `releases/latest` resolves to the newest non-prerelease release, which is the
  only thing keeping the updater endpoint off an RC. **Do not pass `--latest` on a prerelease** —
  whether the API would honour or refuse it is untested here, and the skill must not depend on the
  answer. This is the internal release skill, **not** `skills/tandem/SKILL.md`, so no frontmatter
  `version` bump and no `tests/skill-instruction-contract.test.ts` edit. **But it does get a pin —
  see test 3 below.** Nothing in the repo currently asserts this file's content
  (`grep -rn 'skills/release' tests/` returns one comment, `tauri-webdriver-pin.test.ts:157`), and
  it is the half that decides the outcome: the workflow only sets `prerelease` on the *draft*, and
  whether an RC then becomes the release the updater pulls is decided by the command a human copies
  out of step 7.
- **`publish.yml` — derive the npm dist-tag from the tag.** Add a step before the publish that
  computes it, and pass it explicitly:

  ```yaml
      - name: Derive npm dist-tag from the release tag
        env:
          TAG: ${{ inputs.tag || github.ref_name }}
        run: |
          set -euo pipefail
          case "$TAG" in
            *-*) echo "NPM_TAG=next" >> "$GITHUB_ENV" ;;
            *)   echo "NPM_TAG=latest" >> "$GITHUB_ENV" ;;
          esac
      - run: npm publish --provenance --access public --tag "$NPM_TAG"
  ```

  `next` is the npm convention for a prerelease channel and is what `npm i -g tandem@next` reaches;
  `latest` is what a bare `npm i -g tandem` reaches and is npm's own default, so the non-prerelease
  path is unchanged in effect while becoming explicit. **The `-` test must match the desktop half's**
  — the same tag, the same rule, so the two channels cannot disagree about what a prerelease is.
  Whether Tandem publishes RCs *at all* remains Bryan's (Not in scope, below); this only ensures
  that if one is published it does not land on `latest`.

**Item 2 — make the two dist-gated suites assert, after Build.** A shared env gate, not a
reordering: moving `Test` after `Build` would disturb the `Every collected test file actually ran`
anchor (`ci.yml:394-396`) and the acceptance-harness step, both pinned by exact equality in
`vitest-file-anchor-wiring.test.ts` and `acceptance-harness-wiring.test.ts`.
- Both spec files read `const REQUIRE = process.env.TANDEM_REQUIRE_BUILD_ARTIFACTS === "1";` and
  gate on `describe.skipIf(!REQUIRE && !existsSync(<bundle>))`. `build-artifact.test.ts` loses its
  two early `return`s (`:9-12`, `:17`); its first `it` already ends in
  `expect(statSync(MONITOR_DIST).size).toBeGreaterThan(1000)`, so removing the guard is enough
  there. **`version-baked.test.ts` needs the assertion added, and this is not implied by the
  sentence above:** its first `it` (`:22-27`) goes straight to `readFileSync(bundlePath)`, so a
  required run with no bundle dies on an ENOENT stack — the outcome this bullet exists to avoid.
  Add as its first line:
  ```ts
  expect(existsSync(bundlePath), "run `npm run build:server` first — TANDEM_REQUIRE_BUILD_ARTIFACTS=1 makes this required").toBe(true);
  ```
- `ci.yml`, a new step immediately **after** `Build`:
  `run: npm test -- --run tests/build/version-baked.test.ts tests/monitor/build-artifact.test.ts`
  with `env: TANDEM_REQUIRE_BUILD_ARTIFACTS: "1"`. It must sit after `Build` and after the
  file-anchor step (which consumes `.vitest-report.json` from the pre-Build run); the new step
  writes no JSON report, so it cannot clobber it.
- Local `npm test` and the pre-push hook are unchanged: without the env var the old skip-if-absent
  behaviour holds, so a developer with no `dist/` is not blocked.

**Item 3 — no change.** Verify and state.

**Item 4 — delete `.github/codeql/codeql-config.yml`** (and the now-empty `.github/codeql/`).
It is a file that implies coverage it cannot have, on a route this repo cannot take. Deleting it
changes no scan result — the zero-alerts measurement is what makes that a fact rather than a hope,
and it belongs in the PR body.

## Tests

Three describes in the group's shared new `tests/scripts/release-ci-hygiene.test.ts` (ADR-051: the
targets are in workflows no required check reads, in a step that can be `|| true`'d away, or in a
runbook file nothing asserts at all):

1. **Item 1, the workflow halves.** Parse `tauri-release.yml`, find the `create-release` job's
   `github-script` step (throw if absent), and assert its `with.script` contains
   `prerelease: tag.includes('-')` **at least twice** (the `createRelease` call and the reuse
   branch's `updateRelease`) and **does not contain** `prerelease: false`. Both halves: the positive
   alone passes a body carrying both lines, the negative alone passes a body carrying neither.
   Then parse `publish.yml`: find the step whose `run` contains `npm publish` (throw if absent),
   assert its `run.trim()` equals `npm publish --provenance --access public --tag "$NPM_TAG"`
   exactly, and assert **no** step in the file runs a bare `npm publish` without `--tag`. *Kills:*
   a revert to the constant; a "tidy" that drops the field (it defaults to `false` at the API and
   silently restores the bug); the re-run path inheriting the first run's flag; and the npm half
   left on `latest`.
2. **Item 2.** Find the ci.yml step whose `run` names both spec paths (throw if absent); assert its
   `run` and `env` by **exact equality**; assert no `if:` and no `continue-on-error`; assert its
   index is **greater** than the `Build` step's. Separately, assert **both spec files** contain the
   literal `TANDEM_REQUIRE_BUILD_ARTIFACTS`. **And pin the delegated half:** the step's body is
   `npm test -- --run …`, so `package.json`'s `scripts.test` is where a `|| true` would disarm it
   (and the existing `Test` step) with `ci.yml` byte-identical — the eighth-instance rule. Assert
   `JSON.parse(readFileSync("package.json")).scripts.test === "vitest"` with a comment naming it as
   the delegated half of the step body; this is the precedent `typecheck-tests-wiring.test.ts`
   already sets. *Kills:* the step deleted, `|| true`'d, `if:`-gated, or moved above `Build`; the
   gate removed from one spec file while the step still runs it green; and the npm script neutered
   underneath both.
3. **Item 1, the runbook half — `.claude/skills/release/SKILL.md`.** The workflow only flags the
   *draft*; step 7's publish command is what decides whether an RC becomes the release the updater
   pulls, and nothing in the repo reads that file today. Read it, **throw if the step-7 publish
   block is absent**, and assert it carries **both** branches: the no-hyphen line with
   `--draft=false --latest`, and a hyphen branch containing `--prerelease` and `--latest=false`.
   Then the negative, for the same reason test 1 carries one: **no line in that block passes
   `--latest` (as opposed to `--latest=false`) alongside `--prerelease`.** *Kills:* the runbook left
   telling the operator to pass `--latest` on an RC — which restores the exact bug with `check`
   green. Precedent for pinning skill prose: `tests/skill-instruction-contract.test.ts:257`.

Item 3 needs no test — `publish.yml` holding no `NPM_TOKEN` is already implied by every OIDC
assertion in its own header, and inventing a "no secret named X" test is a mechanism the issue did
not ask for. Item 4 needs no test — a deleted inert file has nothing to regress into; re-adding it
would be as inert as it is now.

**No experiment in `docs/reviews/2026-09-02-v1-review/experiments/` covers any of the four
findings**; there is no still-broken-when output to convert into an assertion.

## Done when

All four accounted for; **three** describes green; `npm test` and `npm run typecheck:tests` green.
Three hand-run checks, and each has a direction the spec previously left unobserved:

- The new ci.yml step observed **failing** on a tree with no `dist/` (run it by hand with the env
  var and `dist/` moved aside — if it passes, item 2's fix is vacuous and the whole finding is
  still live).
- The same command observed **GREEN** after a real `npm run build`, *before* the step is added to
  `ci.yml`. Neither spec file has ever asserted anything in CI — `build-artifact.test.ts`'s two
  `it`s both `return` early — so `expect(content).toContain("/api/events")` and `"/api/mode"`
  against a real `dist/monitor/index.js` are untested claims about tsup's output. If either fails,
  that is a finding to fix, not a reason to weaken this spec.
- The same command with **one spec path deliberately misspelled**, confirming it exits non-zero.
  `npm test -- --run <paths>` passes positional filters to a run spanning a `client` project
  (`vitest.config.ts:29`, `include: tests/client/**`) and a `node` project, and the client project
  matches zero files; whether vitest 4 treats that as fatal, and whether `passWithNoTests` lets a
  renamed spec path exit 0, decides whether this gate can go vacuous. If it exits 0, add
  `--passWithNoTests=false` to the step's `run` **and** to the exact-equality pin in test 2.

`Closes #1748` only if all four findings are resolved in code — item 1 now means the desktop
workflow, its re-run path, the release runbook **and** the npm dist-tag. If any is dropped, the PR
body moves #1748 to `## Refs (partial — issue stays open)` naming which remain.

## Not in scope

Whether Tandem should publish RCs at all (Bryan's — decision G settled the mechanism, not the
policy; the npm dist-tag change follows the same mechanism/policy split, so it belongs here and the
"publish RCs at all" question stays his). Changing the updater endpoint. The WiX/NSIS prerelease-string behaviour from #1825 —
informational, recorded in the PR body, no code. Enabling CodeQL advanced setup.

## Review corrections (round 1)

**Adopted.**

- **BLOCKING — item 1 left the npm distribution channel wide open under a `Closes #1748`.**
  Verified: `publish.yml:20-22` fires on `release: types: [published]` (a prerelease publishes the
  same way), `:100-111`'s tag check passes for `v1.0.0-rc.1`, and `:121` is
  `npm publish --provenance --access public` with **no `--tag`**, so npm stamps `latest`. The
  spec's own SKILL.md change is what makes that path live. Adopted fix (a): item 1 now extends to
  `publish.yml` with a `NPM_TAG` derived from the tag by the same `-` rule as the desktop half, and
  test 1 pins the publish `run` by exact equality plus a negative sweep for a bare `npm publish`.
  The `Closes` is retained on that basis, with the policy question ("publish RCs at all") left in
  Not-in-scope as Bryan's.
- **BLOCKING — item 1's outcome-deciding half was unpinned.** `.claude/skills/release/SKILL.md`
  step 7 (`:168-172`) is what the operator copies, and nothing in the repo reads that file
  (`grep -rn 'skills/release' tests/` → one comment). Added **describe 3**: throw if the step-7
  block is absent; assert both branches; assert no line pairs `--latest` with `--prerelease`.
  Done-when now names three describes.
- **The re-run path bypassed the fix.** `create-release`'s reuse branch (`:104-108`) returns before
  `createRelease`, so a re-run inherits the first run's `prerelease` — and re-runs are normal for a
  four-platform signed build. Added an `updateRelease` call in the reuse branch and an "at least
  twice" assertion in test 1.
- **`package.json`'s `scripts.test` is the delegated half of the new step's body** and nothing pins
  it, so `|| true` there disarms the step with `ci.yml` byte-identical. Added to describe 2.
- **`version-baked.test.ts`'s first `it` had no existence assertion** (`:22-27` goes straight to
  `readFileSync`), so a required run with no bundle dies on an ENOENT stack — the outcome the
  bullet claimed to avoid. The edit is now named explicitly for that file;
  `build-artifact.test.ts:13` already ends in a `statSync` assertion.
- **Only the failing direction of the new step was ever going to be observed.** Done-when now also
  requires a GREEN run after a real `npm run build` (neither spec file has ever asserted anything
  in CI, so `toContain("/api/events")` / `"/api/mode"` are untested claims about tsup's output),
  and a misspelled-path run confirming non-zero exit — with `--passWithNoTests=false` as the
  remedy if vitest 4's `projects` collection lets it exit 0.
- **No experiment covers any of the four findings** — stated in `## Tests`.

**Not adopted.** None.

**File set changed** — added: `.github/workflows/publish.yml` (dist-tag step + `--tag` on publish).
Already present: `.github/workflows/tauri-release.yml`, `.claude/skills/release/SKILL.md`,
`.github/workflows/ci.yml`, `tests/build/version-baked.test.ts`,
`tests/monitor/build-artifact.test.ts`, `.github/codeql/codeql-config.yml` (deleted), and the
shared `tests/scripts/release-ci-hygiene.test.ts`.
