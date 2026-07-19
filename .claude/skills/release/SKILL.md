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
2. `.claude-plugin/plugin.json` — FOUR values in one file: the top-level
   `version`, plus the `tandem-editor@<version>` npx pins in
   `mcpServers.tandem.args`, `mcpServers.tandem-channel.args`, AND the
   `experimental.monitors[].command` shell string
   (`npx -y tandem-editor@<version> monitor` — added #1201; it lives in a
   `command` string, invisible to the `args`-array walker, so it has its own
   guard case in `plugin-version-pin.test.ts`. Miss it and the plugin monitor
   stays pinned to the previous, dormant version)
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
   Unguarded, and **nothing in CI catches it** — `npm ci` will not. Its
   lockfile-sync check covers **dependencies** only: with the lock left stale,
   bumping the root `version` exits 0, and even changing the root `name` exits
   0 (verified on npm 11.12.0; only an unlocked *dependency* makes it fail).
   Regenerate anyway — the lock's root `version` is committed, so skipping it
   ships a lockfile disagreeing with `package.json` and leaves the next local
   `npm install` to rewrite the file and dirty the tree.
6. `src-tauri/Cargo.lock` — refresh and commit:
   ```bash
   cargo update --manifest-path src-tauri/Cargo.toml -p tandem-desktop
   ```
   **Do not add `--precise <version>`.** `tandem-desktop` is a local package,
   and for a local/workspace package `--precise` is silently ignored: asking
   for a version the manifest doesn't have exits 0 and changes nothing. The
   version comes from `Cargo.toml`, so bump the manifest (surface 3) and let
   plain `-p` relock it.

   Hygiene only, NOT a breakage surface: nothing verifies this lockfile —
   `ci.yml` runs a bare `cargo test --manifest-path src-tauri/Cargo.toml` with
   no `--locked`, so cargo silently regenerates a stale lock and CI stays
   green. (`tauri-webdriver.yml` does pass `--locked`, but only to
   `cargo install` for its own tooling — unrelated to `src-tauri/Cargo.lock`.)
   The tree still goes dirty on the next local build if you skip this.

## Steps

1. Bump all six surfaces (above), then run the catch-all: grep the tree for the
   OUTGOING version and confirm zero source stragglers remain:
   ```bash
   git grep -F <old-version> -- ':!CHANGELOG.md' ':!*.lock' ':!package-lock.json' ':!tests/**' ':!docs/**'
   ```
   **`-F` is load-bearing:** unescaped, the dots are regex wildcards, so a
   version like `0.15.0` also matches `oklch(0.15 0.01 …)` in `index.html` — a
   pure false positive. On the most recent release, `-F` plus `':!docs/**'`
   took this from 33 matching lines down to 9. (CHANGELOG keeps history;
   lockfiles carry dep versions; test fixtures and docs cite versions as
   prose — all expected.)

   **Read the survivors, don't just count them — they are not all bugs.**
   Expect three kinds: the six surfaces themselves (before you bump them);
   deliberate prose naming the outgoing version as history (this skill's
   header, CLAUDE.md's Status); and source comments, which the exclusions do
   NOT hide — `src/server/license/gate-flag.ts` carries a
   `Default: false (v<version>)` marker. Judge each one; a straggler is a hit
   that still *pins* the old version rather than describing it.

2. Ask Bryan to run `/changelog` to generate the Keep a Changelog entry, then
   finalize the `## [<version>]` section in `CHANGELOG.md` (the in-app View
   Changelog button serves this file). You cannot invoke it yourself — the
   `changelog` skill sets `disable-model-invocation: true`, which makes it
   user-invocable only.

3. Verify the full test suite is green — `plugin-version-pin.test.ts` proves
   surfaces 1–4 agree (it also checks `plugin.json`'s pinned npx specs);
   `tests/plugin-manifest.test.ts` additionally fails if `package.json` and
   `plugin.json` diverge — treat either failure as "you bumped some, not all":
   ```bash
   npm run typecheck && npm test -- --run
   ```
   Pass `--run`. The `test` script is bare `vitest`, whose watch default is
   `!isCI && process.stdin.isTTY && !isAgent` — so it exits on its own in CI,
   when piped, and for an agent, but sits in watch mode in Bryan's interactive
   terminal. `--run` makes that unconditional; `ci.yml` and `.husky/pre-push`
   both pass it.

4. Ship the bump through the normal flow: branch → PR → CI green → merge →
   verify master CI green on the **merge commit**.

5. Tag the release on the master tip and push the tag:
   ```bash
   git tag -a v<version> -m "Tandem v<version>" && git push origin v<version>
   ```
   Use `-a` (annotated). Bare `git tag v<version>` creates a *lightweight* tag
   — `git cat-file -t` reports `commit`, not `tag` — which would break the
   pattern: every release tag since v0.11.1 is annotated. (Older tags are
   mostly lightweight; that is history, not the standard to copy.)
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
