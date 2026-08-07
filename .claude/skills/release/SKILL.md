---
name: release
description: Cut a Tandem release — six-surface version bump, changelog, tag, GitHub Release publish, smoke checklist
disable-model-invocation: true
---

# Cut a Tandem Release

Codifies the release sequence used from v0.14.3 onward, and refined by every cut
through v0.20.1 — including the global-install upgrade step, the two changelog
gaps, and the duplicate-draft race described below. The version
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
   `Tandem_<version>_x64.dmg`, …). It used to also *target* the GitHub release
   through the tauri-action `__VERSION__` substitution, which is how a stale
   value uploaded v0.15.0's build onto the PREVIOUS release and clobbered
   v0.14.3's published artifacts. That mechanism is gone: `tauri-release.yml`
   targets the pushed git tag, and its `create-release` job fails the build
   before anything is signed when the tag and this file disagree. Still bump
   it — a stale value now ships mis-*named* installers instead of mis-placed
   ones.
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

   **Ask for it again AFTER the cut, over `v<prev>..v<new>`.** At v0.20.0 that
   post-release run found a whole missing category that two dedicated review
   agents had not: no `### Security` section, despite the release pinning
   `@hono/node-server` past GHSA-frvp-7c67-39w9 in code that ships. A reviewer
   pointed at the entries can only grade the entries that exist; nothing asks
   which category is *absent*. Concretely, before calling the section done:
   - Walk the merged-PR list (`git log v<prev>..HEAD --merges`), not only the
     commit subjects — a fix can land with no issue number anywhere in its
     subject and be invisible to a `#\d+` scan.
   - Check every dependency bump against the repo's real Dependabot alert list
     (`gh api repos/<owner>/<repo>/dependabot/alerts`). A bump next to a
     security bump is not itself a security fix, and an automated update can
     widen a peer range without moving the resolved version off the affected
     one.
   - When recording a security fix, state reachability honestly in both
     directions — "bundled but we never call it" belongs in the entry, or the
     note implies an exposure that did not exist.

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

5b. Populate the GitHub release body from the `## [<version>]` changelog
   section — `tauri-action` writes only "See the assets to download and install
   Tandem." Extract the section between its heading and the previous version's
   and pass it via `gh release edit v<version> --notes-file <file>`. Do this
   before publishing where possible. Inconsistent historically (v0.18.0 had
   full notes; v0.17.0 and v0.19.0 shipped with the boilerplate), so it needs
   to be a step rather than a habit.

6. Wait for every matrix build, `release-check`, AND `verify-release-manifest`
   to go green, then publish the draft:
   ```bash
   gh release edit v<version> --draft=false --latest
   ```

   **A green matrix is not a complete release.** Until v0.20.1 every matrix leg
   independently found-or-created the draft, so four jobs starting in the same
   second could race and split the artifacts across TWO drafts sharing one tag,
   each with a partial `latest.json`. v0.18.0 shipped that way — 8 assets and 5
   platform keys, no `darwin-aarch64`, no linux, while a 10-asset sibling draft
   sat orphaned and unpublished. Nothing was red. A missing platform key is
   indistinguishable from "no update available", so every M-series Mac was told
   it was up to date until the next release.

   `create-release` + `verify-release-manifest` now make that structural, but
   the cheap manual confirmation is worth keeping — the counts are the tell:
   ```bash
   gh api repos/bloknayrb/tandem/releases --jq \
     '[.[]|select(.tag_name=="v<version>")]|length'   # must be 1, never 2
   gh release view v<version> --json assets --jq '.assets|length'  # 17
   ```
   17 assets and 11 platform keys is the healthy shape (`latest.json`, 4
   installers + 4 `.sig`, 2 `.app.tar.gz` + 2 `.sig`, 2 dmg, deb/rpm/AppImage
   + sigs).
   Publishing is the npm trigger: `.github/workflows/publish.yml` fires on
   `release: [published]` and runs `npm publish --provenance`. If macOS
   notarization 403s on "agreement missing/expired," that is an Apple
   legal-agreement lapse only the Account Holder (Bryan) can clear at
   developer.apple.com / App Store Connect — re-run the failed jobs after he
   signs.

6b. Upgrade the local global install: `npm install -g tandem-editor@<version>`.
   This is a smoke-checklist §4 step, but it is also a *correctness* step for
   the plugin path and easy to skip because nothing fails loudly without it. A
   stale global `tandem-editor` shadows `npx -y tandem-editor@<pin>`, so the
   plugin's exact per-release pin in `.claude-plugin/plugin.json` silently
   resolves to whatever old version is installed. Found at v0.20.0 sitting two
   versions behind, at 0.18.0. Verify with `npm ls -g tandem-editor --depth=0`;
   `tandem doctor` also asserts it (`Global tandem-editor@<v> matches this
   build`).

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
