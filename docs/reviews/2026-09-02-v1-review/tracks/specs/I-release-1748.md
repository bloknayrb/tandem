# I-release — #1748 four CI/release hygiene findings (RC auto-update, Test-before-Build, NPM_TOKEN, inert CodeQL config)

Branch `fix/release-and-ci-hygiene-1856`. **Closes #1748 — only because all four findings are
resolved: 1, 2 and 4 here, 3 already shipped in #1878.** If any is dropped, the PR body moves #1748
to `## Refs (partial — issue stays open)` naming which remain. Ledger: `areas/ci-build.md` rows 5–8.
Decision **G** (Bryan, 2026-09-06) governs item 1.

## Problem — four findings, treated as four

1. **An RC tag would auto-update every user, on BOTH channels.** *Desktop:* `tauri-release.yml:116`
   sets `prerelease: false` unconditionally; `.claude/skills/release/SKILL.md:171` publishes with
   `--draft=false --latest`; `src-tauri/tauri.conf.json:107-109` points the updater at
   `releases/latest/download/latest.json`. (#1825 bounds it: WiX rejects a non-numeric prerelease so
   the MSI leg fails first — NSIS, macOS and Linux do not.) *npm — not in the issue body, and the
   half the desktop fix would otherwise create:* `publish.yml:20-22` fires on
   `release: types: [published]`, which fires for a prerelease; its tag/`package.json` check
   (`:100-111`) passes for `v1.0.0-rc.1`; and `:121` is `npm publish --provenance --access public`
   with **no `--tag`**, so npm stamps `latest` and every `npm i -g tandem` gets the RC.
2. **Test runs before Build.** `ci.yml:374` (`Test`) precedes `:431` (`Build`).
   `tests/build/version-baked.test.ts:21` is `describe.skipIf(!existsSync(bundlePath))` and skips
   every CI run; `tests/monitor/build-artifact.test.ts` is worse — both its `it`s `return` early when
   the bundle is absent, so they **pass with zero assertions**.
3. **`NPM_TOKEN` expiry — already resolved**, verified on fff8e312: `publish.yml` has no
   `NPM_TOKEN`; its header documents npm Trusted Publishing (OIDC) and the v0.25.0 failure that
   forced it. Closed by #1878. No code change; the PR body states this and cites the file.
4. **CodeQL config is inert.** Measured 2026-09-10: `code-scanning/default-setup` is
   `{"state":"configured"}`, there is no CodeQL workflow, and
   `repos/bloknayrb/tandem/properties/values` **404s** — custom properties are an org feature and
   this is a user-owned repo, so the `github-codeql-config-file` route the issue offers is **not
   available**. Zero open alerts on `rename-recovery.ts`, so its one `paths-ignore` entry suppresses
   nothing.

## Fix

**Item 1 — derive `prerelease` from the tag (decision G).**

- `tauri-release.yml`, `create-release`'s `github-script` body: `prerelease: false` →
  `prerelease: tag.includes('-')`. `tag` is in scope at `:84`. The `-` test, not a semver parse: the
  tag is already pinned equal to `v${tauri.conf.json.version}` at `:69-78`.
- **The reuse branch (`:104-108`)** returns before `createRelease`, so a re-run on a tag whose first
  run created the draft inherits that run's flag — and re-runs are normal for a four-platform signed
  build. Add before the `return`:

  ```js
  await github.rest.repos.updateRelease({
    owner: context.repo.owner,
    repo: context.repo.repo,
    release_id: existing[0].id,
    prerelease: tag.includes('-'),
  });
  ```

  **Spell `owner`/`repo` out; the bare-shorthand `{ owner, repo, … }` throws here.** Verified on
  fff8e312: this script (`:80-119`) binds only the action's `github, context, core, …` and both
  existing calls spell the repo out (`:89-90`, `:110-111`); the `const owner = context.repo.owner`
  pair lives in the *verify-release-manifest* script at `:872-873`. A shorthand would throw
  `ReferenceError: owner is not defined` on exactly the path this bullet fixes, at a `v*` tag, with
  nothing to catch it first.
- `.claude/skills/release/SKILL.md` step 7: split the publish command. No `-` → unchanged
  (`--draft=false --latest`). With `-` → `gh release edit v<version> --draft=false --prerelease
  --latest=false`, plus one sentence: GitHub's `releases/latest` resolves to the newest
  non-prerelease release, which is the only thing keeping the updater endpoint off an RC. **Do not
  pass `--latest` on a prerelease.** This is the internal release skill, **not**
  `skills/tandem/SKILL.md` — no frontmatter bump, no `skill-instruction-contract.test.ts` edit.
- **`publish.yml` — derive the npm dist-tag inside the publish step itself**, so no second step can
  be deleted or disarmed independently of the pinned one:

  ```yaml
      - name: Publish to npm
        env:
          TAG: ${{ inputs.tag || github.ref_name }}
        run: |
          set -euo pipefail
          case "$TAG" in
            *-*) NPM_TAG=next ;;
            *)   NPM_TAG=latest ;;
          esac
          npm publish --provenance --access public --tag "$NPM_TAG"
  ```

  Keep the existing `--provenance` comment above it. `next` is npm's prerelease-channel convention;
  `latest` is npm's default, so the non-prerelease path is unchanged in effect while becoming
  explicit. **The `-` test matches the desktop half's**, so the two channels cannot disagree about
  what a prerelease is. Whether Tandem publishes RCs at all stays Bryan's (Not in scope).

**Item 2 — run `Build` before `Test`.**

- `ci.yml`, `check` job: move the `Build` step (`run: npm run build`) to immediately **before**
  `Test`. Both dist-gated suites then find their bundles and assert for real — no new step, no env
  var, no second vitest invocation. Verified safe against the three wiring tests that read this job:
  none locates or orders `Build`. `acceptance-harness-wiring.test.ts:235-266` orders
  python/fetch/`npm ci` against the harness step and python against the vitest step,
  `vitest-file-anchor-wiring.test.ts:98-100` pins the `Test` step's `run` and requires the anchor
  after it, and `typecheck-tests-wiring.test.ts:167-169` orders `npm ci` before the typecheck step.
  Build stays after `npm ci` and before the post-build smoke steps, so all four relations hold.
- The `Typecheck (root)` comment says the root config ran "only inside the `Build` step five steps
  below" — update that sentence in the same commit; the move makes it false.
- `tests/monitor/build-artifact.test.ts`: replace both early `return`s (`:9-12`, `:17`) with a
  `describe.skipIf(!existsSync(MONITOR_DIST))` opener, so a missing bundle is a **visible skip**
  rather than two vacuous passes. `version-baked.test.ts` already has that shape.

**Item 3 — no change.** Verify and state. **Item 4 — delete `.github/codeql/codeql-config.yml`** and
the now-empty `.github/codeql/`: it implies coverage it cannot have, on a route this repo cannot
take, and the zero-alerts measurement is what makes "changes no scan result" a fact.

## Tests

One describe in the group's shared `tests/scripts/release-ci-hygiene.test.ts` (ADR-051: these
targets sit in workflows no required check reads, or in a runbook nothing asserts).

- **`tauri-release.yml`.** Find `create-release`'s `github-script` step (throw if absent); assert its
  `with.script` contains `tag.includes('-')`, does **not** contain `prerelease: false`, contains
  `updateRelease`, and contains `context.repo.owner` — the discriminator between the runnable reuse
  branch and the one that throws. (Not "the literal `prerelease: tag.includes('-')` twice": a single
  `const prerelease = tag.includes('-')` passed to both calls is correct and would go red.)
- **`publish.yml`.** Find the step whose `run` contains `npm publish` (throw if absent or if more
  than one); pin its `run.trim()` by **exact equality** to the block above — the `case` arms and the
  publish line are one string, so the derivation cannot be deleted or rewritten without reddening
  this — pin `env.TAG` by exact equality, assert no `if:` and no `continue-on-error`, and assert no
  step in the file runs a bare `npm publish` without `--tag`.
- **`ci.yml`.** Assert the index of the step whose `run.trim()` is `npm run build` is **less** than
  the index of the step whose `run` starts with `npm test` (throw if either is absent). That single
  relation is item 2's whole anchor: reorder it back and both suites silently stop asserting.
- **`.claude/skills/release/SKILL.md`.** Read it, **throw if the step-7 publish block is absent**,
  assert both branches (`--draft=false --latest` on the no-hyphen line; `--prerelease` and
  `--latest=false` on the hyphen branch), and assert **no line in that block pairs `--latest` with
  `--prerelease`**. Precedent: `tests/skill-instruction-contract.test.ts:257`.

Items 3 and 4 need no test. No experiment in `docs/reviews/2026-09-02-v1-review/experiments/` covers
any of the four findings.

## Done when

All four accounted for; the describe green; `npm test` and `npm run typecheck:tests` green; and the
hand-run that is item 2's real evidence: **`npm run build` then the full local suite**, with
`version-baked.test.ts` and `build-artifact.test.ts` observed **running and passing rather than
skipping** (neither has ever asserted anything in CI, so `toContain("/api/events")` and `"/api/mode"`
against a real `dist/monitor/index.js` are untested claims about tsup's output — if either fails,
that is a finding to fix, not a reason to revert the move). If any other test fails only with `dist/`
present, fix it; do not undo the move. `Closes #1748` only if all four are resolved in code — item 1
means the desktop workflow, its re-run path, the runbook **and** the npm dist-tag.

## Not in scope

Whether Tandem should publish RCs at all (Bryan's — decision G settled the mechanism, not the
policy). Changing the updater endpoint. #1825's WiX/NSIS prerelease-string behaviour —
informational, recorded in the PR body. Enabling CodeQL advanced setup.

## Review corrections (scope cut)

**Removed, and each removal makes a blocking finding moot.**

- The separate "Derive npm dist-tag" step, its `# gate:npm-dist-tag` marker, the find-by-marker
  finder, the `env.TAG`/`case`-arm pins and the index-before-publish assertion. The derivation now
  lives in the publish step's own `run`, so the outcome-deciding half and the pinned half are one
  string and the finding *"delete the derive step and `check` stays green"* cannot arise.
- The whole `TANDEM_REQUIRE_BUILD_ARTIFACTS` mechanism: the env var, the new post-Build `ci.yml`
  step, the four per-`it` existence assertions, the exact-line pins on both spec files, the
  `package.json` `scripts.test` pin, and the index assertions against the two sibling wiring tests.
  Item 2 is now a reorder plus one ordering assertion, so the finding *"the guard is satisfied by a
  comment"* has no guard to satisfy. Checked, not assumed, that no wiring test locates `Build`.
- The two "observed failing" hand-runs and the `--passWithNoTests=false` contingency, both of which
  existed only to service the deleted env gate. The round-1/round-2 logs, folded into the body.

**Finding fixed directly.** *"`updateRelease` uses identifiers that do not exist in that scope."*
The call now spells `owner: context.repo.owner` / `repo: context.repo.repo`, and the test asserts
`context.repo.owner` is in the script.

**File set:** `.github/workflows/{tauri-release,publish,ci}.yml`,
`.claude/skills/release/SKILL.md`, `tests/monitor/build-artifact.test.ts`,
`.github/codeql/codeql-config.yml` (deleted), and a describe in the shared
`tests/scripts/release-ci-hygiene.test.ts`. Dropped from the round-2 set:
`tests/build/version-baked.test.ts`, `package.json`.
