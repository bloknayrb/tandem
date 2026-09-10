# I-release — #1748 four CI/release hygiene findings (RC auto-update, Test-before-Build, NPM_TOKEN, inert CodeQL config)

Branch `fix/release-and-ci-hygiene-1856`. **Closes #1748 — but only because all four findings are
resolved: 1, 2 and 4 in this PR, 3 already shipped in #1878.** If any of the four is dropped during
implementation, the PR body must move #1748 to `## Refs (partial — issue stays open)` naming which
remain. Ledger: `areas/ci-build.md` rows 5–8. Decision **G** (Bryan, 2026-09-06) governs item 1.

## Problem

Four independent findings, treated as four.

1. **An RC tag would auto-update every user.** `tauri-release.yml:116` sets `prerelease: false`
   unconditionally on the created draft; `.claude/skills/release/SKILL.md:171` publishes with
   `gh release edit … --draft=false --latest`; `src-tauri/tauri.conf.json:107-109` points the
   updater at `releases/latest/download/latest.json`. A `v1.0.0-rc.1` tag therefore becomes the
   update every desktop install pulls. #1825 bounds it: WiX rejects a non-numeric prerelease so the
   Windows MSI leg fails first — NSIS, macOS and Linux do not.
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

**Item 1 — derive `prerelease` from the tag, both halves (decision G).**
- `tauri-release.yml`, the `create-release` `github-script` body: `prerelease: false` becomes
  `prerelease: tag.includes('-')`. `tag` is already in scope at `:84`. One line. The `-` test, not
  a semver parse: the tag is already pinned equal to `v${tauri.conf.json.version}` by the step at
  `:69-78`, and any prerelease identifier there necessarily carries a hyphen.
- `.claude/skills/release/SKILL.md` step 7: split the publish command. For a tag with **no** `-`,
  unchanged (`--draft=false --latest`). For a tag **with** `-`, publish as
  `gh release edit v<version> --draft=false --prerelease --latest=false`, and say why in one
  sentence: GitHub's `releases/latest` resolves to the newest non-prerelease release, which is the
  only thing keeping the updater endpoint off an RC. **Do not pass `--latest` on a prerelease** —
  whether the API would honour or refuse it is untested here, and the skill must not depend on the
  answer. This is the internal release skill, **not** `skills/tandem/SKILL.md`, so no frontmatter
  `version` bump and no `tests/skill-instruction-contract.test.ts` edit.

**Item 2 — make the two dist-gated suites assert, after Build.** A shared env gate, not a
reordering: moving `Test` after `Build` would disturb the `Every collected test file actually ran`
anchor (`ci.yml:394-396`) and the acceptance-harness step, both pinned by exact equality in
`vitest-file-anchor-wiring.test.ts` and `acceptance-harness-wiring.test.ts`.
- Both spec files read `const REQUIRE = process.env.TANDEM_REQUIRE_BUILD_ARTIFACTS === "1";` and
  gate on `describe.skipIf(!REQUIRE && !existsSync(<bundle>))`. `build-artifact.test.ts` loses its
  two early `return`s — the *first* `it` in each file asserts the bundle exists, so a required run
  with no bundle fails on a named assertion rather than a `readFileSync` stack.
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

Two describes in the group's shared new `tests/scripts/release-ci-hygiene.test.ts` (ADR-051: both
targets are in workflows no required check reads, or in a step that can be `|| true`'d away):

1. **Item 1.** Parse `tauri-release.yml`, find the `create-release` job's `github-script` step
   (throw if absent), and assert its `with.script` contains `prerelease: tag.includes('-')` and
   **does not contain** `prerelease: false`. Both halves: the positive alone passes a body carrying
   both lines, the negative alone passes a body carrying neither. *Kills:* a revert to the constant,
   and a "tidy" that drops the field (which defaults to `false` at the API and silently restores
   the bug).
2. **Item 2.** Find the ci.yml step whose `run` names both spec paths (throw if absent); assert its
   `run` and `env` by **exact equality**; assert no `if:` and no `continue-on-error`; assert its
   index is **greater** than the `Build` step's. Separately, assert **both spec files** contain the
   literal `TANDEM_REQUIRE_BUILD_ARTIFACTS`. *Kills:* the step deleted, `|| true`'d, `if:`-gated, or
   moved above `Build`; and the gate removed from one spec file while the step still runs it green.

Item 3 needs no test — `publish.yml` holding no `NPM_TOKEN` is already implied by every OIDC
assertion in its own header, and inventing a "no secret named X" test is a mechanism the issue did
not ask for. Item 4 needs no test — a deleted inert file has nothing to regress into; re-adding it
would be as inert as it is now.

## Done when

All four accounted for; both describes green; `npm test` and `npm run typecheck:tests` green; the
new ci.yml step observed **failing** on a tree with no `dist/` (run it by hand with the env var and
`dist/` moved aside — if it passes, item 2's fix is vacuous and the whole finding is still live).

## Not in scope

Whether Tandem should publish RCs at all (Bryan's — decision G settled the mechanism, not the
policy). Changing the updater endpoint. The WiX/NSIS prerelease-string behaviour from #1825 —
informational, recorded in the PR body, no code. Enabling CodeQL advanced setup.
