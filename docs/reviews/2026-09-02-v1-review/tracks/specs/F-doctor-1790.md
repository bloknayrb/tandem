# F-doctor — #1790 skill and plugin version skew

Branch `fix/doctor-and-skill-version-skew-1806`. Closes #1790. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/upgrade-path.md:17-18` and `areas/skill-plugin.md:21`.
The `[ran]` experiment for the skill-content row (per-tag `curl` + md5, `55d1e8ea` → `68fa0ce0` at
unchanged `version: 4`) becomes the hash spec below. **Land last of the four.**

## Problem

Four items in the body; **two are live, one is already closed on master, one belongs to #1811.**

1. **Live.** `installSkill` (`src/server/integrations/apply.ts:2065-2071`) is `mkdir` + a bare
   `atomicWrite(SKILL_CONTENT, skillPath)` with no comparison, while its sibling
   `refreshExistingSkillIfStale` compares `readSkillVersion(on-disk)` against
   `BUNDLED_SKILL_VERSION` (`:2156`). So an **older** npm `tandem setup --apply` — which doctor
   prescribes for several conditions — silently downgrades a newer installed skill. Not
   theoretical: #1894's `deps.installSkill` seam exists because the api-routes suite downgraded the
   operator's v15 install to v14 three times in one night.
2. **Already closed on master — measured, not re-fixed.** `plugin.json` is `0.25.0` =
   `package.json`'s; `.claude/skills/release/SKILL.md` §"The six version surfaces" item 2
   enumerates all five plugin.json values including the four npx pins; `plugin-manifest.test.ts:26`
   pins `plugin.version === pkg.version` and `:55-56`/`:110` derive every npx spec from
   `pkg.version`; `tests/plugin/plugin-version-pin.test.ts` is the dedicated drift guard. The
   release step and wiring test the track file asks for both exist — **add nothing.** Only the
   *user's installed copy* remains, which no repo-side guard moves (`bryan`).
3. **Live.** `tests/skill-instruction-contract.test.ts` pins the frontmatter `version` number only
   (`:80`), so a content-only edit at an unchanged version is invisible — the miss that made
   v0.20.0/v0.20.1 never reach upgraders, since the refresh gate is version-keyed.
4. Double toolset — **#1811**, not here.

`docs/cli.md:19` also calls the install "idempotent — refreshed on every run", which item 1 makes
false in the safe direction and this fix makes false in the current wording.

## Fix

- **`installSkill` compares before writing.** Keep `assertPathSafe` and `mkdir` as they are.
  Between `mkdir` and the write: `readFile(skillPath, "utf8")`; if it resolves and
  `BUNDLED_SKILL_VERSION !== 0 && readSkillVersion(current) > BUNDLED_SKILL_VERSION`, return
  without writing. Reuse `readSkillVersion` and `BUNDLED_SKILL_VERSION` — one comparison rule, not
  a second copy. **`ENOENT` → write**: this is the *create* path, the one thing it must not inherit
  from the refresher, which returns early on a missing file so generic server startup never
  installs a standalone copy. Any other read error → write, preserving today's behaviour for the
  consent-bearing installer; `BUNDLED_SKILL_VERSION === 0` → write, since an unstamped bundle
  cannot be compared. **Exactly one `atomicWrite` call site survives** —
  `tests/docs/config-writer-set-claims.test.ts` derives the accepted-writer set by call-site count,
  so a second would widen #1599's bound.

- **Strictly `>`, not `>=`.** The refresher's `>=` (`:2156`) belongs to the *silent background*
  path, whose header (`:2112`) says `installSkill()` "remains the authoritative, consent-bearing
  installer"; its at-equal preservation is pinned by `refresh-skill.test.ts:102-113`. Since
  `skills/tandem/SKILL.md:3` is `version: 15`, **equal is what almost every run is**: `>=` would
  tell a current user that v15 is newer than v15 and send them to upgrade an already-current
  install — an unclearable warning of the kind `src/cli/doctor.ts:1938` names — and would remove
  today's repair path for a hand-mangled `SKILL.md` that still carries `version: 15`.

- **Return `Promise<SkillInstallResult>`** (was `Promise<void>`) so the no-op is reportable:
  `{ written: true } | { written: false; onDiskVersion: number; bundledVersion: number }`, exported
  as a **type** — it is the return half of #1894's seam contract (`api-routes.ts:159`). Do not
  export `readSkillVersion` or `BUNDLED_SKILL_VERSION`, and do not widen the seam type to
  `() => Promise<unknown>` to silence the retype: that erases the contract keeping the real
  `~/.claude/skills/tandem/SKILL.md` out of the suite. `api-routes.ts:1008` is unchanged and the
  route still echoes nothing about the skill.

- **`src/cli/setup.ts:178-183`** keeps `✓ ~/.claude/skills/tandem/SKILL.md` on a write and
  otherwise prints (`if (!result.written)` — the result is non-nullable, so the optional chain the
  first draft carried was dead weight and `/simplify` removed it): *`⚠ kept the
  installed skill (v<n> on disk is newer than this install's v<m>) — delete
  ~/.claude/skills/tandem/SKILL.md and re-run to replace it`*. **The remedy names deleting the
  file, never "upgrade Tandem to move it"** — no Tandem version moves a `version: 999` file, so
  that would be a dead-end fix line of the kind `src/cli/doctor.ts:1345-1360` argues against.

- **Both mock sites move in the same commit** — the retype fails `typecheck:tests`, a step inside
  the required `check` job: `tests/cli/run-setup-apply.test.ts:13-30` (the factory's `vi.fn()`) and
  **`:73`**, the per-test `mockResolvedValue(undefined)` → `mockResolvedValue({ written: true })`;
  `tests/server/integrations/api-routes.test.ts:163` (the `Promise<void>` annotation) and `:168`.

- **Two references stay unchanged, so neither is "tidied":**
  `tests/server/document-write-rearm.test.ts:225-231` is a census row (`count: 1, rearm: "n/a"`)
  asserted by exact equality at `:404` — still true, since the early return adds no write;
  `refresh-skill.test.ts:104` calls `installSkill({ homeOverride })` as setup and still writes,
  because no file exists there (the ENOENT create path).

- **`tests/skill-instruction-contract.test.ts`** gains one spec pinning `{ version: 15, bodyHash:
  "<first 12 hex of sha256>" }`. **15** is the number this file already pins at `:80`, matching
  `skills/tandem/SKILL.md:3` — the sweep doc's environment table still says 14, but J1 landed the
  bump; read the file. The hash covers the text **after** the frontmatter's closing `---`, with
  `\r\n` normalised to `\n` first (this repo's CRLF-staleness hazard must not red the suite).
  Excluding the frontmatter is deliberate: a version bump alone does not churn the hash, so the
  loud case is exactly "body changed, version did not". The failure message names the move — bump
  `version:` and update both literals together. **Honest limit** (comment + PR body): it forces a
  deliberate edit at the spot that says what to do; it cannot prove the bump happened.

  **This group is therefore NOT file-disjoint from group C.** That literal shares the file with
  every skill-bumping group, and the wave-3 table pairs F-doctor with C on a stated
  file-disjointness precondition (`docs/plans/2026-09-06-open-issues-sweep.md:67`; C's row carries
  a skill bump). So **F-doctor lands before C**, and C's spec and ledger row are told to update
  `bodyHash` alongside `version` in the same commit.

- **`skills/tandem/SKILL.md` is NOT edited** (`skill: false`), so the hash comes from HEAD.
- **`docs/cli.md:19`**: "(idempotent — refreshed on every run)" → "(installed if absent, and
  re-written unless the installed copy is stamped with a newer version)". The `CLAUDE.md:273`
  conflation the issue names no longer exists at HEAD (`grep -n installSkill CLAUDE.md` is empty).

## Tests

`tests/cli/setup.test.ts`'s existing `describe("installSkill")` (scratch `homeOverride` tmpdir —
**never the real home**):

1. On-disk `version: 999` → the file is **byte-identical** afterwards and the result is
   `{ written: false, onDiskVersion: 999, bundledVersion: <n> }`. Assert the bytes, not just the
   return value, so a fix that computes the verdict and writes anyway still fails.
2. On-disk `version: 1` → overwritten with `SKILL_CONTENT`, `{ written: true }`.
3. **On-disk equal to the bundled version → IS rewritten** — the `>`, not `>=`, boundary and the
   idempotent-repair case. Write a mangled body carrying the current `version:` line, assert the
   file comes back as `SKILL_CONTENT`. **Derive that number from the exported `SKILL_CONTENT`**
   (`src/cli/skill-content.ts:20`) with the four-line local `readSkillVersion` copy the precedent
   already uses (`refresh-skill.test.ts:69`) — no new export from `apply.ts` for a test.
4. No file → written (kills copying the refresher's ENOENT early return into the create path).
5. The existing "overwrites existing file on re-run" spec (no frontmatter → version 0) stays green.
6. `tests/cli/run-setup-apply.test.ts`: the default mock resolves `{ written: true }`; one spec
   where it resolves `{ written: false, … }` → `applySetup` still completes and prints the
   kept-skill line naming deletion (kills a caller that dereferences the result unguarded).
7. `tests/server/integrations/api-routes.test.ts`: the retyped spy. No behaviour change asserted.
8. `tests/skill-instruction-contract.test.ts`: the hash spec. Mutation check for the PR body —
   appending a line to a scratch copy of the body reds it while the `version` assertion stays green.

## Done when

An older `setup --apply` cannot downgrade a newer installed skill and says so with a remedy that
works; a re-run at the same version still rewrites; one `atomicWrite` site remains and
`document-write-rearm.test.ts`'s census row is untouched; a body-only skill edit reds
`skill-instruction-contract`; item 2's measurement is in the PR body with its citations;
`npm run typecheck:tests`, typecheck and the CLI, plugin and root suites green.

## Not in scope

Moving the plugin's npx pin to `latest` (rejected by `plugin-manifest.test.ts`). Hashing the
bundled content into the frontmatter. Any change to `refreshExistingSkillIfStale`. Item 4 (→ #1811).

## For Bryan

- A plugin installed at 0.24.1 keeps pinning `tandem-editor@0.24.1` until reinstalled; no repo-side
  guard moves a user's installed copy, and a doctor check for it is a new surface.
- The wizard route cannot repair a `SKILL.md` stamped `version: 999`; deleting the file and
  re-running is the remedy, and `setup --apply` is the surface that says so.

## Files touched

`src/server/integrations/apply.ts`, `src/cli/setup.ts`, `docs/cli.md`, `tests/cli/setup.test.ts`,
`tests/cli/run-setup-apply.test.ts`, `tests/server/integrations/api-routes.test.ts`,
`tests/skill-instruction-contract.test.ts`.

## Review corrections (scope cut)

**Removed**

- *The `force` escape hatch and everything it dragged in* — `installSkill({ force })`, the
  `--force` overload analysis, the `overwroteNewer`/`onDiskVersion`/`bundledVersion` success
  fields, setup's second `⚠` line, and the two force specs. The issue asks for a version
  comparison; the escape hatch it needs is "delete the file and re-run", which the kept-skill line
  prints and which no flag semantics can silently misfire.
- *The `console.error` trace inside `installSkill`*, and the spy spec that kept it alive. The spec
  itself conceded it reaches the sidecar log, not the desktop user; the user-visible surface
  (`setup --apply`) still prints the skip.
- *The three round-by-round correction logs.*

**Kept**

The comparison with strict `>`; the ENOENT/create and unstamped-bundle carve-outs; the
single-`atomicWrite` constraint; the two named mock sites; the two deliberately-unchanged
references; the `bodyHash` spec — issue item 3 — carrying the outstanding finding's fix in full
(literal is 15, not the sweep doc's stale 14; this group is not file-disjoint from C, lands first,
and C updates both literals together).
