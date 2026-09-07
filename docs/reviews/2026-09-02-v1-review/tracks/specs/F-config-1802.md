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
  - `raw.trim() === ""` → start fresh (`existing = {}`), **no backup**. A file with no bytes of
    user data loses nothing by being written. The issue proposes `size === 0`; `trim()` after the
    BOM strip is the same predicate one step wider (a lone `\n`, a lone BOM), and it is checked
    *after* the strip so the BOM-only file does not fall into the refusal.
  - otherwise `JSON.parse`, and on failure throw
    `new ConfigRefusalError("CONFIG_MALFORMED", \`${configPath} is not valid JSON — refusing to rewrite it\`)`
    (the class lands in the #1801 half of this branch). The message must carry **no parse detail**:
    V8 `SyntaxError` text embeds a source snippet and this file holds bearer tokens — the rule
    `readConfigForMutation:1226-1231` already states.
  - The whole `.broken-backups` block (`:1058-1147`: `mkdirSync`, `randomUUID` path,
    `setRestrictiveAcl`, `copyFile` with `COPYFILE_EXCL`, the POSIX `open("wx", 0o600)`) is
    **deleted** — after this change nothing reaches it, and leaving a Windows-ACL-hardened copier
    alive for a zero-byte file is dead weight on a security-sensitive path. Drop the imports it
    solely owned and the header bullet at `:14-16`. `.broken-backups/` itself survives:
    `storage.ts#backupBrokenFile` and `models/store.ts` still write there, so
    `docs/data-locations.md:30` stays true.
- **`src/server/integrations/api-routes.ts`** — the `ConfigRefusalError` arm added by #1801 already
  carries this code through; the static client message is "Your Claude settings file isn't valid
  JSON, so Tandem left it alone." No path, no snippet.
- **`IntegrationWizardModal.svelte#resultErrorText`** — `case "CONFIG_MALFORMED"`: "Your Claude
  settings file isn't valid JSON. Tandem left it untouched — fix or restore the file, then try
  again." This is the wizard-silence half of the issue.
- **`src/cli/doctor.ts:1149-1158`** — the malformed-`~/.claude.json` warning currently prescribes
  `setupApplyRemedy(…)` suffixed with "Tandem backs the file up before rewriting it." That claim
  becomes false the moment this ships, and it is the sentence that would send a user to the command
  that now refuses. Replace the `malformed` arm's fix with a rewrite-free remedy ("Fix the JSON, or
  restore the file from a backup, then re-run doctor — Tandem will not rewrite a config it cannot
  parse."). Keep it path-free and parse-detail-free: it reaches Copy Diagnostics and public issues.
  The `unreadable` arm is untouched.
- **`tests/docs/config-writer-set-claims.test.ts`** — deleting the backup removes one matched
  durable-write idiom from `apply.ts` (the `copyFile` at `:1119`), so `WRITER_SITES` drops from 10
  to 9. Re-derive the number from the test's own failure message rather than trusting this line,
  and update the `why` string. This is a **removal**; the guard exists to stop writers being
  *added*, and `docs/security.md:453` gets one clause recording it. Nothing else in the #1599
  acceptance moves — in particular `docs/security.md:455` (iii), "a losing writer's token appears
  nowhere in the final file", is pinned by the concurrency spec in `apply-malformed.test.ts`, which
  this change keeps.

## Tests

`tests/server/integrations/apply-malformed.test.ts` — rewrite the three replacement specs
(`:101-133`, `:155-168`) rather than adding a fourth family:

1. `'{"mcpServers":{'` → `applyConfig` **rejects** with `ConfigRefusalError`, `code ===
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

`tests/server/integrations/api-routes.test.ts`: an apply against a malformed config file returns
`status: "error"` with `code: "CONFIG_MALFORMED"`, the file is unchanged, and the response
`message` contains neither the path nor any JSON fragment. Kills the "wizard shows nothing" half —
today this row is `applied`.

`tests/cli/doctor.test.ts:2014-2023`: update to the new remedy sentence, keeping the
`not.toContain("..")` dangling-clause assertion that spec exists for.

`tests/server/integrations/apply-acl.test.ts` is **deleted with its subject**: both its describes
are about the malformed-backup block (`setRestrictiveAcl` on the dir, no orphan file, the
source-grep TOCTOU guard), and neither has anything left to assert. It is not in
`scripts/ci/windows-acl-proof.mjs`'s `WINDOWS_ACL_PROOF_SPECS` (it mocks `acl-win`), so the
`windows-acl-proof` job and its wiring test are unaffected — state that in the PR body, and note
that the same hardening invariant remains proven for `storage.ts` by
`tests/server/file-io/doc-backup-acl-repair.test.ts`, which *is* in that list.

## Done when

A malformed non-empty `~/.claude.json` is never rewritten by any Tandem path; the CLI and the
wizard both name the refusal; an empty config still gets a fresh file; `doctor` no longer promises
a backup-and-rewrite; the writer count and the `docs/security.md` clause are updated together;
typecheck + the touched suites green.

## Not in scope

`readConfigForMutation` (already correct — it is the model). `existing-config.ts`'s third, looser
read. Pruning the historical `.claude.json.broken-*` copies users already have. Whether Claude Code
writes the file atomically (unknowable here; it is why the issue is Medium).
