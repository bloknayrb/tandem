# Track I — Supply chain and release workflow

**Tier:** Sonnet builds, Opus reviews. **Decisions needed:** [G](../decisions.md) (refuse RC tags
as latest?) for one item of #1748 only. **Can start now.** **Release relation:** three of the five
are **on the [release gate](../release-gate.md)**: #1746, #1745 and #1747 block the next minor.

## Issues

| Issue | What | Effort |
|---|---|---|
| [#1744](https://github.com/bloknayrb/tandem/issues/1744) | Fill `dependabot.yml` (`npm`, `cargo`, `github-actions`), grouped weekly; the first run will be large. | 15 min plus triage |
| [#1745](https://github.com/bloknayrb/tandem/issues/1745) | SHA-pin every action in `tauri-release.yml` (and `ci.yml`, `publish.yml`); Dependabot then keeps the pins fresh. | 30 min |
| [#1746](https://github.com/bloknayrb/tandem/issues/1746) | The macOS signing/notarization gate fails on empty `APPLE_*` secrets, like the Windows leg. | 15 min |
| [#1747](https://github.com/bloknayrb/tandem/issues/1747) | Pin the sidecar Node to 22.23.2; a CI drift test against `nodejs.org/dist/index.json` `security: true` so the next lag is red. | 10 min plus a build |
| [#1748](https://github.com/bloknayrb/tandem/issues/1748) | `prerelease` derived from the tag and no `--latest` for prereleases (or the release skill refuses `-` tags, decision G); the two dist-gated suites run after Build or fail when `CI` and the artifact is absent; a dated issue for `NPM_TOKEN` expiry or trusted publishing; set the CodeQL repo property or delete the config file. | 1 to 2 h |

Area ledger: [ci-build](../areas/ci-build.md). Lows to fold in from
[#1825](https://github.com/bloknayrb/tandem/issues/1825): the `v*` guard, Playwright trace on
retry, the `lint-staged` key, sourcemaps in the package, `check-font-assets`' phantom path, the
pre-push biome scope, `infra/` in tsconfig and biome, the dependency diet.

## Rules that bite here

- The `check` job's acceptance-harness step is deliberately unconditional and preceded by a tag
  fetch; `tests/scripts/acceptance-harness-wiring.test.ts` fails if either changes. Reordering
  Test and Build must keep that step's shape.
- `tests/scripts/coverage-gate-wiring.test.ts`, `typecheck-tests-wiring.test.ts` and
  `windows-acl-proof-wiring.test.ts` each pin a `ci.yml` step by content; run `npm test` after any
  workflow edit, not only the workflow.
- `check` is a required status check with `enforce_admins`; a red `check` blocks Bryan too.
- The release skill (`.claude/skills/release/SKILL.md`) is the six-surface version bump; a
  prerelease rule belongs there and in the workflow both.
- Dated gates need a dated issue with the date in the title (#1748 item 3).

## Reviewer agents

`security-reviewer` on #1745 and #1746 (secrets exposure and an unsigned-build path).

## Done when

- A Dependabot PR has opened and merged.
- Every `uses:` in the three workflows is a 40-char SHA with a version comment.
- A dry run of `tauri-release.yml` with `APPLE_*` unset fails the macOS leg.
- `scripts/download-node-sidecar.mjs` says 22.23.2 and the drift test is green.
- A `v9.9.9-rc.1` tag on a fork produces a prerelease with no `latest.json` move (or the skill
  refuses it), and decision G is recorded.

## Status

**#1744–#1747 addressed in [#1833](https://github.com/bloknayrb/tandem/pull/1833). #1748 untouched.**

Three of the five "Done when" criteria are met, one is met differently from how it is written
here, and one **cannot be met as written** — that last one is the reason this section is worth
reading rather than a formality.

- **Every `uses:` is a 40-char SHA with a version comment** — met, and wider than the issue asked.
  #1745 named three workflows; this covers **all five** (34 references), so the guard can assert
  "no unpinned action anywhere", which an allowlist over three files cannot express. The
  secret-bearing set is also **three, not two**: `publish.yml` holds `NPM_TOKEN` *and*
  `id-token: write`, so a moved `setup-node` tag there mints a provenance-attested malicious npm
  package.
- **The sidecar says 22.23.2 and the drift check is green** — met, plus two things #1747 did not
  ask for. The expected archive hashes are now committed (the fetched `SHASUMS256.txt` comes from
  the same host and CDN as the tarball, so it detects transport corruption and nothing else), and
  the existence check is version-aware: it used to exit 0 on any binary over a size floor *before
  the version was read*, so a bump was a silent no-op in any tree that already had a sidecar. The
  live specimen was a **v24.14.0** binary sitting where the pin said 22.
- **Dependabot is filled in — but `github-actions` is deliberately NOT grouped**, which diverges
  from the instruction in the Issues table above. Grouping turns a week of action bumps into one
  PR mutating a dozen 40-hex strings, and that is precisely the artifact in which one wrong SHA is
  invisible. `npm` and `cargo` are grouped as written. **"A Dependabot PR has opened and merged"
  is not yet true** and cannot be until the config is on master.
- **"A dry run of `tauri-release.yml` with `APPLE_*` unset fails the macOS leg" cannot be run.**
  The workflow triggers on `push: tags: ["v*"]` and nothing else — no `workflow_dispatch`, no
  `pull_request` — so there is no dry run to perform, and there is no macOS hardware on this
  project. The gate is written and its shape is pinned by a test inside `check`, but it has never
  executed. That is registered in [`docs/security.md`](../../../security.md) as **fixed but
  unverified** with a dated issue ([#1829](https://github.com/bloknayrb/tandem/issues/1829),
  deadline 2026-12-01) and a one-release checkbox in the smoke checklist. Do not read a green
  `check` on #1833 as evidence this criterion passed.

**The "Rules that bite here" list needs one addition**, learned the expensive way: those wiring
tests pin workflow steps *by content*, and content pinning that reads for a **substring** cannot
see whether the matched text is still **reachable**. Adversarial review defeated three assertions
in this PR's own new guard with `if false && [ … ]`, `|| true` and `-and $false`, each leaving
every scanned literal in place while shipping an unsigned artifact. Pin the **executable lines**
of a `run:` body — everything that is not blank, a comment, or a message — rather than fragments
of it.

Three exposures SHA-pinning does not touch were found and filed rather than folded in:
[#1830](https://github.com/bloknayrb/tandem/issues/1830) (nothing verifies the updater `.sig`
against `tauri.conf.json`'s pubkey — the artifact this track is nominally protecting),
[#1831](https://github.com/bloknayrb/tandem/issues/1831) (`claude-code-review.yml` has been dead
since 2026-05-27 and would skip every Dependabot PR anyway, so it does not cover the human SHA
check this track relies on) and [#1832](https://github.com/bloknayrb/tandem/issues/1832)
(`npm ci` runs lifecycle scripts in the same job as the signing secrets — a cheaper path to the
same outcome than moving an action tag).
