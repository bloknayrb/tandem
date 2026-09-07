# F-config — #1802 `applyConfig` replaces a malformed `~/.claude.json` with a Tandem-only file and reports success

Branch `fix/push-paths-config-1760`. Closes #1802 (both halves: the replacement and the wizard's
silence). Ledger: `docs/reviews/2026-09-02-v1-review/areas/server-runtime.md:20` and
`areas/shared-cli.md:20` (both M, `[read]`). Probe: the review's scratch-`HOME` run, which produced
the replacement warning verbatim —
`docs/reviews/2026-09-02-v1-review/raw/manifests/shared-cli.md:420`.

## Problem

`applyConfig` (`src/server/integrations/apply.ts:1007`, the read at `:1024-1147`) catches `SyntaxError` from
`JSON.parse`, copies the file to `${appDataDir}/.broken-backups/`, and then continues with
`existing = {}` — writing a **new** config holding only Tandem's entries and returning success.
Everything Claude Code kept there (project list, OAuth account, onboarding state, per-project
allow-lists, history) leaves the live file. `readConfigForMutation` in the same module refuses on
the identical input (`:1259-1261`), so the two paths disagree about what "malformed" means, and the
one that disagrees is the one that writes.

Three amplifiers: whether Claude Code writes that file atomically is **unknown** (tmp.PID files
seen in the wild), so a half-written file during Tandem's boot sweep or a wizard apply looks
malformed; the wizard reports plain success (`api-routes.ts:939-940` pushes
`{status: "applied"}`); and nothing prunes `.claude.json.broken-*` — `pruneOldBackups`
(`storage.ts:333-357`) is prefix-scoped and does not know that name, so the copies accumulate
forever.

The shape gates just below (`:1042-1055`, non-object root, non-object `mcpServers`) already **throw
and leave the file intact**. This fix makes the parse failure behave like its own neighbours.

## Fix

- **`apply.ts#applyConfig`** — restructure the read so the decision is explicit rather than a catch
  arm. Read, strip the BOM, then:
  - **`readFileSync` ENOENT still starts fresh** (`existing = {}`) — unchanged, and it is the
    fresh-install path; every other I/O error still rethrows unchanged (`:1146`). Only the
    `SyntaxError` arm's behaviour changes.
  - `raw.trim() === ""` → start fresh (`existing = {}`), **no backup**. A file with no bytes of
    user data loses nothing by being written. The issue proposes `size === 0`; `trim()` after the
    BOM strip is the same predicate one step wider (a lone `\n`, a lone BOM), and it is checked
    *after* the strip so the BOM-only file does not fall into the refusal. **The truncation window
    this leaves open is real and is not closed here**: a non-atomic writer doing `open(path, "w")`
    passes through zero bytes, and Tandem will write a Tandem-only config over that and report
    success. Today's behaviour is not better (backing up a zero-byte file preserves nothing —
    `apply-malformed.test.ts:102`), so this is a residual, not a regression, and it sits inside the
    already-accepted bound of #1599 (`docs/security.md:449-451`, "First install — silent,
    permanent, and reported as success"). Say so in the PR body so the refusal is not read as total.
  - otherwise `JSON.parse`, and on failure throw
    `new ConfigRefusalError("CONFIG_MALFORMED", \`${configPath} is not valid JSON — refusing to rewrite it\`)`
    (the class lands in the #1801 half of this branch, and its field is `reason`). The message must
    carry **no parse detail**: V8 `SyntaxError` text embeds a source snippet and this file holds
    bearer tokens — the rule `readConfigForMutation:1226-1231` already states.
  - The whole `.broken-backups` block (`:1058-1147`: `mkdirSync`, `randomUUID` path,
    `setRestrictiveAcl`, `copyFile` with `COPYFILE_EXCL`, the POSIX `open("wx", 0o600)`) is
    **deleted** — after this change nothing reaches it, and leaving a Windows-ACL-hardened copier
    alive for a zero-byte file is dead weight on a security-sensitive path. Drop the imports it
    solely owned. **Two stale docblocks, not one**: the header bullet at `:14-16`, *and*
    `applyConfig`'s own "Security gates (run before any read or write)" list at `:996-1000`, which
    advertises "Malformed JSON is backed up under Tandem's data dir with mode `0o600`" — a deleted
    gate. `.broken-backups/` itself survives: `storage.ts#backupBrokenFile` and `models/store.ts`
    still write there, so `docs/data-locations.md:30` stays true.
- **`src/server/integrations/api-routes.ts`** — the `ConfigRefusalError` arm added by #1801 already
  carries this code through; the static client message is "Your Claude settings file isn't valid
  JSON, so Tandem left it alone." No path, no snippet.
- **`IntegrationWizardModal.svelte#resultErrorText`** — `case "CONFIG_MALFORMED"`: "Your Claude
  settings file isn't valid JSON. Tandem left it untouched — fix or restore the file, then try
  again." This is the wizard-silence half of the issue.
- **`src/cli/doctor.ts` — BOTH sites that promise a backup-and-rewrite, not one.**
  `grep "backs the file up"` returns exactly two source lines, `:1156` and `:1529`, and
  `applyConfig` is path-agnostic, so both promises become false the moment the refusal ships. Only
  the first is pinned by a test, so the second would ship false and silent.
  - `:1149-1158` (the `~/.claude.json` arm). Replace the `malformed` branch's fix with a
    rewrite-free remedy: "Fix the JSON, or restore the file from a backup, then re-run doctor —
    Tandem will not rewrite a config it cannot parse." The `unreadable` branch here is a separate
    ternary arm and is untouched.
  - `:1523-1533` (`checkDesktopMcpConfig`). This arm deliberately merges `unreadable` and
    `malformed` into one warn (`:1513`), so the spec's "the `unreadable` arm is untouched" carve-out
    does **not** transfer. Reword to a claim true of both rather than splitting the branch — the
    existing comment explains why one branch covers both ("could not be read as JSON" is true
    whether the open or the parse failed), and splitting it re-introduces the false assertion that
    comment exists to avoid. Same rewrite-free sentence, keeping the `DESKTOP_RESTART_NOTE` second
    `withSuffix` hop.
  - Both stay path-free and parse-detail-free: they reach Copy Diagnostics and public issues.
- **`tests/docs/config-writer-set-claims.test.ts`** — deleting the backup removes one matched
  durable-write idiom from `apply.ts` (the `copyFile` at `:1119`; the `DURABLE_WRITE` regex at
  `:122` does not match the bare `open(backupPath, "wx", 0o600)` or the `fd.write`, so the drop is
  exactly 1). **Two constants pin `apply.ts` at 10, not one**: `WRITER_SITES` (`:138-140`) and the
  repo-wide `DURABLE_WRITER_FILES` census (`:234`). Both go 10 → 9. Re-derive the numbers from the
  test's own failure message rather than trusting this line, and update the `why` string. This is a
  **removal**; the guard exists to stop writers being *added*, and `docs/security.md:453` gets one
  clause recording it. Nothing else in the #1599 acceptance moves — in particular
  `docs/security.md:455` (iii), "a losing writer's token appears nowhere in the final file", is
  pinned by the concurrency spec in `apply-malformed.test.ts`, which this change keeps.
- **`apply.ts#targetHasChannelEntry`'s docblock (`:2229-2237`)** says malformed configs answer
  `false` because "`applyConfig` will start that file fresh anyway" — false after this change. It is
  rewritten in the #1760 half of this branch (see `F-config-1760.md`); named here so the two halves
  do not both claim it or both skip it.

## Tests

`tests/server/integrations/apply-malformed.test.ts` — rewrite the three replacement specs
(`:101-133`, `:155-168`) rather than adding a fourth family:

1. `'{"mcpServers":{'` → `applyConfig` **rejects** with `ConfigRefusalError`, `reason ===
   "CONFIG_MALFORMED"`, the on-disk bytes are identical (`assertOriginalIntact`), and
   `.broken-backups/` was never created. Kills today's replace-and-succeed and also kills a
   half-fix that backs the file up and *then* refuses.
2. BOM + malformed remainder → same refusal. Pins strip-then-parse order after the restructure.
3. `""` → applies, fresh config written, no `.broken-backups/`. Kills a blanket refusal that would
   break every genuinely empty config; the existing spec asserted the backup, so it must change.
4. `"\n"` and a BOM-only file → same as (3). Pins the `trim()`-after-strip decision, which is the
   one place this spec is wider than the issue's text.
5. The non-object-root and BOM-non-object specs stay untouched and green — they are the
   discriminating twins proving the refusal did not swallow the shape gate.
6. The fresh-install spec ("does NOT back up on fresh install") stays green unchanged — it is what
   catches a restructure that drops the ENOENT arm.

`tests/server/integrations/apply.test.ts:254-320` — `describe("applyConfig — malformed-JSON
backup")` is **deleted with its subject.** Both its specs are about the removed block: the POSIX
`0o600`-inside-`0o700` assertion (`:275-294`) and the `PathRejectedError`-from-the-backup-dir
assertion (`:296-314`). Neither has anything left to assert. **The hardening invariant is not
lost** — `tests/server/integrations/storage.test.ts:131-146` keeps the 0o600/0o700 proof for the
`.broken-backups/` directory that `storage.ts` and `models/store.ts` still write to. State that in
the PR body; without it, deleting a mode assertion reads like dropped coverage.

`tests/cli/setup.test.ts:470-508` — the CLI half of the issue's surface, and it asserts exactly the
behaviour being removed:

- `:470-485` `it("overwrites malformed JSON with fresh config")` is **inverted**: rename to
  `"refuses to overwrite malformed JSON"`, `await expect(applyConfig(...)).rejects.toThrow(ConfigRefusalError)`
  with `reason === "CONFIG_MALFORMED"`, and the on-disk bytes byte-identical.
- `:487-508` `it("backs up malformed .claude.json before overwriting")` is **converted, not
  deleted**, to `"creates no .broken-backups dir when it refuses"` — `existsSync(join(tmpDir,
  ".broken-backups"))` is `false`. Keeping it as a negative pins that the refusal happens *before*
  any copy, which is the half-fix (1) also guards against on the server side.

`tests/server/integrations/api-routes.test.ts`: an apply against a malformed config file returns
`status: "error"` with `code: "CONFIG_MALFORMED"`, the file is unchanged, and the response
`message` contains neither the path nor any JSON fragment. Kills the "wizard shows nothing" half —
today this row is `applied`.

`tests/client/integration-wizard-push-support.test.ts` — it already drives an error row with a
`code` (`:256`). Add one assertion that a `CONFIG_MALFORMED` result renders the "left it untouched"
sentence. `resultErrorText`'s `default` arm falls back to `result.message`, so a missing `case` is
invisible and there is no exhaustiveness test over `ApplyItemErrorCode` — this is the only thing
that pins the wizard half named in "Done when".

`tests/cli/doctor.test.ts` — two cases, one per site:

- `:2014-2023` (Claude Code arm): update to the new remedy sentence, keeping the
  `not.toContain("..")` dangling-clause assertion that spec exists for, and replace
  `toContain("Tandem backs the file up before rewriting it.")` with `not.toContain("backs the file up")`.
- **New**: the same pair of assertions against `checkDesktopMcpConfig`'s warn `fix` for a malformed
  `claude_desktop_config.json`. Nothing pins that site today (`grep -rn "backs the file up" tests/`
  returns one hit), which is how it would have shipped a false promise silently.

`tests/server/integrations/apply-acl.test.ts` is **deleted with its subject**: both its describes
are about the malformed-backup block (`setRestrictiveAcl` on the dir, no orphan file, the
source-grep TOCTOU guard), and neither has anything left to assert. It is not in
`scripts/ci/windows-acl-proof.mjs`'s `WINDOWS_ACL_PROOF_SPECS` (it mocks `acl-win`), so the
`windows-acl-proof` job and its wiring test are unaffected — state that in the PR body, and note
that the same hardening invariant remains proven for `storage.ts` by
`tests/server/file-io/doc-backup-acl-repair.test.ts`, which *is* in that list.

## Done when

A malformed non-empty `~/.claude.json` is never rewritten by any Tandem path; the CLI and the
wizard both name the refusal, and the wizard half is pinned by a test; **both** doctor sites stop
promising a backup-and-rewrite and both are pinned; an empty config still gets a fresh file and a
fresh install still works; the two writer counts and the `docs/security.md` clause are updated
together; typecheck + the touched suites green.

## Not in scope

`readConfigForMutation` (already correct — it is the model). `existing-config.ts`'s third, looser
read. Pruning the historical `.claude.json.broken-*` copies users already have. Whether Claude Code
writes the file atomically (unknowable here; it is why the issue is Medium) — and the zero-byte
truncation window that follows from it, which stays inside #1599's accepted bound.

## Review corrections (round 1)

**Adopted**

- *(blocking, three findings)* Only one of the two `doctor` sites promising "Tandem backs the file
  up before rewriting it." was named. `src/cli/doctor.ts:1523-1533` (`checkDesktopMcpConfig`) is
  added, with the note that its arm covers `unreadable` and `malformed` together — so the
  "`unreadable` arm is untouched" carve-out does not transfer and the sentence is reworded to one
  true of both rather than the branch being split. A `tests/cli/doctor.test.ts` case for that site
  is added; today nothing pins it.
- *(blocking, two findings)* `tests/cli/setup.test.ts:470-508` and
  `tests/server/integrations/apply.test.ts:254-320` were both missing from the test ledger and both
  assert the behaviour being removed. The first two specs are inverted/converted (refusal +
  no-`.broken-backups`); the `apply.test.ts` describe is deleted with its subject, with
  `tests/server/integrations/storage.test.ts:131-146` named as the surviving 0o600/0o700 proof so
  the deletion does not read as dropped hardening coverage.
- The second stale docblock, `applyConfig`'s own "Security gates" list at `apply.ts:996-1000`, added
  to the deletion bullet.
- Both writer-count pins named: `WRITER_SITES` (`:138-140`) **and** `DURABLE_WRITER_FILES` (`:234`),
  10 → 9 in each, with the regex arithmetic stated.
- The ENOENT arm is stated explicitly in the restructure bullet (fresh install unchanged; every
  other I/O error still rethrows; only the `SyntaxError` arm changes), and the fresh-install spec is
  listed as the test that catches its loss.
- The empty-file carve-out now records the truncation window it leaves open, cites
  `docs/security.md:449-451` as its accepted bound, and repeats it in "Not in scope".
- A wizard assertion is added to `tests/client/integration-wizard-push-support.test.ts` — "Done
  when" claimed the wizard half and nothing tested it, and `resultErrorText`'s `default` arm makes a
  missing `case` invisible.
- `targetHasChannelEntry`'s docblock is named here and rewritten in the #1760 half, so neither half
  double-claims or skips it.
- `ConfigRefusalError`'s field is `reason`, not `code`, per the #1801 correction; the test
  assertions use `reason`.

**Not adopted**

- None.
