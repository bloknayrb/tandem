# F-config — #1802 `applyConfig` replaces a malformed `~/.claude.json` with a Tandem-only file and reports success

Branch `fix/push-paths-config-1760`. Closes #1802 (both halves: the replacement and the wizard's
silence). Ledger: `docs/reviews/2026-09-02-v1-review/areas/server-runtime.md:20` and
`areas/shared-cli.md:20` (both M, `[read]`).

## Problem

`applyConfig` (`src/server/integrations/apply.ts:1007`, the read at `:1024-1147`) catches
`SyntaxError` from `JSON.parse`, copies the file to `${appDataDir}/.broken-backups/`, then continues
with `existing = {}` — writing a **new** config holding only Tandem's entries and returning success.
Everything Claude Code kept there (project list, OAuth account, onboarding state, per-project
allow-lists, history) leaves the live file. `readConfigForMutation` refuses on the identical input
(`:1259-1261`), so the two paths disagree about "malformed" and the one that disagrees is the one
that writes. Amplifiers: whether Claude Code writes that file atomically is unknown (tmp.PID files
seen in the wild), so a half-written file during a wizard apply or the boot sweep looks malformed;
the wizard reports plain success (`api-routes.ts:939-940`); nothing prunes the copies. The shape
gates just below (`:1042-1055`) already throw and leave the file intact — this fix makes the parse
failure behave like its neighbours.

## Fix

- **`apply.ts#applyConfig`** — restructure the read so the decision is explicit. Read, strip the
  BOM, then:
  - **`readFileSync` ENOENT still starts fresh** (`existing = {}`) — the fresh-install path,
    unchanged; every other I/O error still rethrows (`:1146`). Only the `SyntaxError` arm changes.
  - `raw.trim() === ""` → start fresh, **no backup**. The issue proposes `size === 0`; `trim()`
    after the BOM strip is the same predicate one step wider (a lone `\n`, a lone BOM), checked
    after the strip so a BOM-only file does not fall into the refusal. **The truncation window this
    leaves open is real and is not closed here**: a non-atomic external writer doing
    `open(path, "w")` passes through zero bytes and Tandem writes over it reporting success. Today's
    behaviour is no better — backing up a zero-byte file preserves nothing
    (`apply-malformed.test.ts:102`) — so it is a residual, not a regression. **Record it in the PR
    body as untracked and NOT covered by #1599**, which is scoped to races between Tandem's *own*
    writers (`docs/security.md:442`); do not call it accepted.
  - otherwise `JSON.parse`, and on failure throw
    `new ConfigRefusalError("CONFIG_MALFORMED", \`${configPath} is not valid JSON — refusing to rewrite it\`)`
    (the class lands in the #1801 half of this branch; its field is `reason`). The message carries
    **no parse detail**: V8 `SyntaxError` text embeds a source snippet and this file holds bearer
    tokens — the rule `readConfigForMutation:1226-1231` already states.
  - The `.broken-backups` block (`:1058-1147`) is **deleted** — nothing reaches it afterwards. Two
    imports it solely owned go with it: `constants as fsConstants` (`:23`, used only at `:1119`) and
    `basename` (`:43`, used only at `:1082`). Three docblocks stop being true and are corrected: the
    header bullet at `:14-16`; `applyConfig`'s "Security gates" list at `:996-1000` ("Malformed JSON
    is backed up … with mode `0o600`"); and `removeConfigEntries`'s at `:1286-1288`, whose "never
    replaces malformed JSON" contrast collapses once the two agree — drop the malformed half, keep
    "never creates the file". `.broken-backups/` survives (`storage.ts#backupBrokenFile`,
    `models/store.ts`), so `docs/data-locations.md:30` stays true.
- **`api-routes.ts`** carries the code through #1801's `ConfigRefusalError` arm; static client
  message "Your Claude settings file isn't valid JSON, so Tandem left it alone." No path, no
  snippet. **`IntegrationWizardModal.svelte#resultErrorText`** gains `case "CONFIG_MALFORMED"`:
  "Your Claude settings file isn't valid JSON. Tandem left it untouched — fix or restore the file,
  then try again." The issue also asks for the backup path; there is no backup after this change, so
  the code alone is the answer — say so in the PR body.
- **`src/cli/doctor.ts` — the two sentences this change falsifies, and nothing else.**
  `grep "backs the file up"` returns exactly `:1156` and `:1529`, and `applyConfig` is
  path-agnostic, so both promises become false the moment the refusal ships. `:1149-1158`
  (`~/.claude.json`) gets "Fix the JSON, or restore the file from a backup, then re-run doctor —
  Tandem will not rewrite a config it cannot parse." `:1523-1533` (`checkDesktopMcpConfig`) merges
  `unreadable` and `malformed` into one warn (`:1513`, comment at `:1510-1512`), so it must **not**
  be split and must **not** prescribe a JSON fix — an EACCES file was never parsed and is probably
  valid JSON; give it its own sentence true of both ("Tandem will not rewrite a config it could not
  read. Check the file's permissions and that it is valid JSON, then re-run doctor."), keeping the
  `DESKTOP_RESTART_NOTE` hop. Both stay path-free and parse-detail-free.
- **`tests/docs/config-writer-set-claims.test.ts`** — deleting the backup removes one matched
  durable-write idiom (the `copyFile` at `:1119`), so `WRITER_SITES` (`:138-140`) and
  `DURABLE_WRITER_FILES` (`:234`) both go 10 → 9. Re-derive the counts from the test's own failure
  message and re-derive the `why` string rather than editing it — it reaches 10 today by
  miscounting (one EXDEV `copyFile`, at `:958`; the tenth site is the backup copy it never names).
  Add one clause to `docs/security.md:453` recording the removal, per that test's docblock protocol.

## Tests

`tests/server/integrations/apply-malformed.test.ts` — rewrite the three replacement specs
(`:101-133`, `:155-168`) rather than adding a fourth family:

1. `'{"mcpServers":{'` → rejects with `ConfigRefusalError`, `reason === "CONFIG_MALFORMED"`, on-disk
   bytes identical (`assertOriginalIntact`), `.broken-backups/` never created. Kills today's
   replace-and-succeed and a half-fix that backs up *then* refuses.
2. BOM + malformed remainder → same refusal. Pins strip-then-parse order.
3. `""` → applies, fresh config written, no `.broken-backups/`. Kills a blanket refusal.
4. `"\n"` and a BOM-only file → same as (3). Pins the `trim()`-after-strip decision, the one place
   this spec is wider than the issue's text.
5. The non-object-root and BOM-non-object specs (`:61-99`) and the fresh-install spec stay green
   unchanged — they catch a restructure that swallows a shape gate or drops the ENOENT arm.

`tests/server/integrations/apply.test.ts:254-320` (`describe("applyConfig — malformed-JSON backup")`)
and `tests/server/integrations/apply-acl.test.ts` are **deleted with their subject**; drop the
latter's name from the platform-stub idiom list in `tests/server/file-watcher.test.ts:56`. For the
PR body: the 0o600/0o700 proof survives in `storage.test.ts:131-146` for the `.broken-backups/`
directory `storage.ts` still writes; `apply-acl.test.ts` is not in
`scripts/ci/windows-acl-proof.mjs`'s spec list (it mocks `acl-win`), so that job is unaffected; and
`apply.test.ts`'s `PathRejectedError` import survives, used at `:133`, `:137`, `:180`.

`tests/cli/setup.test.ts:470-508` — the CLI half, asserting exactly what is removed. `:470-485`
`it("overwrites malformed JSON with fresh config")` is **inverted**: rename to `"refuses to
overwrite malformed JSON"`, `rejects.toThrow(ConfigRefusalError)` with
`reason === "CONFIG_MALFORMED"`, on-disk bytes identical. `:487-508` `it("backs up malformed
.claude.json before overwriting")` is **converted, not deleted**, to `"creates no .broken-backups
dir when it refuses"` — **keeping its `process.env.TANDEM_APP_DATA_DIR = tmpDir` set/restore
plumbing (`:492-500`)**, without which `resolveAppDataDir()` points at the real app-data dir,
`join(tmpDir, ".broken-backups")` can never exist, and the negative passes vacuously against today's
code too.

`tests/server/integrations/api-routes.test.ts`: an apply against a malformed config returns
`status: "error"` with `code: "CONFIG_MALFORMED"`, the file unchanged, and the `message` carrying
neither the path nor any JSON fragment — today this row is `applied`.

`tests/client/integration-wizard-push-support.test.ts` already drives an error row with a `code`
(`:256`); add one assertion that a `CONFIG_MALFORMED` result renders the "left it untouched"
sentence. `resultErrorText`'s `default` arm falls back to `result.message`, so a missing `case` is
invisible.

`tests/cli/doctor.test.ts:2014-2023` — replace `toContain("Tandem backs the file up before rewriting
it.")` with `not.toContain("backs the file up")` plus the new remedy sentence, keeping the
`not.toContain("..")` dangling-clause assertion that spec exists for.

## Done when

A malformed non-empty `~/.claude.json` is never rewritten by any Tandem path; the CLI and the wizard
both name the refusal, the wizard half pinned by a test; both doctor sentences stop promising a
backup-and-rewrite, each with its own wording; an empty config still gets a fresh file and a fresh
install still works; the two writer counts land with a re-derived `why` string and the
`docs/security.md:453` clause; the zero-byte residual is in the PR body; typecheck + the touched
suites green.

## Not in scope

`readConfigForMutation` (already correct — it is the model). `existing-config.ts`'s third, looser
read. Pruning the historical `.claude.json.broken-*` copies users already have. Whether Claude Code
writes the file atomically, and closing the zero-byte truncation window that follows from it.

## Review corrections (scope cut)

Rounds 1–3 are superseded by this cut.

**Removed**

- **The new `docs/security.md#open-findings` entry for the zero-byte residual**, and with it the
  `CLAUDE.md:232` `Three` → `Four` count change, the refreshed reconciliation date and
  `tests/docs/security-findings-claims.test.ts` as a touched suite. Both remaining blocking findings
  here were about that entry drifting from CLAUDE.md through the one direction the guard test cannot
  see. Filing a new security finding is not what #1802 asks for, and the spec's own fallback branch
  was already "PR body only, no register entry" — that is now the only branch, so the two files
  cannot part. **For Bryan:** the residual is real and untracked; if it deserves a register entry it
  should be its own issue, where the count and the register move together.
- **Promoting the two shape gates (`:1046`, `:1053`) from bare `Error` to `ConfigRefusalError`**,
  and the `toBeInstanceOf` assertion pinning it. Their `WRITE_FAILED` mistranslation is pre-existing
  and is not what #1802 reports.
- The new `checkDesktopMcpConfig` case in `doctor.test.ts` (that site is unpinned today, so nothing
  goes red; the sentence is still corrected because this change makes it false), the
  `tests/cli/uninstall-scrub-mcp.test.ts:93` title rename, and the round-1/2/3 logs.

**Kept**

- The `docs/security.md:453` writer-count clause: `config-writer-set-claims.test.ts`'s own docblock
  makes it the protocol for changing a count, and the count change is forced by the deletion.
- The `doctor.ts` sentence edits: this change is what makes them false, and one of the two is pinned
  by an existing test that would otherwise go red.
