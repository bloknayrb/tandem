# F-doctor — #1811 plugin + `tandem setup --apply` loads the `tandem_*` toolset twice

Branch `fix/doctor-and-skill-version-skew-1806`. Closes #1811. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/skill-plugin.md:26`. Overlaps #1790 item 4 — same
condition, filed twice.

## Problem

**One of the issue's two halves is refuted by the source, and this spec says so rather than
re-fixing it.** The cited `doctor.ts:1842-1845` at the review baseline `3fb6408` are the *doc
comment* on `checkTandemPlugin`, not an emitter. The emitter is `evaluateTandemPlugin`'s second
outcome, present unchanged at `3fb6408`: `status: "warn"`, message *"Both the Tandem plugin and a
tandem MCP entry in ~/.claude.json are present — the tandem_* tools will appear twice"*, with a
`fix` naming `claude plugin uninstall ${installedKey}` for the key it actually found. **Doctor
already detects the condition and already names the remedy.** Verified by
`git show 3fb6408:src/cli/doctor.ts | sed -n '1899,1912p'`.

What is genuinely missing is the other half: **`tandem setup --apply` says nothing.** It detects
targets, writes the `~/.claude.json` MCP entry and installs the skill without ever looking at
`~/.claude/settings.json`, so the command that *creates* the duplication is the one surface that
never mentions it. That is the fix here, and it is the shape the track file records
(`F-push-paths-and-cli.md:22`: "`setup --apply` warns when the plugin is installed").

## Fix

Two files. **No new module** — the detection reuses doctor's existing screened reader (see the
scope cut).

- **`src/cli/doctor.ts`:**
  - Lift `evaluateTandemPlugin`'s inline finder into an exported pure
    `findEnabledTandemPluginKey(enabledPlugins: Record<string, unknown> | null): string | null`,
    with the predicate verbatim: `key.startsWith("tandem@") && value === true`. **Test the value,
    not truthiness** (`false` is a deliberately disabled plugin) and match any marketplace suffix
    (`docs/spikes/plugin-delivery.md` recommends a local one, so a hardcoded `tandem@tandem-editor`
    hands those users a command that errors). It returns the **raw key**, unclamped;
    `evaluateTandemPlugin` calls it and its behaviour is genuinely unchanged.

    **The key-shape clamp does NOT live in the finder.** `evaluateTandemPlugin` short-circuits
    *both* of its outcomes on `undefined` (`if (installedKey === undefined) return [];`, `:1931`),
    so a clamp inside the shared finder turns today's `pass` (`:1943-1961`) **and** the duplication
    `warn` (`:1965-1972`) into silence for any marketplace suffix outside the character class —
    doctor would stop reporting a plugin that is genuinely installed, which is a regression, not a
    hardening. The clamp belongs to the one surface this fix newly adds, below.
  - Exported `detectEnabledTandemPluginKey(): string | null`, five lines beside
    `checkTandemPlugin`, reusing what that check already uses:
    `const home = process.env.HOME || process.env.USERPROFILE || "";` (the same spelling as
    `src/cli/doctor.ts:1971`, so there is no `homedir()` fallback and no cwd-relative read to
    guard); `if (!home || homeIsUnsafe(home)) return null;`; `readClaudeConfig(join(home,
    ".claude", "settings.json"))`; anything but `kind === "ok"` → `null`; otherwise
    `findEnabledTandemPluginKey(value.enabledPlugins ?? {})`. Absence is never evidence, and this
    must never make `setup --apply` fail.

    **This is where the key shape is clamped:** return the key only when it also matches
    `/^tandem@[A-Za-z0-9._-]+$/`, otherwise `null`. It is arbitrary JSON-key text that this fix
    newly prints into `setup`'s terminal output inside a copy-paste
    `claude plugin uninstall <key>`, and a newline or ANSI escape in it would render as something
    other than what it is. Suppressing the *new* notice for such a key costs nothing; suppressing
    doctor's existing report of an installed plugin would not. If the clamp is ever wanted on
    doctor's `fix` string too, it must degrade to a warn without the copy-paste command — never to
    silence.

    **`readClaudeConfig` is the point.** It is doctor's screened reader (`:595-607`) — the same one
    `checkTandemPlugin` uses, refusing an unsafe path (#1417) before any syscall and surfacing no
    parse detail. Using it means this adds no new reader, no second UNC screen and no new home
    chain: the two guards here are the two calls `checkTandemPlugin` already makes, and
    `tests/cli/doctor-path-safety.test.ts` already covers them.
- **`src/cli/setup.ts`, `applySetup`:** `const pluginKey = (await
  import("./doctor.js")).detectEnabledTandemPluginKey();` — dynamic, mirroring
  `src/cli/index.ts:178`, so `tandem setup` does not pay for loading doctor's dependency graph on
  every other path. When it returns a key, print one notice to stderr (setup's whole output is
  stderr):

  > The Tandem plugin (`<key>`) is installed and already provides the tandem_* tools. Writing this
  > config too makes every tool appear twice — keep one: `claude plugin uninstall <key>`

  **Placement: after the `opts.targets` filter (`:121`), gated on
  `targets.some((t) => t.kind === "claude-code")`, still before `writeTargets`.** The plugin is a
  Claude Code plugin, so `tandem setup --apply --target=claude-desktop` writes no Claude Code
  entry and duplicates nothing — printing "every tool appears twice" there is a false statement
  prescribing the uninstall of a working plugin, the dead-end/false-remedy class this area has
  already been corrected for twice (`src/cli/doctor.ts:1163-1190`, `:1345-1360`). Doctor gates its
  own duplication warn on `wizardTandemEntry` for exactly this reason (`:1963-1972`: "a
  plugin-only user has nothing duplicated and needs no warning"); the target filter is setup's
  equivalent, and it is why the notice cannot sit above `detectTargets` at `:116`.

- **The write still happens.** `--apply` is the scriptable, non-interactive path whose contract is
  "write the config"; silently skipping it would strand a user who later disables the plugin, with
  no output saying why nothing was written. Warn, do not skip. (Assumption; the issue's own
  suggestion offers skipping, the track file's taken shape says warn.)

Rules that bite: no config *writer* is added — this is a read, so #1599's bound and
`tests/docs/config-writer-set-claims.test.ts` are untouched. No new `/api` route, no MCP tool, no
skill edit.

## Tests

- `tests/cli/run-setup-apply.test.ts` — **the wiring, against a scratch home, with nothing
  mocked.** Its `beforeEach` gains `mkdtempSync` plus `vi.stubEnv("HOME", dir)` and
  `vi.stubEnv("USERPROFILE", dir)` (both — `detectEnabledTandemPluginKey` reads whichever the
  platform sets), with `vi.unstubAllEnvs()` + `rmSync` in `afterEach`. **This is required, not
  optional:** that file mocks only `apply.js`, so without it the new call reads the operator's real
  `~/.claude/settings.json` in all four existing `--apply` specs and the negative spec passes or
  fails by machine — the #1894 hazard this group is told to avoid. Three specs:
  - `<dir>/.claude/settings.json` = `{"enabledPlugins":{"tandem@tandem-editor":true}}` → stderr
    contains `plugin uninstall` **and `applyConfig` was still called** — the second assertion is
    the discriminating one, killing a fix that "helpfully" skips the write.
  - no settings file → no notice (kills a check that fires for every user).
  - **Target-gated**: the same settings file, plus `detectTargets` yielding only the Claude
    Desktop target (or `opts.targets: ["claude-desktop"]` filtering the Claude Code one out) →
    **no notice**, and `applyConfig` still called. Kills the notice placed above `detectTargets`,
    which would assert a duplication that a desktop-only run does not create.
- `tests/cli/doctor.test.ts`:
  - `findEnabledTandemPluginKey`: the key for `{"tandem@tandem-editor": true}`; `null` for
    `{"tandem@x": false}` (kills a truthiness check), `{"other@y": true}`, `null` and `{}`; the key
    for `{"tandem@local-marketplace": true}` (kills a hardcoded suffix); and — the clamp's
    negative pin — the key **is still returned** for a suffix carrying a newline or an ANSI
    escape, because the finder is unclamped and doctor must keep reporting the plugin.
  - `detectEnabledTandemPluginKey` (scratch home, both env vars stubbed): the key for
    `{"tandem@tandem-editor": true}`, and `null` for those same newline/ANSI suffixes written
    into `<dir>/.claude/settings.json`. **This is the only place the clamp is asserted**, and it
    kills both a missing clamp and a clamp pushed down into the shared finder.
  - Keep/add a pin that `evaluateTandemPlugin({ enabledPlugins: {"tandem@tandem-editor": true},
    wizardTandemEntry: true })` still yields the duplication warn whose `fix` names
    `claude plugin uninstall tandem@tandem-editor` — the refuted half is working behaviour with no
    test of its own, and the substitution above touches its finder line.

## Done when

`setup --apply` on a machine with the plugin installed says so and names the remedy before it
writes, and still writes; a desktop-only `--apply` stays silent; no test reads a real home;
`detectEnabledTandemPluginKey` rejects a newline/ANSI suffix while `findEnabledTandemPluginKey`
still returns it; doctor's existing duplication warn is pinned; typecheck + the CLI suite green.
The PR body records the refutation with the `git show` citation.

## Not in scope

A doctor `--fix` flag. README / wizard copy (docs drift is #1821 / the J2 group). Making
`setup --apply` skip the MCP write. The plugin's own npx pin — that is #1790.

## For Bryan

The `<home>/.claude/settings.json` derivation is spelled out twice in `src/cli/doctor.ts`
(`:1996` and the new detector) plus a `SETTINGS_LEAF` literal in
`tests/cli/doctor-path-safety.test.ts:127,261`. The consolidation is
`claudeCodeSettingsPath()` in `src/shared/integrations/client-config-paths.ts` with both callers
repointed — a refactor of a UNC-screened doctor path, above this group's bar.

## Review corrections (scope cut)

**Removed**

- *The new `src/shared/integrations/tandem-plugin.ts` leaf* and everything it required: its own
  `homeOverride` + `homedir()` home chain, its own `readFileSync`/`JSON.parse` reader, the raw and
  derived UNC screens, the layering argument, and the extension of
  `doctor-path-safety.test.ts`'s unfenced-reader fence (which the spec itself conceded could never
  fail). Detection lives in `src/cli/doctor.ts`, where the screened reader, the home spelling and
  the UNC guards already exist and are already tested. **All five outstanding findings on this spec
  targeted that leaf's test specs and are moot at the root**: there is no empty-home `||`-vs-`??`
  discriminator (no `homedir()` fallback exists), no lone-backslash derived-path spec to gate on
  win32, and no eleven-row `NETWORK_PATHS` table whose red run would issue the SMB handshake #1417
  exists to prevent — so no containment stub is needed either.
- *The two-input-path UNC tables and the `node:fs` mocking apparatus* (`vi.hoisted` +
  `vi.mock("node:fs")`, `homedir()` mocking). With no new reader there is nothing new to screen;
  the specs above touch only a pure predicate and a scratch-home wiring path.
- *Mocking `tandem-plugin.js` in `run-setup-apply.test.ts`.* A scratch `HOME`/`USERPROFILE` is
  simpler, exercises the real code path, and fixes the machine-dependence of that file's four
  existing specs at the same time.
- *The three round-by-round correction logs.*

**Kept**

The refutation of the issue's first half; the `setup --apply` notice with the write preserved; the
value-not-truthiness predicate and any-marketplace matching; the key shape clamp (this fix is what
newly prints that key to a terminal); the doctor duplication-warn pin.

## Review corrections (post-cut)

- **The key-shape clamp moved out of the shared finder into `detectEnabledTandemPluginKey`.**
  Placing it in `findEnabledTandemPluginKey` would have deleted doctor's *existing* behaviour, not
  hardened it: `evaluateTandemPlugin` returns `[]` on an `undefined` key
  (`src/cli/doctor.ts:1931`), so a rejected marketplace suffix silenced both the installed-plugin
  `pass` and the duplication `warn` — while the spec claimed "behaviour unchanged" and its only
  `evaluateTandemPlugin` pin used `tandem@tandem-editor`, which passes the clamp. The doctor.test
  specs are restated to match: the finder still returns a newline/ANSI key, the detector is what
  rejects it.
- **The `setup --apply` notice moved after the target filter** (`src/cli/setup.ts:121`) and is
  gated on a `claude-code` target. Above `detectTargets` it printed "every tool appears twice" on
  `--target=claude-desktop`, a run that writes no Claude Code entry and duplicates nothing — a
  false statement prescribing the uninstall of a working plugin. A third `run-setup-apply` spec
  pins the desktop-only silence.
