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

_(empty)_
