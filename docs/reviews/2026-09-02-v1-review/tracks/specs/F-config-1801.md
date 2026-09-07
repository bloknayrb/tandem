# F-config — #1801 `MAX_CONFIG_BYTES` (5 MiB) refuses a routinely multi-megabyte `~/.claude.json` with a generic `WRITE_FAILED`

Branch `fix/push-paths-config-1760`. Closes #1801. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/server-runtime.md:19` (M, `[read]`). No experiment was
run for this row; the probe is the read of `apply.ts` plus the boot-sweep log path below.

## Problem

`MAX_CONFIG_BYTES = 5 * 1024 * 1024` (`src/server/integrations/apply.ts:223`) gates both readers of
`~/.claude.json`: `applyConfig` (`:1011-1022`, throws) and `readConfigForMutation` (`:1249`,
returns `{status:"skipped", reason:"oversize"}`). The sweep's own comment
(`refreshAllMcpEntryBinaries`, `:1880-1886`) calls that file "routinely multi-megabyte" because
Claude Code stores per-project history in it. Over the cap:

- `tandem setup --apply` prints the thrown message — which does at least name the size and the cap.
- The wizard maps every `applyConfig` throw to `ERROR_CODE_WRITE_FAILED` with "Failed to apply
  config — see server logs" (`src/server/integrations/api-routes.ts:961-967`), and the modal renders
  "Couldn't write the settings file — check it isn't open in another program"
  (`IntegrationWizardModal.svelte:505-506`), which is wrong and unactionable.
- The boot sweep skips, leaving a stale node path.

**One third of the issue is already fixed and must not be re-implemented.** The issue's third
bullet asks the boot sweep to log when it skips for this reason; `refreshAllMcpEntryBinaries`
already does — `:1893-1899` logs `Left <label> untouched (oversize). Run 'tandem doctor' for the
full check.` for every `skipped` reason. The remaining gap is the cap itself and the wizard's
mistranslation.

## Fix

- **`apply.ts:223`** — `MAX_CONFIG_BYTES = 64 * 1024 * 1024`. Keep it a guard, not a judgement:
  the comment says it bounds the in-memory read (`readFileSync` + `JSON.parse`), and that 5 MiB
  was under the size of real configs the file's own sweep comment describes. 64 MiB matches
  `ANNOTATION_SCAN_MAX_TOTAL_BYTES` (`src/cli/annotation-store-scan.ts:59`), so the repo keeps one
  order of magnitude for "a local file we will parse whole". Export it, so a test can assert the
  floor without duplicating the literal.
- **New `ConfigRefusalError` in `apply.ts`**, modelled directly on the sibling `PathRejectedError`
  (`:283-293`) — same file, same throw path, same catch chain:
  ```ts
  export class ConfigRefusalError extends Error {
    override readonly name = "ConfigRefusalError";
    constructor(readonly code: "CONFIG_TOO_LARGE" | "CONFIG_MALFORMED", message: string) { super(message); }
  }
  ```
  `applyConfig`'s size guard throws `new ConfigRefusalError("CONFIG_TOO_LARGE", …)` with today's
  message (path, size, cap) — the CLI already prints it. `CONFIG_MALFORMED` is thrown by #1802's
  half of this branch; the class lands here because this spec is implemented first.
- **`src/shared/integrations/contract.ts:245-254`** — add
  `export const ERROR_CODE_CONFIG_TOO_LARGE = "CONFIG_TOO_LARGE"` (and, for #1802,
  `ERROR_CODE_CONFIG_MALFORMED`) to the `ApplyItemErrorCode` union.
- **`src/server/integrations/api-routes.ts`**, in the existing `catch` around `applyConfig`
  (`:942-969`), a new arm *above* the generic one, in the `PathRejectedError` shape: log `err`
  server-side, return `errorResult(entry.id, err.code, <static message>)`. The static message
  carries no path and no byte counts — `ApplyItemResult.message` is the leak-safe field
  (`contract.ts:258-262`) and this route is reachable from the browser. The route's
  `assertOriginAllowlisted` + `assertLoopbackForMutation` at handler top are untouched, and
  `NON_LOOPBACK_ALLOWED` does not grow.
- **`IntegrationWizardModal.svelte#resultErrorText`** — one `case` per new code, in the file's
  plain-language register: too-large → "Your Claude settings file is larger than Tandem will read.
  Run `tandem doctor` for details."
- No new writer, so `tests/docs/config-writer-set-claims.test.ts` is unaffected by *this* spec
  (#1802 removes one). No Y.Doc write, no `data-testid`, no new route or MCP tool, so Critical
  Rules 1/2/7/9 do not bite.

## Tests

`tests/server/integrations/apply.test.ts` (scratch tmp config, `TANDEM_APP_DATA_DIR` set):

1. A **6 MiB** well-formed config (one large string field) applies successfully and keeps its other
   `mcpServers` entries. This is the discriminating test: it is red on today's 5 MiB cap and green
   only if the cap actually moved. Kills a fix that only improves the error text.
2. `MAX_CONFIG_BYTES >= 64 * 1024 * 1024`. Cheap, and kills a later "tidy-up" that walks the cap
   back down without noticing this issue.
3. Oversize refusal shape: create the file with `writeFileSync(p, "")` then
   `truncateSync(p, MAX_CONFIG_BYTES + 1)` — sparse, so no 64 MiB of bytes is written, and the
   size guard throws before any read. Assert `ConfigRefusalError` with `code === "CONFIG_TOO_LARGE"`
   and that the file is byte-identical. Kills a fix that raises the cap and leaves the refusal as a
   bare `Error` the route cannot classify. (If the truncate proves slow on a CI runner, drop this
   case to the route test below and say so — do not add a size seam to production code.)

`tests/server/integrations/api-routes.test.ts`, beside the `ERROR_CODE_PATH_REJECTED` spec at
`:1286`: an apply whose `applyConfig` rejects with `ConfigRefusalError("CONFIG_TOO_LARGE")` returns
`status: "error"` with that `code`, and the response `message` contains neither the config path nor
a byte count. Kills the generic `WRITE_FAILED` fallback and pins the leak rule.

No boot-sweep test is added: that log line exists and is unchanged. Say so in the PR body with the
`:1893-1899` citation, so the issue's third bullet is closed by evidence rather than by silence.

## Done when

The cap is 64 MiB and exported; a 6 MiB config applies; an oversize config refuses with
`CONFIG_TOO_LARGE` through both the CLI message and the wizard result; the sweep's existing
`oversize` log is cited in the PR body; typecheck + the touched suites green.

## Not in scope

`readConfigForMutation`'s `skipped` reasons and their callers (unchanged — only the cap they read
moves). `doctor`'s own JSON reads. Whether the wizard should offer to trim the config.
