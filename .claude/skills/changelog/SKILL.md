---
name: changelog
description: Generate a Keep a Changelog entry from git log since the last tag
disable-model-invocation: true
---

# Generate Changelog Entry

Generate a formatted CHANGELOG entry from commits since the last release tag.

## Steps

1. Find the last release tag:
```bash
git describe --tags --abbrev=0
```

2. List commits since that tag:
```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline --no-merges
```

3. Group commits into Keep a Changelog categories based on conventional commit prefixes:
   - `feat(...)` → **Added** (new features) or **Changed** (enhancements to existing)
   - `fix(...)` → **Fixed**
   - `refactor(...)` → **Changed**
   - `docs(...)` → **Documentation**
   - `test(...)` → **Tests**
   - `chore(...)` → **Maintenance**
   - `perf(...)` → **Performance**
   - Security-related commits → **Security**

4. Format as a `## [Unreleased]` section. Each entry should be:
   - Bold summary with PR number: `- **Description** (#N)`
   - Group related commits into a single entry where appropriate
   - Use imperative mood ("Add", "Fix", "Remove" — not "Added", "Fixes")

5. Output the formatted block for the user to review and paste into `CHANGELOG.md`.

## Important

- Do NOT write directly to CHANGELOG.md — output the block for editorial review
- Check the existing CHANGELOG.md format to match style (indentation, heading levels, PR references)
- If there's already an `[Unreleased]` section, show what to append, not a replacement
- Omit empty categories (don't show "### Security" if there are no security commits)

## Releasing — bump version in FOUR places

When cutting a release (`chore(release): vX.Y.Z`), bump the version in `package.json`, `.claude-plugin/plugin.json` (top-level **and** both `tandem-editor@<version>` npx pins), `src-tauri/Cargo.toml`'s `[package].version`, AND `src-tauri/tauri.conf.json`'s `version`. None bump automatically, so any one drifts if you forget it. Then regenerate the lockfiles (`npm install --package-lock-only`; `cargo update --manifest-path src-tauri/Cargo.toml -p tandem-desktop --precise <version> --offline`) or `npm ci` / rust CI will fail on drift.

`tests/plugin/plugin-version-pin.test.ts` fails if any of the four diverge (it also checks `plugin.json`'s pinned npx specs); `tests/plugin-manifest.test.ts` fails if `package.json`/`plugin.json` diverge — treat either failure as "you bumped some, not all." Why each surface matters beyond CI:
- **Cargo.toml** — the Cowork installer pins its npx spec via `env!("CARGO_PKG_VERSION")`; a stale value ships a build pinning the WRONG published npm version.
- **tauri.conf.json** — drives the desktop bundle artifact names (`Tandem_<version>_x64.dmg`, …) AND the tauri-action `__VERSION__` that names/targets the GitHub release. A stale value builds correctly-coded installers under the wrong version number and **uploads them onto the PREVIOUS release** (this bit v0.15.0: 0.14.3-named artifacts clobbered the published v0.14.3 release before the guard was added). No `CARGO_PKG_VERSION`-style derivation exists for it, so it rots silently.

## Conventions

Going forward, changelog entries follow [ADR-038](../../../docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration) framing — write "your AI" / "the AI" generically; use "Claude" as the concrete example when a feature is Claude-specific (e.g. channel push, plugin monitor, cowork, auto-launcher, plugin marketplace). Past entries (v0.12.0 and earlier) are historical record and not rewritten.
