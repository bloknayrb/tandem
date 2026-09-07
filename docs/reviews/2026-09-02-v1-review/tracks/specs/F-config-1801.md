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

- **`apply.ts:223`** — `MAX_CONFIG_BYTES = 16 * 1024 * 1024`, exported so a test can assert the
  floor without duplicating the literal. The value is justified from the sizes this issue reports,
  not from an unrelated constant: the file's own sweep comment calls a real `~/.claude.json`
  "routinely multi-megabyte", and 16 MiB clears that with a wide margin while keeping the parse
  budget bounded. (The nearest repo analogue is the **per-file** cap
  `ANNOTATION_SCAN_MAX_FILE_BYTES = 8 * 1024 * 1024`, `src/cli/annotation-store-scan.ts:55`, not the
  whole-scan total `ANNOTATION_SCAN_MAX_TOTAL_BYTES`.)
- **Rewrite the constant's docblock (`apply.ts:216-222`).** Both of its present claims become false
  the moment the cap moves: "the realistic `.claude.json` is single-digit kilobytes" and "the cap is
  generous enough that no legitimate user hits it" are exactly what #1801 refutes. The replacement
  states the new bound and its **cost**, which is the thing a later reader needs: the cap bounds an
  in-memory read, and both readers parse synchronously — `applyConfig` at `:1014` (`statSync`) and
  `:1034` (`readFileSync`) blocks the server on the wizard route, and `readConfigForMutation`'s
  `JSON.parse` runs on the pre-launcher startup sweep (`:1883-1886`), whose own docblock advertises
  async I/O but not an async parse. Raising the cap moves that budget with it. No code change beyond
  the constant.
- **New `ConfigRefusalError` in `apply.ts`**, modelled directly on the sibling `PathRejectedError`
  (`:285-293`) — same file, same throw path, same catch chain, **and the same field name**:
  ```ts
  export class ConfigRefusalError extends Error {
    override readonly name = "ConfigRefusalError";
    constructor(readonly reason: "CONFIG_TOO_LARGE" | "CONFIG_MALFORMED", message: string) { super(message); }
  }
  ```
  `reason`, **not `code`**: `code` is the Node errno convention that `applyConfig` itself branches
  on twice in the same try/catch (`:1020`, `:1057`), so a `.code` on a new error class shadows it on
  a security-sensitive path. `PathRejectedError` uses `reason` for exactly this reason.
  `applyConfig`'s size guard throws `new ConfigRefusalError("CONFIG_TOO_LARGE", …)` with today's
  message (path, size, cap) — the CLI already prints it. `CONFIG_MALFORMED` is thrown by #1802's
  half of this branch; the class lands here because this spec is implemented first.
- **`src/shared/integrations/contract.ts:245-254`** — add
  `export const ERROR_CODE_CONFIG_TOO_LARGE = "CONFIG_TOO_LARGE"` (and, for #1802,
  `ERROR_CODE_CONFIG_MALFORMED`) to the `ApplyItemErrorCode` union. The class's `reason` values are
  these wire codes verbatim, so the route arm maps one to the other with no table.
- **`src/server/integrations/api-routes.ts`**, in the existing `catch` around `applyConfig`
  (`:942-969`), a new arm *above* the generic one, in the `PathRejectedError` shape: log `err`
  server-side, return `errorResult(entry.id, err.reason, <static message>)`. The static message
  carries no path and no byte counts — `ApplyItemResult.message` is the leak-safe field
  (`contract.ts:258-262`) and this route is reachable from the browser. The route's
  `assertOriginAllowlisted` + `assertLoopbackForMutation` at handler top are untouched, and
  `NON_LOOPBACK_ALLOWED` does not grow.
- **`IntegrationWizardModal.svelte#resultErrorText`** — one `case` per new code, in the file's
  plain-language register: too-large → "Your Claude settings file is too large for Tandem to
  rewrite safely, so Tandem left it alone." **No `tandem doctor` pointer**: `readClaudeConfig`
  (`src/cli/doctor.ts:600-623`) does a bare `readFileSync` with no `stat` and no size branch — its
  `ClaudeConfigRead` kinds are `unsafe-path | absent | unreadable | malformed | ok` — so an
  oversized config reports `ok` and doctor says nothing about size. Naming a command that answers
  nothing is a worse message than the one being replaced. Adding an `oversize` kind to doctor is
  out of scope for this Medium row; the message states the actionable fact instead.
- No new writer, so `tests/docs/config-writer-set-claims.test.ts` is unaffected by *this* spec
  (#1802 removes one). No Y.Doc write, no `data-testid`, no new route or MCP tool, so Critical
  Rules 1/2/7/9 do not bite.

## Tests

`tests/server/integrations/apply.test.ts` — the existing `describe("applyConfig — 5MB size guard")`
(`:317-364`) is **rewritten in place, not deleted**: rename it to `applyConfig — config size guard`
and derive both boundary payloads from the exported `MAX_CONFIG_BYTES` rather than a 5 MiB literal,
so the boundary stays pinned to whatever the cap becomes. Neither of its two cases may be dropped.

1. `"accepts a config just under the cap"` — padding of `MAX_CONFIG_BYTES - 1024`, read the file
   back and assert `mcpServers.tandem.url` (not-throwing alone is satisfied by a silent no-op).
   Off-by-one pin, derived from the constant.
2. `"rejects a config above the cap"` — replaces today's `"x".repeat(5 MiB + 1)` body with the
   sparse form: `writeFileSync(p, "")` then `truncateSync(p, MAX_CONFIG_BYTES + 1)`, so no 16 MiB
   of bytes is written and the size guard throws before any read. Assert `ConfigRefusalError` with
   `reason === "CONFIG_TOO_LARGE"` and that the file is byte-identical. Kills a fix that raises the
   cap and leaves the refusal as a bare `Error` the route cannot classify.
3. New: a **6 MiB** well-formed config (one large string field) applies successfully and keeps its
   other `mcpServers` entries. This is the discriminating test — red on today's 5 MiB cap, green
   only if the cap actually moved. It does not duplicate (1): (1) tracks the constant wherever it
   goes, (3) pins that the constant went *past the size the issue reports*. Kills a fix that only
   improves the error text.
4. New: `MAX_CONFIG_BYTES >= 16 * 1024 * 1024`. Cheap, and kills a later "tidy-up" that walks the
   cap back down without noticing this issue.

`tests/server/integrations/api-routes.test.ts`, beside the `ERROR_CODE_PATH_REJECTED` spec at
`:1286`: an apply whose `applyConfig` rejects with `ConfigRefusalError("CONFIG_TOO_LARGE")` returns
`status: "error"` with that `code`, and the response `message` contains neither the config path nor
a byte count. Kills the generic `WRITE_FAILED` fallback and pins the leak rule.

No boot-sweep test is added: that log line exists and is unchanged. Say so in the PR body with the
`:1893-1899` citation, so the issue's third bullet is closed by evidence rather than by silence.

## Done when

The cap is 16 MiB and exported, and its docblock states the new bound and its parse cost; a 6 MiB
config applies; an oversize config refuses with `CONFIG_TOO_LARGE` through both the CLI message and
the wizard result, and the wizard message names no command that cannot answer; the rewritten size
guard derives its boundaries from the constant; the sweep's existing `oversize` log is cited in the
PR body; typecheck + the touched suites green.

## Not in scope

`readConfigForMutation`'s `skipped` reasons and their callers (unchanged — only the cap they read
moves), **though its parse budget on the pre-launcher startup sweep moves with the cap; that is
accepted here and recorded in the docblock rather than mitigated.** Adding an `oversize` kind to
`doctor`'s `readClaudeConfig` / `ClaudeConfigRead`. `doctor`'s own JSON reads. Whether the wizard
should offer to trim the config.

## Review corrections (round 1)

**Adopted**

- *(blocking)* The wizard's too-large message pointed at `tandem doctor`, which has no size check —
  `readClaudeConfig` reports an oversized config as `ok`. Took option (a): the pointer is dropped
  and the message states the actionable fact. Adding the missing doctor branch is named in "Not in
  scope" so the choice is explicit rather than an omission.
- *(blocking, twice)* The existing `describe("applyConfig — 5MB size guard")` (`:317-364`) asserts
  rejection at 5 MiB + 1 and would have gone red with no stated repair. Its rewrite is now the
  Tests section's spine: renamed, both cases derived from the exported `MAX_CONFIG_BYTES`, neither
  deletable, and the over-cap case absorbs the sparse-`truncateSync` refusal so nothing duplicates.
- `ConfigRefusalError`'s field renamed `code` → `reason`, matching `PathRejectedError` and avoiding
  the Node errno shadow that `applyConfig` branches on twice in the same try/catch. The api-routes
  arm maps `err.reason` to the wire code.
- The cap's docblock (`apply.ts:216-222`) is rewritten: its "single-digit kilobytes" and "no
  legitimate user hits it" claims are what this issue refutes, and the replacement records the
  event-loop cost on the wizard route and the pre-launcher sweep. Added to "Not in scope" that the
  sweep's parse budget moves with the cap.
- The 64 MiB rationale rested on a misread: `ANNOTATION_SCAN_MAX_TOTAL_BYTES` is the whole-scan
  total; the per-file analogue is 8 MiB. The cap is now **16 MiB**, justified from the sizes the
  issue reports, with a quarter of 64 MiB's parse cost on the startup path. Test 1's 6 MiB payload
  and the `>= 16 MiB` floor assertion are unchanged in kind.

**Not adopted**

- None.
