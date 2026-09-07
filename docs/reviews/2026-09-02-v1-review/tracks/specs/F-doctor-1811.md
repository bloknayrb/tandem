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

- **New shared leaf `src/shared/integrations/tandem-plugin.ts`** (~30 lines), sibling of the
  existing `client-config-paths.ts` — whose own doctrine comment ("Path from the shared leaf, so
  doctor inspects the file `detectTargets` writes rather than a second hand-maintained copy of the
  same rule") is the precedent for putting the predicate in one place instead of duplicating it:
  - `findEnabledTandemPluginKey(enabledPlugins: Record<string, unknown> | null | undefined): string | null`
    — pure; the predicate lifted verbatim from `evaluateTandemPlugin`:
    `key.startsWith("tandem@") && value === true`. **Test the value, not truthiness** — `false` is
    a deliberately disabled plugin — and match any marketplace suffix, because
    `docs/spikes/plugin-delivery.md` recommends a local one and a hardcoded
    `tandem@tandem-editor` in a remedy hands those users a command that errors.
  - `detectEnabledTandemPlugin(opts: { homeOverride?: string } = {}): string | null` — resolves
    `<home>/.claude/settings.json`, **refuses a UNC/device path first via
    `rejectUnsafeWindowsPrefix` from `src/shared/windows-path-safety.ts`** (#1417: reading one
    performs the SMB handshake that leaks an NTLM hash — the screen must precede the read, not
    wrap it), then `readFileSync` + `JSON.parse` inside a total `try/catch`, and returns
    `findEnabledTandemPluginKey(parsed.enabledPlugins)`. Every failure → `null`: absence is not
    evidence, and this must never make `setup --apply` fail.
- **`src/cli/doctor.ts`:** `evaluateTandemPlugin` calls `findEnabledTandemPluginKey(input.enabledPlugins)`
  in place of its inline `Object.entries(...).find(...)`. One line, no behaviour change — it exists
  so the two surfaces cannot drift. Doctor keeps its own reader, its own `homeIsUnsafe` screen and
  its own reporting; it does **not** import `detectEnabledTandemPlugin`.
- **`src/cli/setup.ts`, `applySetup`:** call `detectEnabledTandemPlugin()` once, immediately before
  `console.error("Detecting Claude installations...")`, and when it returns a key print one
  notice to stderr (setup's whole output is stderr):
  `The Tandem plugin (<key>) is installed and already provides the tandem_* tools. Writing this
  config too makes every tool appear twice — keep one: claude plugin uninstall <key>`.
- **The write still happens.** `--apply` is the scriptable, non-interactive path whose contract is
  "write the config"; silently skipping it would strand a user who later disables the plugin, with
  no output saying why nothing was written. Warn, do not skip. (Assumption; the issue's own
  suggestion offers skipping, the track file's taken shape says warn.)

Rules that bite: **never against the real HOME** — the notice reads `~/.claude/settings.json`, so
every test uses `homeOverride` or a scratch `HOME`/`USERPROFILE`. No config *writer* is added
(#1599's bound and `tests/docs/config-writer-set-claims.test.ts` count durable write sites; this
is a read). No new `/api` route, no MCP tool, no skill edit.

## Tests

- `tests/shared/integrations/tandem-plugin.test.ts` (new): `findEnabledTandemPluginKey` returns the
  key for `{"tandem@tandem-editor": true}`; `null` for `{"tandem@x": false}` (kills a truthiness
  check); `null` for `{"other@y": true}`; `null` for `null`/`undefined`/`{}`; returns the key for a
  non-default marketplace `{"tandem@local-marketplace": true}` (kills a hardcoded suffix).
  `detectEnabledTandemPlugin({ homeOverride })` against a temp home: absent file → `null`;
  malformed JSON → `null` (no throw); `enabledPlugins` present → the key.
- `tests/cli/setup.test.ts` (or `run-setup-apply.test.ts`, whichever already drives `applySetup`
  with a scratch home): with a settings.json enabling `tandem@tandem-editor`, `--apply` prints a
  notice containing `plugin uninstall` **and still writes the MCP entry** — the second assertion is
  the discriminating one, killing a fix that "helpfully" skips the write. With `false`, and with no
  settings.json at all, no notice is printed (kills a check that fires for every user).
- `tests/cli/doctor.test.ts`: keep/add a pin that `evaluateTandemPlugin({ enabledPlugins:
  {"tandem@tandem-editor": true}, wizardTandemEntry: true })` still yields the duplication `warn`
  whose `fix` names `claude plugin uninstall tandem@tandem-editor` — the refuted half is a working
  behaviour with no test of its own, and the refactor above touches its key-finding line.

## Done when

`setup --apply` on a machine with the plugin installed says so and names the remedy before it
writes; the predicate exists once; doctor's existing duplication warn is pinned; typecheck + the
CLI and shared suites green. The PR body records the refutation with the `git show` citation.

## Not in scope

A doctor `--fix` flag (a new CLI surface; not in the taken shape). README / wizard copy (docs
drift is #1821 / the J2 group). Making `setup --apply` skip the MCP write. Anything about the
plugin's own npx pin — that is #1790.
