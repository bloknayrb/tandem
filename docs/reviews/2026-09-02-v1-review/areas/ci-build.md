# Area: CI and build

**Raw:** [`../raw/findings-ci-build.txt`](../raw/findings-ci-build.txt) (Fable, resumed, 2 calls) plus
[`../raw/gapfill-D.txt`](../raw/gapfill-D.txt) (Sonnet, web facts: Node release history, CodeQL
default-setup behaviour, WiX prerelease rules). **Manifest:**
[`../raw/manifests/ci-build.md`](../raw/manifests/ci-build.md).
**Tracks:** [I supply chain](../tracks/I-supply-chain.md); Lows in [K](../tracks/K-tests-and-lows.md).
**Spot-check:** all four Highs and three of four Mediums read at the cited lines by the orchestrator;
the Node release list was fetched from `nodejs.org/dist/index.json` on 2026-09-02.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| H | `.github/dependabot.yml:8` | `package-ecosystem: ""` is the unedited template, so no dependency update has ever run. | [read] | Source-confirmed | [#1744](https://github.com/bloknayrb/tandem/issues/1744) |
| H | `.github/workflows/tauri-release.yml:317` (also `:59,80,158,183,189,194,358`) | Signing secrets are exposed to floating-tag action steps; only `azure/login` (`:219`) is SHA-pinned. | [read] | Source-confirmed | [#1745](https://github.com/bloknayrb/tandem/issues/1745) |
| H | `tauri-release.yml:299-306,465-474` | The macOS signing/notarization gate exits 0 on empty `APPLE_*` secrets; the Windows leg (`:281-287`) exits 1. A misconfigured secret ships unsigned silently. | [read] | Source-confirmed | [#1746](https://github.com/bloknayrb/tandem/issues/1746) |
| H | `scripts/download-node-sidecar.mjs:172` | Sidecar Node pinned at 22.17.0 (2025-06-24); five security releases since (22.17.1, 22.22.0, 22.22.2, 22.23.0, 22.23.2). Raised from Medium once the list was fetched. | [ran] | Reproduced (curl) | [#1747](https://github.com/bloknayrb/tandem/issues/1747) |
| M | `tauri-release.yml:116` + `.claude/skills/release/SKILL.md:171` + `tauri.conf.json:108` | `prerelease: false` unconditionally, `--latest` on publish, updater reads `releases/latest`: an RC tag auto-updates every desktop install. Bounded on Windows-MSI only, where WiX rejects a non-numeric prerelease. | [read] | Source-confirmed | [#1748](https://github.com/bloknayrb/tandem/issues/1748), [decision G](../decisions.md) |
| M | `ci.yml:275` vs `:311` | Test runs before Build, so `tests/build/version-baked.test.ts:21` and `tests/monitor/build-artifact.test.ts` skip in every CI run and read as passed. | [read] | Source-confirmed | [#1748](https://github.com/bloknayrb/tandem/issues/1748) |
| M | `.github/workflows/publish.yml:25-27` | Long-lived `NPM_TOKEN`, 90-day cap, no dated issue tracking expiry. | [read] | Agent-reported (token type unknown) | [#1748](https://github.com/bloknayrb/tandem/issues/1748) |
| L | `.github/codeql/codeql-config.yml` | Default CodeQL setup ignores the file unless the `github-codeql-config-file` repo property is set; the `paths-ignore` is inert. | [ran] | Agent-ran (docs.github.com) | [#1748](https://github.com/bloknayrb/tandem/issues/1748) |
| L | `package.json` | ~393 production packages installed vs ~148 needed; 44 movable to `devDependencies`. `dist/cli` bare imports are only the MCP SDK, `env-paths`, `zod` and builtins. | [read] | Source-confirmed in shape | [#1825](https://github.com/bloknayrb/tandem/issues/1825) |
| L | various | `publish.yml` no `v*` guard; Playwright `retries: 1` with no trace; `lint-staged` JSON key matches nothing; sourcemaps shipped (~18 MB); `check-font-assets` reads a `dist/index.html` never written; pre-push biome scope narrower than CI; `infra/` outside tsconfig and biome; Authenticode subject-pin TODO; `rust-toolchain@stable` floating; `ci.yml` port list hand-copied; `src/cli` typechecked with the DOM lib; knip 22 unused files. | [read] | Agent-reported | [#1825](https://github.com/bloknayrb/tandem/issues/1825) |

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

`CONTRIBUTING.md:129,135-137,146-149` stale; `docs/cli.md` scripts table incomplete;
`ci.yml:376-379` trace claim false; `tauri-release.yml:462-464` "pre-cert" comment stale;
`docs/workflows.md` not in npm `files`.

## Verified fine

Release manifest verification in `tauri-release.yml`; the acceptance-harness wiring test;
`check:links` baseline (one pre-existing broken ADR-034 anchor, already tracked).
