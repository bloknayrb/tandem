# F-config — #1801 `MAX_CONFIG_BYTES` (5 MiB) refuses a routinely multi-megabyte `~/.claude.json` with a generic `WRITE_FAILED`

Branch `fix/push-paths-config-1760`. Closes #1801. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/server-runtime.md:19` (M, `[read]`).

## Problem

`MAX_CONFIG_BYTES = 5 * 1024 * 1024` (`src/server/integrations/apply.ts:223`) gates both readers of
`~/.claude.json`: `applyConfig` (`:1011-1022`, throws) and `readConfigForMutation` (`:1249`, returns
`{status:"skipped", reason:"oversize"}`). The sweep's own comment (`:1880-1886`) calls that file
"routinely multi-megabyte". Over the cap the CLI prints the thrown message (which does name the size
and the cap), the boot sweep skips, and the wizard maps every `applyConfig` throw to
`ERROR_CODE_WRITE_FAILED` (`api-routes.ts:961-967`) so the modal renders "Couldn't write the settings
file — check it isn't open in another program" (`IntegrationWizardModal.svelte:505-506`) — wrong and
unactionable.

**The issue's third bullet is already implemented and must not be re-done.**
`refreshAllMcpEntryBinaries:1893-1899` already logs `Left <label> untouched (oversize). Run 'tandem
doctor' for the full check.` for every `skipped` reason. The remaining gap is the cap and the
wizard's mistranslation.

## Fix

- **Raise the cap in place to `16 * 1024 * 1024` and export it.** `export const MAX_CONFIG_BYTES`
  stays at `apply.ts:223`; the export exists so the tests derive their boundary from the constant.
  Rewrite its docblock (`:216-222`) — both present claims ("single-digit kilobytes", "no legitimate
  user hits it") are what this issue refutes. The replacement states the new bound and its cost: the
  cap bounds an in-memory read and both readers parse synchronously, so `applyConfig` blocks the
  server on the wizard route and `readConfigForMutation`'s `JSON.parse` runs on the pre-launcher
  startup sweep. **Say in the docblock and the PR body that 16 MiB is a judgment with essentially no
  measured input**: the ledger row records no size, and the only measurement taken is one real
  `~/.claude.json` on the development machine at 121,720 bytes — which leaves the sweep comment's
  "routinely multi-megabyte" unverified in both directions. The durable half of this fix is the
  legible refusal, not the number.
- **New `ConfigRefusalError` in `apply.ts`**, modelled on the sibling `PathRejectedError`
  (`:285-293`), with the same field name:

  ```ts
  export class ConfigRefusalError extends Error {
    override readonly name = "ConfigRefusalError";
    constructor(readonly reason: "CONFIG_TOO_LARGE" | "CONFIG_MALFORMED", message: string) { super(message); }
  }
  ```

  `reason`, not `code`: `applyConfig` branches on Node's `err.code` twice in the same try/catch
  (`:1020`, `:1057`). The size guard throws `ConfigRefusalError("CONFIG_TOO_LARGE", …)` with today's
  message. `CONFIG_MALFORMED` is thrown by #1802's half of this branch; the class lands here because
  this spec is implemented first.
- **`src/shared/integrations/contract.ts:245-254`** — add `ERROR_CODE_CONFIG_TOO_LARGE` (and, for
  #1802, `ERROR_CODE_CONFIG_MALFORMED`) to the `ApplyItemErrorCode` union.
- **`src/server/integrations/api-routes.ts`** — a new arm in the existing `catch` around
  `applyConfig` (`:942-969`), above the generic one and in the `PathRejectedError` shape: log `err`
  server-side, return `errorResult(entry.id, err.reason, <static message>)` carrying no path and no
  byte count — `ApplyItemResult.message` is the leak-safe field and this route is browser-reachable.
  The handler's gates are untouched and `NON_LOOPBACK_ALLOWED` does not grow.
- **`IntegrationWizardModal.svelte#resultErrorText`** — `case "CONFIG_TOO_LARGE"`: "Your Claude
  settings file is too large for Tandem to rewrite safely, so Tandem left it alone." **No
  `tandem doctor` pointer** — doctor has no size check and this branch does not add one.
- **`docs/security.md`, the #1599 entry — one sentence, no code change.** Configs in the 5–16 MiB
  band are immune to both `readConfigForMutation` callers today and stop being immune when the cap
  moves: the boot sweep's full-root writeback at `:1957` (risk-widening — `docs/security.md:447`/
  `:449` name it as the writer that can resurrect a live token or silently drop a fresh install) and
  `removeConfigEntries`, the uninstall scrub (risk-reducing — those configs become scrubbable). One
  clause naming both directions; repeat it in the PR body.
- No new writer, Y.Doc write, `data-testid`, route or MCP tool.

## Tests

`tests/server/integrations/apply.test.ts` — the existing `describe("applyConfig — 5MB size guard")`
(`:317-364`) is **rewritten in place, not deleted**: renamed `applyConfig — config size guard`, both
boundaries derived from the exported constant, neither existing case dropped.

1. `"accepts a config under the cap"` — a fixed, modest under-cap payload (not
   `"x".repeat(MAX_CONFIG_BYTES - 1024)`, which would materialise and re-serialise ~16 MiB every
   run). Read the file back and assert `mcpServers.tandem.url`; not-throwing alone is satisfied by a
   silent no-op.
2. `"rejects a config above the cap"` — built sparsely (`writeFileSync(p, "")` then
   `truncateSync(p, MAX_CONFIG_BYTES + 1)`), asserting `ConfigRefusalError` with
   `reason === "CONFIG_TOO_LARGE"`, **keeping today's `toThrow(/refusing to read/)`** (both CLI
   printers emit `err.message` and nothing else pins that text), and proving nothing was written
   with `statSync(p).size` plus an unchanged `mtimeMs` — not a byte comparison.
3. New: a **6 MiB** well-formed config applies and keeps its other `mcpServers` entries. The
   discriminating case — red on today's cap, green only if it moved.
4. New: `MAX_CONFIG_BYTES >= 16 * 1024 * 1024`, so a later tidy-up cannot walk it back down.

`tests/server/integrations/api-routes.test.ts`, beside the `ERROR_CODE_PATH_REJECTED` spec at
`:1286`: an apply against an oversize config returns `status: "error"` with
`code: "CONFIG_TOO_LARGE"`, and the `message` contains neither the path nor a byte count. Build the
fixture with the sparse `truncateSync` form — `applyConfig` is a direct import (`api-routes.ts:88`,
called at `:939`) and is not in `IntegrationsRoutesDeps`, so there is no seam to stub.

`tests/client/integration-wizard-push-support.test.ts` — mount a done screen with
`{status:"error", code:"CONFIG_TOO_LARGE"}` and assert the result row contains "too large for Tandem
to rewrite safely". `resultErrorText`'s `default` arm falls back to `result.message`, so a missing
`case` is otherwise invisible.

No boot-sweep test is added: that log line exists and is unchanged — cite `:1893-1899` in the PR
body so the issue's third bullet closes on evidence rather than silence.

## Done when

The cap is 16 MiB with a docblock stating the new bound, its parse cost and that the number is an
unmeasured judgment; a 6 MiB config applies; an oversize config refuses with `CONFIG_TOO_LARGE`
through the CLI message and the wizard result, each pinned by a test; case (4) pins the floor; the
`docs/security.md` #1599 clause lands with the cap change; typecheck + the touched suites green.

## Not in scope

**`src/cli/doctor.ts`** — it reports an oversize config as `ok` and this branch does not change
that; see the scope-cut note below. `readConfigForMutation`'s `skipped` reasons and their callers
(behaviour unchanged; what they *cover* moves, which is the `docs/security.md` clause). Whether the
wizard should offer to trim the config.

## Review corrections (scope cut)

Rounds 1–3 are superseded by this cut.

**Removed**

- **The whole `src/cli/doctor.ts` change** — a new `oversize` member on `ClaudeConfigRead`, a
  `statSync` in `readClaudeConfig`, and warn arms at three of its four call sites. #1801 names
  `apply.ts`, the wizard and the boot sweep; doctor was spec-grown, and it carried every remaining
  blocking finding here: the stat's placement relative to `rejectUnsafeWindowsPrefix` (#1417's
  UNC/SMB screen, which `tests/cli/doctor-path-safety.test.ts` cannot see because its own `node:fs`
  mock stubs `statSync` as containment), the ENOENT arm that keeps `readClaudeConfig` total on the
  commonest path of all, the TS2339 at `:1163`/`:1537` from the new union member, and the forbidden
  `read.kind !== "ok"` widening that prints "is not valid JSON" about a valid file. Removing the
  bullet makes all four moot rather than repairing them. Carried through: the wizard message drops
  its `tandem doctor` pointer, and `tests/cli/doctor.test.ts` and `doctor-path-safety.test.ts` leave
  the ledger. **For Bryan:** doctor still reports an over-cap `~/.claude.json` as `ok`. That gap is
  real, is not closed here, and should be its own issue rather than a rider on this one.
- **Moving `MAX_CONFIG_BYTES` to `src/shared/integrations/contract.ts`**, whose only justification
  was giving `doctor.ts` an import free of `apply.ts`'s module-load side effects. The constant stays
  put; only `export` is added, for the tests.
- The 64-MiB-vs-16-MiB and `ANNOTATION_SCAN_*` comparisons, and the round-1/2/3 correction logs.

**Kept**

- One `docs/security.md` sentence on the #1599 entry — a record, not a mechanism: raising a cap that
  gates `readConfigForMutation` moves the 5–16 MiB population into both the boot sweep's
  read-modify-write and the uninstall scrub's reach, and CLAUDE.md requires an accepted finding's
  bound to be re-stated when a change moves it.
