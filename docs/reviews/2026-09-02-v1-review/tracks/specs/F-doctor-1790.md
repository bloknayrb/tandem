# F-doctor — #1790 skill and plugin version skew

Branch `fix/doctor-and-skill-version-skew-1806`. Closes #1790. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/upgrade-path.md:17-18` and
`areas/skill-plugin.md:21`. The `[ran]` experiment for the skill-content row (per-tag `curl` +
md5, `55d1e8ea` → `68fa0ce0` at unchanged `version: 4`) becomes the hash spec below. **Land last
of the four** — item 4 of this issue is #1811's subject and is fixed there.

## Problem

Four items in the body; **two are live, one is already closed on master, one belongs to #1811.**

1. **Live.** `installSkill` (`src/server/integrations/apply.ts`) is `mkdir` + a bare
   `atomicWrite(SKILL_CONTENT, skillPath)` with no comparison. Its sibling
   `refreshExistingSkillIfStale` compares `readSkillVersion(on-disk)` against
   `BUNDLED_SKILL_VERSION` and writes only when the bundle is newer. So an **older** npm
   `tandem setup --apply` — which doctor prescribes for several conditions — silently downgrades
   a newer installed skill, and overwrites a hand-edited one. This is not theoretical: the
   `deps.installSkill` seam added by #1894 exists because the api-routes suite had downgraded the
   operator's v15 install to v14 three times in one night.
2. **Already closed on master, measured, not re-fixed.** `.claude-plugin/plugin.json` is at
   `0.25.0` = `package.json`'s `0.25.0`; `.claude/skills/release/SKILL.md` §"The six version
   surfaces" item 2 already enumerates all **five** plugin.json values including the four
   `tandem-editor@<version>` npx pins; `tests/plugin-manifest.test.ts:26` pins
   `plugin.version === pkg.version` and `:55-56` / `:110` derive every npx spec from `pkg.version`;
   `tests/plugin/plugin-version-pin.test.ts` is the dedicated drift guard. The release step and
   the wiring test the track file asks for both exist — **add nothing.** What remains is the
   *user's installed copy*: a plugin installed at 0.24.1 keeps pinning 0.24.1 until reinstalled,
   which no repo-side guard can move. Recorded under `bryan`, not fixed here.
3. **Live.** `tests/skill-instruction-contract.test.ts` pins the frontmatter `version` number
   only, so a content-only edit at an unchanged version is invisible — the exact miss that made
   v0.20.0/v0.20.1 never reach upgraders (the refresh gate is version-keyed).
4. Double toolset — **#1811**, not here.

`docs/cli.md:19` also states the skill is "idempotent — refreshed on every run", which item 1
makes false in the safe direction and this fix makes false in the current wording.

## Fix

- **`src/server/integrations/apply.ts`, `installSkill`.** Model: `refreshExistingSkillIfStale`,
  reusing its `readSkillVersion` and `BUNDLED_SKILL_VERSION` — one comparison rule, not a second
  copy. Keep `assertPathSafe` and `mkdir` exactly as they are. Between `mkdir` and the write:
  `readFile(skillPath, "utf8")`; if it resolves and
  `BUNDLED_SKILL_VERSION !== 0 && readSkillVersion(current) >= BUNDLED_SKILL_VERSION`, return
  without writing. `ENOENT` → write (this is the **create** path — that is the one thing it must
  not inherit from the refresher, which returns early on a missing file so generic server startup
  never installs a standalone copy). Any other read error → write, preserving today's behaviour
  for the consent-bearing installer. `BUNDLED_SKILL_VERSION === 0` → write, again unlike the
  refresher: an unstamped bundle cannot be compared, and this call site has explicit user consent.
  Exactly **one** `atomicWrite` call site survives — `tests/docs/config-writer-set-claims.test.ts`
  derives the accepted-writer set by call-site count, so adding a second would widen #1599's bound.
- **Return `SkillInstallResult`**: `{ written: true } | { written: false; reason: "newer-on-disk";
  onDiskVersion: number; bundledVersion: number }` (was `Promise<void>`), so the silent no-op is
  reportable. `src/cli/setup.ts` prints `✓ ~/.claude/skills/tandem/SKILL.md` on a write and
  `⚠ kept the installed skill (v<n> on disk is newer than this install's v<m>) — upgrade Tandem
  to move it` otherwise. Read it defensively (`result?.written === false`): the existing
  `vi.fn()` mocks in `tests/cli/run-setup-apply.test.ts` resolve `undefined`, and those mocks are
  updated in the same commit rather than relied on.
- **`src/server/integrations/api-routes.ts` is unchanged.** It calls
  `await (deps.installSkill ?? installSkill)()` and ignores the value; the response must keep
  echoing nothing about the skill, and the `typeof installSkill` seam type follows automatically.
  **Keep the #1894 seam** — no test may reach the real `~/.claude/skills/tandem/SKILL.md`.
- **`tests/skill-instruction-contract.test.ts`**: one new spec pinning a single object literal
  `{ version: <the number already pinned in this file>, bodyHash: "<sha256 of the body, first 12
  hex>" }` — `createHash("sha256")` over the text **after** the closing `---` of the frontmatter,
  with `\r\n` normalised to `\n` first (this repo has a documented CRLF-staleness hazard; a
  checkout artefact must not red the suite). Excluding the frontmatter is deliberate: a version
  bump alone then does not churn the hash, so the loud case is precisely "body changed, version
  did not". The failure message names the required move: *bump `version:` in
  `skills/tandem/SKILL.md` and update both literals together*. **Honest limit, state it in the
  comment and the PR body:** this forces a deliberate edit at the exact spot that says what to do;
  it cannot mechanically prove the bump happened, because nothing in the working tree remembers
  the previous body. It converts a silent miss into a red test, which is what the taken decision
  asks for.
- **`skills/tandem/SKILL.md` is NOT edited** (`skill: false` for this group), so its `version`
  literal does not move and the new hash is computed from HEAD's content.
- **`docs/cli.md:19`**: replace "(idempotent — refreshed on every run)" with "(installed if
  absent, and refreshed only when this install's skill is newer — a newer or hand-edited installed
  skill is kept)". The `CLAUDE.md:273` conflation the issue also names no longer exists at HEAD
  (`grep -n installSkill CLAUDE.md` is empty) — nothing to change there.

## Tests

`tests/cli/setup.test.ts`'s existing `describe("installSkill")` (scratch `homeOverride` tmpdir —
**never the real home**):

1. On-disk `version: 999` → the file is **byte-identical** afterwards and the result is
   `{ written: false, reason: "newer-on-disk" }`. The single spec that kills the bare
   `atomicWrite`; assert the bytes, not just the return value, so a fix that computes the verdict
   and writes anyway still fails.
2. On-disk `version: 1` → overwritten with `SKILL_CONTENT`, `{ written: true }`.
3. On-disk equal to `BUNDLED_SKILL_VERSION` → not written (the `>=`, not `>`, boundary).
4. No file → written (kills copying the refresher's ENOENT early-return into the create path).
5. The existing "overwrites existing file on re-run" spec (`"old content"`, no frontmatter →
   version 0) must stay green — an unversioned file is still upgraded.
6. `tests/cli/run-setup-apply.test.ts`: the `installSkill` mock resolves `{ written: true }`; add
   a case where it resolves `{ written: false, … }` and `applySetup` still completes and prints
   the kept-skill line (kills a caller that dereferences the result unguarded).
7. `tests/skill-instruction-contract.test.ts`: the hash spec itself. Mutation check for the PR
   body — appending one line to a scratch copy of the body flips it red while the `version`
   assertion stays green.

## Done when

An older `setup --apply` cannot downgrade a newer installed skill and says so; one `atomicWrite`
site remains in `installSkill`; a body-only skill edit reds `skill-instruction-contract`;
`docs/cli.md` matches the behaviour; item 2's measurement is in the PR body with its citations;
typecheck + the CLI, plugin and root suites green.

## Not in scope

Moving the plugin's npx pin to `latest` (rejected by `plugin-manifest.test.ts`'s pinned-spec
assertion and its stale-global rationale) or a doctor check for an *installed* plugin whose pin
lags the running version — `bryan`. Hashing the bundled content into the frontmatter. Any change
to `refreshExistingSkillIfStale`. #1790 item 4 (→ #1811).
