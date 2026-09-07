# F-doctor — #1790 skill and plugin version skew

Branch `fix/doctor-and-skill-version-skew-1806`. Closes #1790. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/upgrade-path.md:17-18` and
`areas/skill-plugin.md:21`. The `[ran]` experiment for the skill-content row (per-tag `curl` +
md5, `55d1e8ea` → `68fa0ce0` at unchanged `version: 4`) becomes the hash spec below. **Land last
of the four** — item 4 of this issue is #1811's subject and is fixed there.

## Problem

Four items in the body; **two are live, one is already closed on master, one belongs to #1811.**

1. **Live.** `installSkill` (`src/server/integrations/apply.ts:2065-2071`) is `mkdir` + a bare
   `atomicWrite(SKILL_CONTENT, skillPath)` with no comparison. Its sibling
   `refreshExistingSkillIfStale` compares `readSkillVersion(on-disk)` against
   `BUNDLED_SKILL_VERSION` and writes only when the bundle is newer. So an **older** npm
   `tandem setup --apply` — which doctor prescribes for several conditions — silently downgrades
   a newer installed skill. This is not theoretical: the `deps.installSkill` seam added by #1894
   exists because the api-routes suite had downgraded the operator's v15 install to v14 three
   times in one night.
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

- **`src/server/integrations/apply.ts`, `installSkill`.** Signature becomes
  `installSkill(opts: { homeOverride?: string; force?: boolean } = {})`. Model:
  `refreshExistingSkillIfStale`, reusing its `readSkillVersion` and `BUNDLED_SKILL_VERSION` — one
  comparison rule, not a second copy. Keep `assertPathSafe` and `mkdir` exactly as they are.
  Between `mkdir` and the write: `readFile(skillPath, "utf8")`; if it resolves and
  `!opts.force && BUNDLED_SKILL_VERSION !== 0 && readSkillVersion(current) > BUNDLED_SKILL_VERSION`,
  return without writing. `ENOENT` → write (this is the **create** path — that is the one thing it
  must not inherit from the refresher, which returns early on a missing file so generic server
  startup never installs a standalone copy). Any other read error → write, preserving today's
  behaviour for the consent-bearing installer. `BUNDLED_SKILL_VERSION === 0` → write, again unlike
  the refresher: an unstamped bundle cannot be compared, and this call site has explicit user
  consent. Exactly **one** `atomicWrite` call site survives — `tests/docs/config-writer-set-claims.test.ts`
  derives the accepted-writer set by call-site count, so adding a second would widen #1599's bound.

- **Strictly `>`, not `>=`, and the difference is the whole safety story.**
  `refreshExistingSkillIfStale` uses `>=` (`apply.ts:2156`) because it is the *silent background*
  refresher whose own header (`:2112`) says "The wizard-driven `installSkill()` remains the
  authoritative, consent-bearing installer" — its at-equal preservation is pinned by
  `tests/server/integrations/refresh-skill.test.ts:102-113`. Collapsing the two would break the
  installer in two ways at once, both hitting the *common* case: `skills/tandem/SKILL.md:3` is
  `version: 15`, so **equal is what almost every run is**. A user on 0.25.0 who re-runs
  `setup --apply` — which `setupApplyRemedy` (`src/cli/doctor.ts:1302`) prescribes for many
  conditions — would be told "v15 on disk is newer than this install's v15" and sent to upgrade an
  install that is already current: a warning the user cannot clear, which
  `src/cli/doctor.ts:1938` names as the thing that teaches people to ignore a section. And
  `setup --apply` would lose the ability to restore a hand-mangled `SKILL.md` that still carries
  `version: 15`, which is today's repair path. With `>`, equality rewrites, idempotent repair
  survives, and the `⚠` line below is only ever printed when it is true.

- **`--force` is the escape hatch for a strictly-newer stamp.** `applySetup` passes the flag it
  already parses: `await installSkill({ force: opts.force })` (`SetupOptions.force` exists at
  `src/cli/setup.ts:69` and today reaches only `detectTargets`; `--force` already means "write
  anyway", and the help text at `:100` already says "Honors --force"). Without it a
  hand-edited or tampered file stamped `version: 999` would make the skill **permanently
  un-repairable by the product** — `refreshExistingSkillIfStale` already skips it (`:2156`) and
  `installSkill` would now skip it too, leaving nothing that can replace behavioural instruction
  loaded into every user session. Note the overload in the code comment so it is not read as a
  detection-only flag.

- **`src/server/integrations/api-routes.ts` deliberately passes no `force`.** Line 1008 stays
  `await (deps.installSkill ?? installSkill)()`, so the wizard defaults to `force: false` — same
  doctrine as the absent request-body `homeOverride` (`apply.ts:2060-2064`, `api-routes.ts:151-159`):
  an HTTP request must not be able to demand an overwrite. State the honest limit in the PR body —
  the wizard cannot repair a `version: 999` file, and the CLI `--force` (or deleting the file) is
  the documented way. The response keeps echoing nothing about the skill, and the seam type stays
  `typeof installSkill`.

- **Return `SkillInstallResult`**: `{ written: true } | { written: false; reason: "newer-on-disk";
  onDiskVersion: number; bundledVersion: number }` (was `Promise<void>`), so the silent no-op is
  reportable. `src/cli/setup.ts:178-183` prints `✓ ~/.claude/skills/tandem/SKILL.md` on a write and,
  otherwise:

  > `⚠ kept the installed skill (v<n> on disk is newer than this install's v<m>) — re-run with
  > --force to overwrite it, or delete ~/.claude/skills/tandem/SKILL.md and re-run`

  **The remedy must name `--force`, not "upgrade Tandem to move it".** No Tandem version moves a
  file stamped `version: 999`; that sentence would be a dead-end fix line of exactly the kind
  `src/cli/doctor.ts:1345-1360` records the doctrine against. Read the result defensively
  (`result?.written === false`): the existing `vi.fn()` mocks in
  `tests/cli/run-setup-apply.test.ts` resolve `undefined`, and those mocks are updated in the same
  commit rather than relied on.

- **Both `installSkill` mock sites move in the same commit, because the return-type change is a
  `typecheck:tests` failure — a step inside the required `check` job, not a runtime one:**
  - `tests/cli/run-setup-apply.test.ts:13-30` — the `vi.fn()` in the `apply.js` mock factory,
    plus a spec whose mock resolves `{ written: false, … }`.
  - `tests/server/integrations/api-routes.test.ts:163` — the annotation
    `let installSkillSpy: ReturnType<typeof vi.fn<() => Promise<void>>>` — and `:168`, the
    `vi.fn(async () => {})` assigned into `deps.installSkill` at `:170`. Both become
    `Promise<SkillInstallResult>` / `vi.fn(async () => ({ written: true }) as SkillInstallResult)`.
    **Do NOT widen the seam type at `api-routes.ts:159` to `() => Promise<unknown>` to silence
    this** — that erases the #1894 seam's type contract, which is the thing keeping the real
    `~/.claude/skills/tandem/SKILL.md` out of the suite.

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
  absent, and re-written unless the installed copy is stamped with a newer version — use
  `--force` to overwrite that)". The `CLAUDE.md:273` conflation the issue also names no longer
  exists at HEAD (`grep -n installSkill CLAUDE.md` is empty) — nothing to change there.

## Tests

`tests/cli/setup.test.ts`'s existing `describe("installSkill")` (scratch `homeOverride` tmpdir —
**never the real home**):

1. On-disk `version: 999` → the file is **byte-identical** afterwards and the result is
   `{ written: false, reason: "newer-on-disk" }`. The single spec that kills the bare
   `atomicWrite`; assert the bytes, not just the return value, so a fix that computes the verdict
   and writes anyway still fails.
2. On-disk `version: 1` → overwritten with `SKILL_CONTENT`, `{ written: true }`.
3. **On-disk equal to `BUNDLED_SKILL_VERSION` → IS rewritten**, `{ written: true }` — the `>`,
   not `>=`, boundary. Write a mangled body carrying the current `version:` line and assert the
   file comes back as `SKILL_CONTENT`: this is the idempotent-repair case that `>=` would break,
   and it is the boundary a "consistency" refactor toward the refresher's `>=` would flip.
4. On-disk `version: 999` **with `{ force: true }`** → overwritten, `{ written: true }`. Kills a
   comparison with no escape hatch, which would make a tampered stamp permanently un-repairable.
5. No file → written (kills copying the refresher's ENOENT early-return into the create path).
6. The existing "overwrites existing file on re-run" spec (`"old content"`, no frontmatter →
   version 0) must stay green — an unversioned file is still upgraded.
7. `tests/cli/run-setup-apply.test.ts`: the `installSkill` mock resolves `{ written: true }`; add
   a case where it resolves `{ written: false, … }` and `applySetup` still completes and prints
   the kept-skill line (kills a caller that dereferences the result unguarded), and assert that
   line names `--force` rather than "upgrade". Add a spec that `runSetup({ apply: true, force:
   true })` calls the `installSkill` mock with `{ force: true }` — the only thing that pins the
   flag is actually threaded.
8. `tests/server/integrations/api-routes.test.ts`: the retyped spy, per the Fix. No behaviour
   change asserted — the route still echoes nothing about the skill.
9. `tests/skill-instruction-contract.test.ts`: the hash spec itself. Mutation check for the PR
   body — appending one line to a scratch copy of the body flips it red while the `version`
   assertion stays green.

## Done when

An older `setup --apply` cannot downgrade a newer installed skill and says so with a remedy that
works; a re-run at the same version still rewrites the file; `--force` overwrites a newer stamp;
one `atomicWrite` site remains in `installSkill`; a body-only skill edit reds
`skill-instruction-contract`; item 2's measurement is in the PR body with its citations;
`npm run typecheck:tests` green (the return-type change touches two mock sites); typecheck + the
CLI, plugin and root suites green.

## Not in scope

Moving the plugin's npx pin to `latest` (rejected by `plugin-manifest.test.ts`'s pinned-spec
assertion and its stale-global rationale) or a doctor check for an *installed* plugin whose pin
lags the running version — `bryan`. Hashing the bundled content into the frontmatter. Any change
to `refreshExistingSkillIfStale`. A `force` parameter on the apply HTTP route. #1790 item 4
(→ #1811).

## Files touched

`src/server/integrations/apply.ts`, `src/cli/setup.ts`, `docs/cli.md`,
`tests/cli/setup.test.ts`, `tests/cli/run-setup-apply.test.ts`,
`tests/server/integrations/api-routes.test.ts`, `tests/skill-instruction-contract.test.ts`.

## Review corrections (round 1)

**Adopted**

- *`>=` plus the "newer than" wording turns every healthy re-run into a false warning and removes
  the repair path for a corrupted-but-current skill.* The skip is now strictly `>`; the Fix
  carries a paragraph on why the refresher's `>=` must not be copied (`version: 15` makes *equal*
  the common case, and `>=` would print an unclearable warning and block idempotent repair). Test
  3 is repointed to assert the opposite of the old spec: on-disk **equal** IS rewritten, with the
  `version: 999` case kept as the skip.
- *No escape hatch, so a tampered `version: 999` becomes permanently un-repairable.* `installSkill`
  gains `force?: boolean`; `applySetup` passes the `--force` it already parses; new test 4 pins the
  bypass, and test 7 pins that the flag is actually threaded. The wizard route deliberately keeps
  `force: false` (no request-body force, mirroring the absent request-body `homeOverride`), and the
  PR body states that limit.
- *"upgrade Tandem to move it" is a dead-end remedy.* The kept-skill line now names `--force` or
  deleting the file, with the `doctor.ts:1345-1360` doctrine cited; test 7 asserts the wording.
- *The return-type change breaks a second mock the spec did not name, and it fails
  `typecheck:tests` inside the required `check` job* (raised three times). Both sites are now
  enumerated — `run-setup-apply.test.ts:13-30` and `api-routes.test.ts:163,168` — with an explicit
  prohibition on widening the seam type at `api-routes.ts:159` to silence the error. Added to
  Tests, Done when, and Files touched.

**Not adopted**

- *Add a one-assertion pin for the `docs/cli.md` wording.* The Done-when claim "`docs/cli.md`
  matches the behaviour" is **dropped** instead — nothing in `tests/docs/` covers `docs/cli.md`
  today, and standing up a new suite file for a single `not.toMatch(/refreshed on every run/)` on a
  prose line exceeds this wave's minimal-fix bar (a spec over ~120 lines is the stated smell). The
  doc edit stays in the Fix as an uncheckable but reviewed change; if `docs/cli.md` later earns a
  claims suite, this line is the first thing to put in it.
