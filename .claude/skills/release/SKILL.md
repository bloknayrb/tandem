---
name: release
description: Cut a Tandem release — six-surface version bump, changelog, tag, GitHub Release publish, smoke checklist
disable-model-invocation: true
---

# Cut a Tandem Release

Codifies the release sequence used for v0.14.3 / v0.15.0 / v0.16.0. The version
bump has **SIX surfaces**, none of which bump automatically. Surfaces 1–4 are
CI-guarded by `tests/plugin/plugin-version-pin.test.ts` (any divergence from
`package.json` fails CI); surfaces 5–6 are **not guarded** — this skill is what
prevents them drifting.

## The six version surfaces

1. `package.json` — `version` (the reference value the CI guard compares against)
2. `.claude-plugin/plugin.json` — THREE values in one file: the top-level
   `version`, plus the `tandem-editor@<version>` npx pins in
   `mcpServers.tandem.args` AND `mcpServers.tandem-channel.args`
3. `src-tauri/Cargo.toml` — `[package].version` (the Cowork installer pins its
   npx spec via `env!("CARGO_PKG_VERSION")`; stale = ships a build pinning the
   WRONG published npm version)
4. `src-tauri/tauri.conf.json` — `version` (drives desktop artifact names
   `Tandem_<version>_x64.dmg`, … AND the tauri-action `__VERSION__` that
   names/targets the GitHub release; stale = installers uploaded onto the
   PREVIOUS release — this bit v0.15.0, clobbering v0.14.3's published
   artifacts before the guard was added)
5. `package-lock.json` — regenerate, never hand-edit:
   ```bash
   npm install --package-lock-only
   ```
   Unguarded by the version-pin test, but `npm ci` in ci.yml / publish.yml /
   tauri-release.yml hard-fails on a name/version mismatch with package.json.
6. `src-tauri/Cargo.lock` — refresh and commit:
   ```bash
   cargo update --manifest-path src-tauri/Cargo.toml -p tandem-desktop --precise <version> --offline
   ```
   Hygiene only, NOT a breakage surface: no workflow passes `--locked`, so
   cargo silently regenerates a stale lock and CI stays green — but the tree
   goes dirty on the next local build if you skip this.

## Steps

1. Bump all six surfaces (above), then run the catch-all: grep the tree for the
   OUTGOING version and confirm zero source stragglers remain:
   ```bash
   git grep <old-version> -- ':!CHANGELOG.md' ':!*.lock' ':!package-lock.json' ':!tests/**'
   ```
   (CHANGELOG keeps history; lockfiles carry dep versions; test fixtures use
   literal version strings — all expected. Anything else is a missed surface.)

2. Run the `changelog` skill to generate the Keep a Changelog entry, then
   finalize the `## [<version>]` section in `CHANGELOG.md` (the in-app View
   Changelog button serves this file).

3. Verify the full test suite is green — `plugin-version-pin.test.ts` proves
   surfaces 1–4 agree (it also checks `plugin.json`'s pinned npx specs);
   `tests/plugin-manifest.test.ts` additionally fails if `package.json` and
   `plugin.json` diverge — treat either failure as "you bumped some, not all":
   ```bash
   npm run typecheck && npm test
   ```

4. Ship the bump through the normal flow: branch → PR → CI green → merge →
   verify master CI green on the **merge commit**.

5. Tag the release on the master tip and push the tag:
   ```bash
   git tag v<version> && git push origin v<version>
   ```
   The `v*` tag push triggers `.github/workflows/tauri-release.yml`: the signed
   desktop build matrix plus a `release-check` summary job, creating a **DRAFT**
   GitHub Release (`releaseDraft: true`) with artifacts + `latest.json`. The
   tag alone does NOT publish to npm. (`HUSKY=0` on the tag push is fine — the
   commit is already CI-green.)

6. Wait for every matrix build and `release-check` to go green, then publish
   the draft:
   ```bash
   gh release edit v<version> --draft=false --latest
   ```
   Publishing is the npm trigger: `.github/workflows/publish.yml` fires on
   `release: [published]` and runs `npm publish --provenance`. If macOS
   notarization 403s on "agreement missing/expired," that is an Apple
   legal-agreement lapse only the Account Holder (Bryan) can clear at
   developer.apple.com / App Store Connect — re-run the failed jobs after he
   signs.

7. Walk `docs/release-smoke-checklist.md`: CI signal first (matrix +
   `tauri-webdriver.yml` + macOS launch smoke), then real installers on real
   machines — SmartScreen/Gatekeeper, updater from the *previous* version,
   file associations, `npm install -g tandem-editor@<version>` + `tandem
   doctor`. Record the outcome (platforms covered, anything skipped) on the
   release PR or tracking issue — an unstated skip reads as "verified".

8. Update project memory: the CLAUDE.md **Status** section (what shipped in
   this version) and the project memory SHIPPED entry (per the archive
   rotation discipline).

## Important

- Never hand-edit either lockfile — always regenerate (surfaces 5–6).
- Changelog entries follow ADR-038 framing: "your AI" / "the AI" generically;
  "Claude" as the concrete example only for Claude-specific features.
