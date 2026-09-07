# F-doctor — #1811 plugin + `tandem setup --apply` loads the `tandem_*` toolset twice

Branch `fix/doctor-and-skill-version-skew-1806`. Closes #1811. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/skill-plugin.md:26`. No experiment (`[read]` row).
Overlaps #1790 item 4 — the same condition, filed twice.

## Problem

**One of the issue's two halves is refuted by the source, and the spec says so rather than
re-fixing it.** The cited `doctor.ts:1842-1845` at the review baseline `3fb6408` are the *doc
comment* on `checkTandemPlugin` ("2. The plugin's MCP servers duplicate the ones setup writes"),
not an emitter. The emitter is `evaluateTandemPlugin`'s second outcome, present unchanged at
`3fb6408`: `status: "warn"`, message *"Both the Tandem plugin and a tandem MCP entry in
~/.claude.json are present — the tandem_* tools will appear twice"*, `fix` naming the remedy
`claude plugin uninstall ${installedKey}` with the key it actually found. So **doctor already
detects the condition and already names the remedy.** Verified by `git show
3fb6408:src/cli/doctor.ts | sed -n '1899,1912p'`.

What is genuinely missing is the other half: **`tandem setup --apply` says nothing.** It detects
targets, writes the `~/.claude.json` MCP entry and installs the skill without ever looking at
`~/.claude/settings.json`, so the command that *creates* the duplication is the one surface that
never mentions it. That is the fix here, and it is the shape the track file records
(`F-push-paths-and-cli.md:22`: "`setup --apply` warns when the plugin is installed").

## Fix

- **New shared leaf `src/shared/integrations/tandem-plugin.ts`** (~35 lines), sibling of the
  existing `client-config-paths.ts` — whose own doctrine comment ("Path from the shared leaf, so
  doctor inspects the file `detectTargets` writes rather than a second hand-maintained copy of the
  same rule") is the precedent for putting the predicate in one place instead of duplicating it:
  - `findEnabledTandemPluginKey(enabledPlugins: Record<string, unknown> | null | undefined): string | null`
    — pure; the predicate lifted verbatim from `evaluateTandemPlugin`:
    `key.startsWith("tandem@") && value === true`. **Test the value, not truthiness** — `false` is
    a deliberately disabled plugin — and match any marketplace suffix, because
    `docs/spikes/plugin-delivery.md` recommends a local one and a hardcoded
    `tandem@tandem-editor` in a remedy hands those users a command that errors.
  - `detectEnabledTandemPlugin(opts: { homeOverride?: string } = {}): string | null`.

    **Home resolution is pinned, because the production call site passes no argument and the
    two spellings in this repo do not agree.** Use

    ```
    const home = opts.homeOverride || process.env.HOME || process.env.USERPROFILE || homedir();
    if (!home) return null;
    ```

    **`||` and the explicit empty-home return, not `??`** — the two cited sites are
    `const home = process.env.HOME || process.env.USERPROFILE || "";` followed by `if (!home)
    return;` (`checkTandemPlugin`, `src/cli/doctor.ts:1972-1973`; `checkUserMcpConfig` at `:1106`
    passes `home || undefined` so `claudeCodeConfigPath` falls back to `homedir()`). `""` is not
    nullish, so under `??` an empty `HOME` *wins* the chain, and the UNC screen below cannot catch
    it: `homeIsUnsafe` is `home !== "" && rejectUnsafeWindowsPrefix(home) !== null`
    (`src/cli/doctor.ts:681-683`), false for `""` **by construction** — which is exactly why
    doctor pairs it with `if (!home) return`. The consequence is not abstract:
    `join("", ".claude", "settings.json")` is **cwd-relative**, so `tandem setup --apply` run
    inside any checkout would read *that repo's* `.claude/settings.json` — a file that exists in
    this repo — and interpolate one of its JSON keys into the
    `claude plugin uninstall <key>` command printed to the operator.

    `apply.ts`'s siblings (`:754`, `:2066`, `:2127`) use `opts.homeOverride ?? homedir()`, and
    `homedir()` reads `USERPROFILE` on Windows and ignores `HOME` — so a test that stubs `HOME`
    alone would silently read the operator's real profile on the platform this wave runs on.
    Writing the env reads explicitly is what makes both stubs work.

    **Two UNC screens, not one — the derived path alone is not enough, and neither is the raw
    value alone.** Screen the raw `home` value **before** any `join`, in `homeIsUnsafe`'s shape
    (`home !== "" && rejectUnsafeWindowsPrefix(home) !== null` — `rejectUnsafeWindowsPrefix` from
    `src/shared/windows-path-safety.ts`); then, after resolving
    `<home>/.claude/settings.json`, run **a second explicit screen in the leaf**:
    `if (rejectUnsafeWindowsPrefix(settingsPath) !== null) return null;` immediately before the
    `readFileSync`. The round-1 text said "let the read's own screen stand as a backstop" — the
    leaf's reader **has** no screen (that backstop belongs to `readClaudeConfig`,
    `src/cli/doctor.ts:607`, which the layering rules out below), so shipping that sentence would
    assert a control that is not in the code: #1417's own drift class. The measured POSIX case it
    is there for is at `src/cli/doctor.ts:654-684`: a `$HOME` of a single backslash passes the raw
    screen and derives `\/.claude/settings.json`.

    That same block records the measurement the **raw**-value screen comes from, which is the
    half a derived-path-only guard misses: of the fourteen spellings in
    `tests/helpers/unc-fixtures.ts`, four pure
    forward-slash forms "collapse to a path this guard then accepts once `path.posix.join` has
    run". A derived-path-only screen therefore passes those rows on ubuntu — the only platform
    `check` runs — *because the path stopped being dangerous, not because anything screened it*:
    the #1529 shape, a non-discriminating test that reads exactly like a pass. #1417 is the
    underlying rule (reading a UNC path performs the SMB handshake that leaks an NTLM hash), so
    the screen must precede the read, not wrap it.

    Then `readFileSync` + `JSON.parse` inside a total `try/catch`, returning
    `findEnabledTandemPluginKey(parsed.enabledPlugins)`. Every failure → `null`: absence is not
    evidence, and this must never make `setup --apply` fail.

    **On the unfenced-reader fence.** `tests/cli/doctor-path-safety.test.ts:694-717` keeps the
    unfenced `readJson` away from Claude configs, and it reads `src/cli/doctor.ts` only
    (`:695`), so a reader in `src/shared/integrations/` is invisible to it. The leak class it
    guards is structurally absent here — this leaf's whole return type is `string | null`, it
    carries no `reason` field and never surfaces parse detail, which is exactly why
    `readClaudeConfig` exists separately (`src/cli/doctor.ts:595-604`). Reusing
    `readClaudeConfig` is not available: it lives in `src/cli/`, and `src/shared/` importing
    upward inverts the layering. So **extend the fence's scan set instead**: make its `SOURCE`
    the concatenation of `src/cli/doctor.ts` and `src/shared/integrations/tandem-plugin.ts`, so a
    future `readJson(join(home, ".claude", "settings.json"))` added to the leaf reds the fence
    rather than shipping unseen.

    **Label the extension in the fence's comment as forward-looking only, because it cannot fail
    today and must not be read as coverage of the reader this spec adds.** The fence matches
    `readJson(` call sites (`tests/cli/doctor-path-safety.test.ts:696-700`); `readJson` is
    module-private to `doctor.ts` (`src/cli/doctor.ts:514`, no `export`) and the layering rule
    above forbids importing it, so no such call site can exist in the leaf. The leaf reads with
    `readFileSync` + `JSON.parse`, which that regex can never see, and the positive control at
    `:704` stays satisfied by `doctor.ts`'s own sites either way. What actually pins the leaf's
    reader is the explicit `rejectUnsafeWindowsPrefix(settingsPath)` screen above plus the UNC
    table below — not this fence.
- **`src/cli/doctor.ts`:** `evaluateTandemPlugin` calls `findEnabledTandemPluginKey(input.enabledPlugins)`
  in place of its inline `Object.entries(...).find(...)`. One line, no behaviour change — it exists
  so the two surfaces cannot drift. Doctor keeps its own reader, its own `homeIsUnsafe` screen and
  its own reporting; it does **not** import `detectEnabledTandemPlugin`.
- **`src/cli/setup.ts`, `applySetup`:** call `detectEnabledTandemPlugin()` once, immediately before
  `console.error("Detecting Claude installations...")` (`src/cli/setup.ts:116`), and when it
  returns a key print one notice to stderr (setup's whole output is stderr):
  `The Tandem plugin (<key>) is installed and already provides the tandem_* tools. Writing this
  config too makes every tool appear twice — keep one: claude plugin uninstall <key>`.
- **The write still happens.** `--apply` is the scriptable, non-interactive path whose contract is
  "write the config"; silently skipping it would strand a user who later disables the plugin, with
  no output saying why nothing was written. Warn, do not skip. (Assumption; the issue's own
  suggestion offers skipping, the track file's taken shape says warn.)

Rules that bite: **never against the real HOME** — see the Tests section, which pins *how* rather
than only asserting the rule. No config *writer* is added (#1599's bound and
`tests/docs/config-writer-set-claims.test.ts` count durable write sites; this is a read). No new
`/api` route, no MCP tool, no skill edit.

## Tests

The two levels are tested through different seams, and the split is the point: the **leaf's own
behaviour** (home resolution, UNC screen, JSON handling) is unit-tested with an explicit
`homeOverride`; the **`applySetup` wiring** (is it called, is the notice printed, is the write
still made) is tested with the module mocked, so no real filesystem read happens at all.

- `tests/shared/integrations/tandem-plugin.test.ts` (new):
  - `findEnabledTandemPluginKey` returns the key for `{"tandem@tandem-editor": true}`; `null` for
    `{"tandem@x": false}` (kills a truthiness check); `null` for `{"other@y": true}`; `null` for
    `null`/`undefined`/`{}`; returns the key for a non-default marketplace
    `{"tandem@local-marketplace": true}` (kills a hardcoded suffix).
  - `detectEnabledTandemPlugin({ homeOverride })` against a temp home: absent file → `null`;
    malformed JSON → `null` (no throw); `enabledPlugins` present → the key.
  - **Home resolution**, with no `homeOverride`: stub `HOME` to a temp dir carrying the settings
    file → the key; then unstub `HOME`, stub `USERPROFILE` to it → the key. Both stubs, because
    only one of them survives on each platform. `vi.unstubAllEnvs()` in `afterEach`.
  - **Empty home** — the `||`-vs-`??` guard. With **no** `homeOverride` and both `HOME` and
    `USERPROFILE` stubbed to `""`, `detectEnabledTandemPlugin()` returns `null` and the
    `readFileSync` mock is `not.toHaveBeenCalled()`. Under `??` this reds: `""` wins the chain,
    `homeIsUnsafe("")` is false by its own `home !== ""` clause, and the leaf reads a cwd-relative
    `.claude/settings.json`. (`homedir()` must be mocked or the stubs must survive it — assert the
    syscall, which is true either way.)
  - **Derived-path screen** — the second UNC screen. `detectEnabledTandemPlugin({ homeOverride:
    "\\" })` (a single backslash, the measured POSIX case at `src/cli/doctor.ts:654-684`): it
    passes the raw screen and derives an unsafe path, so `readFileSync` must still be
    `not.toHaveBeenCalled()`. This is the only spec that reds if the derived-path screen is
    dropped in favour of the non-existent "backstop".
  - **UNC table, twice — once per input path, because production takes the one the round-1 spec
    did not drive.** `applySetup` calls `detectEnabledTandemPlugin()` with **no argument**, so its
    real input is `process.env.HOME || USERPROFILE || homedir()`. A screen written as
    `if (opts.homeOverride && rejectUnsafeWindowsPrefix(opts.homeOverride))` passes an
    override-only table on all eleven rows while leaving a redirected `%USERPROFILE%` on a share —
    the exact #1417 scenario — completely unscreened. Precedent for treating the env path as a
    distinct guard site: `tests/cli/doctor-path-safety.test.ts:812-826` drives
    `process.env.HOME`/`USERPROFILE` with the corpus separately from the `homeOverride` block at
    `:833-838`, and `:857-860` records that a mutation removing the input screen survived the
    whole suite. So, both driven over `NETWORK_PATHS` from `tests/helpers/unc-fixtures.ts` rather
    than a single `\\\\host\\share` case:
    - `it.each([...NETWORK_PATHS])` → `detectEnabledTandemPlugin({ homeOverride: p })`.
    - `it.each([...NETWORK_PATHS])` → set `process.env.HOME` **and** `process.env.USERPROFILE` to
      the hostile spelling and call `detectEnabledTandemPlugin()` with **no options**.

    For every row of both, **no filesystem call**. Per `unc-fixtures.ts`'s standing rule, assert
    the `readFileSync` spy `not.toHaveBeenCalled()` — asserting the `null` return proves nothing,
    because the unscreened code returns `null` too (the syscall throws).
  - **Mock `node:fs` with `vi.hoisted` + `vi.mock("node:fs", …)`, never `vi.spyOn(fs, …)`.** The
    leaf imports `readFileSync` from `node:fs` directly and an ESM module namespace is not
    configurable, so `vi.spyOn` **throws**. The technique and this exact rationale are documented
    at `tests/cli/doctor-path-safety.test.ts:22-25` (same as
    `tests/server/unc-guard-ordering.test.ts`); copy it.
- `tests/cli/run-setup-apply.test.ts` — **this file, not `setup.test.ts`.** Add
  `vi.mock("../../src/shared/integrations/tandem-plugin.js", …)` alongside the existing
  `apply.js` mock (`:13-30`), stubbing `detectEnabledTandemPlugin`. That file mocks only
  `apply.js` today, so an unmocked call into a *different* module would `readFileSync` the real
  `homedir()/.claude/settings.json` in all four of its existing `runSetup({ apply: true })` specs
  — the #1894 hazard class this group is explicitly told to avoid, and it would make the negative
  specs pass or fail by machine. Specs:
  - stub returns `"tandem@tandem-editor"` → `--apply` prints a notice containing
    `plugin uninstall` **and still calls `applyConfig`** — the second assertion is the
    discriminating one, killing a fix that "helpfully" skips the write.
  - stub returns `null` → no notice (kills a check that fires for every user).

  There is deliberately **no** `applySetup` spec in `tests/cli/setup.test.ts`: nothing there
  drives `runSetup({ apply: true })` today (`:1034`, `:1044` drive `runSetup()` and
  `runSetup({ apply: false, force: true })`), and that file states at `run-setup-apply.test.ts:9-11`
  that it exercises the **real** `apply.js` — so adding an `--apply` driver there would run the
  real `detectTargets`/`applyConfig` against the real home. Do not put the notice specs there.
- `tests/cli/doctor.test.ts`: keep/add a pin that `evaluateTandemPlugin({ enabledPlugins:
  {"tandem@tandem-editor": true}, wizardTandemEntry: true })` still yields the duplication `warn`
  whose `fix` names `claude plugin uninstall tandem@tandem-editor` — the refuted half is a working
  behaviour with no test of its own, and the refactor above touches its key-finding line.
- `tests/cli/doctor-path-safety.test.ts`: extend the unfenced-reader fence's `SOURCE` to include
  the new leaf, per the Fix — **forward-looking only**, and the comment must say so. It cannot
  fail for the reader this spec adds (`readJson` is private to `doctor.ts` and the leaf reads with
  `readFileSync`), so it is not what pins the leaf; the two UNC screens and the tables above are.

## Done when

`setup --apply` on a machine with the plugin installed says so and names the remedy before it
writes; the predicate exists once; the leaf refuses every `NETWORK_PATHS` spelling before any
syscall **through both input paths — `homeOverride` and the env chain production actually
takes**; an empty `HOME` returns `null` rather than reading a cwd-relative `.claude/settings.json`;
no test reads a real home; doctor's existing duplication warn is pinned; typecheck + the CLI and
shared suites green. The PR body records the refutation with the `git show` citation.

## Not in scope

A doctor `--fix` flag (a new CLI surface; not in the taken shape). README / wizard copy (docs
drift is #1821 / the J2 group). Making `setup --apply` skip the MCP write. Anything about the
plugin's own npx pin — that is #1790.

## Files touched

`src/shared/integrations/tandem-plugin.ts` (new), `src/cli/doctor.ts`, `src/cli/setup.ts`,
`tests/shared/integrations/tandem-plugin.test.ts` (new), `tests/cli/run-setup-apply.test.ts`,
`tests/cli/doctor.test.ts`, `tests/cli/doctor-path-safety.test.ts`.

## Review corrections (round 1)

**Adopted**

- *`detectEnabledTandemPlugin()` is called from `applySetup` with no home seam, so the new read
  hits the operator's real `~/.claude/settings.json` in every existing `run-setup-apply` spec and
  the negative specs become machine-dependent* (raised twice). The Tests section now names the
  seam explicitly: add `vi.mock("../../src/shared/integrations/tandem-plugin.js")` alongside the
  existing `apply.js` mock in `tests/cli/run-setup-apply.test.ts`, with the notice specs asserted
  against the stub. The `"(or setup.test.ts, whichever already drives applySetup with a scratch
  home)"` parenthetical is deleted and replaced with a paragraph saying why nothing there does and
  why the specs must not move there.
- *No specified home-resolution order, and `homedir()` ignores `HOME` on Windows.* Pinned to
  `opts.homeOverride ?? process.env.HOME ?? process.env.USERPROFILE ?? homedir()` with the reason
  and the two conflicting in-repo spellings cited; new leaf specs stub `HOME` and `USERPROFILE`
  separately.
- *The UNC screen was specified on the derived path, not the raw home — the measured POSIX blind
  spot `homeIsUnsafe` exists for* (raised twice). Now spelled as two screens, raw-then-backstop,
  in `homeIsUnsafe`'s shape, with the `doctor.ts:654-684` measurement and the #1529 shape cited.
  The single-case UNC spec is replaced by a table over `NETWORK_PATHS`, asserting the **syscall**
  is not made rather than the return value — the standing rule in `tests/helpers/unc-fixtures.ts`.
- *A second unfenced JSON reader of a Claude config, outside the file the existing fence scans.*
  Fix now states which of the two options is taken and why: `readClaudeConfig` cannot be reused
  (`src/shared/` importing from `src/cli/` inverts the layering), the `reason`-leak class is
  structurally absent from a `string | null` leaf, and the fence's `SOURCE` set is extended to
  include the new module so a future `readJson` there reds it. Added to Tests and Files touched.

**Not adopted**

- *Thread `homeOverride` through `applySetup` as the seam* (the alternative offered by the same
  finding). Mocking the module in `run-setup-apply.test.ts` is strictly safer — with the module
  mocked no filesystem read happens at all, so the negative specs cannot depend on machine state
  even by accident — and it adds no test-only parameter to a production CLI option bag. The leaf
  keeps `homeOverride` for its own unit tests, which is where it earns its keep.

## Review corrections (round 2)

**Adopted**

- **BLOCKING** *The pinned home-resolution chain used `??` and dropped the empty-home early
  return, so it did not match the two sites it cited — and with `HOME=""` the leaf reads a
  cwd-relative `.claude/settings.json` whose JSON key is then interpolated into a shell command
  printed to the operator* (raised three times). The chain is now
  `opts.homeOverride || process.env.HOME || process.env.USERPROFILE || homedir()` with an explicit
  `if (!home) return null;`, matching `src/cli/doctor.ts:1972-1973`; the citation is corrected
  (both sites use `||`, and `checkUserMcpConfig` at `:1106` passes `home || undefined`); the
  `homeIsUnsafe` `home !== ""` carve-out is named as the reason the screen cannot cover this. New
  leaf spec: both env vars `""`, no `homeOverride` → `null` and no `readFileSync`.
- **BLOCKING** *The UNC table drives only `homeOverride`, but `applySetup` calls
  `detectEnabledTandemPlugin()` with no argument — so an `opts.homeOverride`-only screen passes
  all eleven rows with the production path unscreened.* The table is now two `it.each` blocks: one
  over `homeOverride`, one setting `process.env.HOME` **and** `process.env.USERPROFILE` to the
  hostile spelling and calling with no options — mirroring
  `tests/cli/doctor-path-safety.test.ts:812-826` vs `:833-838`, whose `:857-860` records the
  surviving mutation this shape exists for.
- *"Let the read's own screen stand as a backstop" asserts a control that is not in the code — the
  leaf's reader has no screen, and the one named belongs to `readClaudeConfig`, which the same
  spec rules out.* Replaced with an explicit second screen in the leaf,
  `if (rejectUnsafeWindowsPrefix(settingsPath) !== null) return null;` before the `readFileSync`,
  plus a leaf spec driving `homeOverride: "\\"` (passes the raw screen, derives an unsafe path on
  posix) asserting `readFileSync` is not called.
- *The fence extension can never fail, so it adds no signal while reading as new protection*
  (raised twice). `readJson` is module-private to `doctor.ts` (`src/cli/doctor.ts:514`) and the
  layering rule forbids importing it, and the leaf reads with `readFileSync` — which the fence's
  `/\breadJson\(([^)]*)\)/g` (`doctor-path-safety.test.ts:696-700`) cannot see. The extension is
  kept but is now labelled **forward-looking only** in both the Fix and the Tests, with a sentence
  saying what actually pins the leaf's reader.
- *The spec prescribes `vi.spyOn(fs, "readFileSync")`, which this repo has measured as broken on
  an ESM builtin namespace.* Reworded to `vi.hoisted` + `vi.mock("node:fs", …)`, citing the
  documented rationale at `tests/cli/doctor-path-safety.test.ts:22-25`.

**Not adopted**

- None.
