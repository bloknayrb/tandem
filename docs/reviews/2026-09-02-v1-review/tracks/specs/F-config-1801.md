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

  **State plainly, in the docblock and the PR body, that 16 MiB is a judgment with essentially no
  measured input.** The ledger row it derives from
  (`docs/reviews/2026-09-02-v1-review/areas/server-runtime.md:19`) is `[read]` with Evidence
  "Agent-reported" and records no size at all; the only measurement taken for this spec is one real
  `~/.claude.json` on the development machine at **121,720 bytes (~119 KiB)** — three orders of
  magnitude *under* both the old cap and the sweep comment's own "routinely multi-megabyte" claim,
  which is therefore unverified in both directions. So the cap is not the durable half of this fix:
  a later measurement may move it up or down, and should be able to without re-litigating. **The
  durable half is the legible `CONFIG_TOO_LARGE` refusal** — whatever the number, a user who hits it
  now learns what happened instead of being told the file is open in another program.
- **Rewrite the constant's docblock (`apply.ts:216-222`).** Both of its present claims become false
  the moment the cap moves: "the realistic `.claude.json` is single-digit kilobytes" and "the cap is
  generous enough that no legitimate user hits it" are exactly what #1801 refutes. The replacement
  states the new bound and its **cost**, which is the thing a later reader needs: the cap bounds an
  in-memory read, and both readers parse synchronously — `applyConfig` at `:1014` (`statSync`) and
  `:1034` (`readFileSync`) blocks the server on the wizard route, and `readConfigForMutation`'s
  `JSON.parse` runs on the pre-launcher startup sweep (`:1883-1886`), whose own docblock advertises
  async I/O but not an async parse. Raising the cap moves that budget with it. No code change beyond
  the constant.
- **`docs/security.md`, the #1599 entry — one clause, because raising the cap WIDENS an accepted
  finding.** `readConfigForMutation` returns `{status:"skipped", reason:"oversize"}` above the cap
  (`apply.ts:1249`) and `refreshAllMcpEntryBinaries` `continue`s without writing (`:1901`), so every
  config in the **5–16 MiB band is immune to the boot sweep today** and becomes exposed the moment
  the cap moves: below the cap the sweep falls through to the full-root writeback at `:1957`, which
  `docs/security.md:447` names as the writer that resurrects a live bearer token after
  `uninstall-scrub.ts:453` and `:449` names as the writer that silently drops a fresh install while
  reporting success. That is exactly the "routinely multi-megabyte" population this issue is about,
  moving from immune to covered. **This is a risk-widening change and must be recorded** — add a
  clause to the #1599 entry stating that raising `MAX_CONFIG_BYTES` enlarges the set of configs the
  sweep read-modify-writes, and say so in the PR body. No code change; one sentence. (The
  asymmetry to avoid: `F-config-1802.md` already requires a `docs/security.md:453` clause for its
  own writer-count change, and that one *reduces* risk.)
- **`src/cli/doctor.ts` — add the missing `oversize` kind, ~6 lines, in the same branch.** Without
  it the new refusal names a condition doctor reports as `ok`, and the "Not in scope" deferral would
  be untracked. `readClaudeConfig` (`:600-623`) does a bare `readFileSync` with no size branch and
  its `ClaudeConfigRead` union (`:548-555`) has no oversize member. Add `statSync` to the `node:fs`
  import (`:27`), a `| { kind: "oversize" }` member, a `statSync(path).size > MAX_CONFIG_BYTES`
  branch **before** the read (the point is not to read it), and one warn arm beside the `malformed`
  / `unreadable` ternary at `:1149-1158`: "~/.claude.json is too large for Tandem to rewrite
  safely", fix "Tandem will not rewrite a config this large. Nothing was changed." Path-free and
  size-free — this text reaches Copy Diagnostics. This is the two-person "fix it rather than file
  it" rule applied to a five-line gap in a file this branch already edits (`F-config-1802.md`
  rewrites two other sites in it).
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
  rewrite safely, so Tandem left it alone. Run `tandem doctor` for the full check." The pointer is
  **restored** only because the doctor bullet above adds the `oversize` kind in this same branch;
  if that bullet is dropped, the pointer must go with it — naming a command that answers nothing is
  worse than the message being replaced.
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
   `reason === "CONFIG_TOO_LARGE"`, and prove nothing was written with
   **`statSync(p).size === MAX_CONFIG_BYTES + 1` plus an unchanged `mtimeMs`** — *not* a byte
   comparison, which would materialise and string-compare two 16 MiB buffers and print a 16 MB diff
   on failure. The guard is a `statSync` before any read (`apply.ts:1012-1022`), so a content
   assertion proves nothing extra. Kills a fix that raises the cap and leaves the refusal as a bare
   `Error` the route cannot classify.
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
a byte count. Kills the generic `WRITE_FAILED` fallback and pins the leak rule. **Build the fixture
with `writeFileSync(p, "")` + `truncateSync(p, MAX_CONFIG_BYTES + 1)` — the file must really be
oversize.** `applyConfig` is a *direct import* in this route (`api-routes.ts:88`, called at `:939`);
`IntegrationsRoutesDeps` injects `detectTargets` and `shouldRegisterChannelShim` but **not**
`applyConfig`, so there is no seam to stub it through, and a naive `"x".repeat(...)` write is the
obvious wrong turn.

`tests/client/integration-wizard-push-support.test.ts` — mirror #1802's wizard assertion: mount a
done screen with `{status:"error", code:"CONFIG_TOO_LARGE"}` and assert
`[data-testid="integration-wizard-apply-result-<id>"]` contains "too large for Tandem to rewrite
safely". "Done when" claims the refusal reaches *the wizard result*, and `resultErrorText`'s
`default` arm falls back to `result.message`
(`src/client/components/IntegrationWizardModal.svelte:503-518`), so a missing `case` is invisible —
the same hazard #1802 covers for `CONFIG_MALFORMED`. Cheap, and the only thing that pins the wizard
half of this issue.

`tests/cli/doctor.test.ts` — one case for the new `oversize` arm: a `~/.claude.json` above
`MAX_CONFIG_BYTES` (same sparse `truncateSync` fixture) produces the "too large" warn, and the `fix`
string contains neither the path nor a byte count. Without it the wizard's restored `tandem doctor`
pointer is again a promise nothing keeps.

No boot-sweep test is added: that log line exists and is unchanged. Say so in the PR body with the
`:1893-1899` citation, so the issue's third bullet is closed by evidence rather than by silence.

## Done when

The cap is 16 MiB and exported, and its docblock states the new bound, its parse cost and that the
number is an unmeasured judgment; a 6 MiB config applies; an oversize config refuses with
`CONFIG_TOO_LARGE` through the CLI message, the wizard result (pinned by a client test) and
`tandem doctor`'s new `oversize` arm; the rewritten size guard derives its boundaries from the
constant; the `docs/security.md` #1599 clause recording the sweep's widened population lands with
the cap change; the sweep's existing `oversize` log is cited in the PR body; typecheck + the touched
suites green.

## Not in scope

`readConfigForMutation`'s `skipped` reasons and their callers — **their behaviour is unchanged, but
what they cover is not, and that is recorded rather than deferred**: the boot sweep's parse budget
on the pre-launcher startup path moves with the cap (accepted, recorded in the docblock), and the
5–16 MiB band moves from sweep-immune to sweep-covered, which is the `docs/security.md` #1599 clause
in "Fix". `doctor`'s own JSON reads beyond the new `oversize` branch. Whether the wizard should
offer to trim the config.

## Review corrections (round 1)

**Adopted**

- *(blocking — **superseded in round 2**)* The wizard's too-large message pointed at
  `tandem doctor`, which has no size check — `readClaudeConfig` reports an oversized config as `ok`.
  Took option (a): the pointer dropped, the missing doctor branch named in "Not in scope". Round 2
  reversed this to option (b) — doctor gains the `oversize` kind in this branch and the pointer is
  restored — because "Not in scope" with no issue number is an untracked deferral.
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

## Review corrections (round 2)

**Adopted**

- *(blocking)* The spec called `readConfigForMutation`'s callers "unchanged — only the cap they read
  moves", which is false about what they *cover*: `apply.ts:1249` skips and `:1901` `continue`s
  above the cap, so configs in the 5–16 MiB band are sweep-immune today and become read-modify-
  written at `:1957` after the raise — moving the "routinely multi-megabyte" population this issue
  is about into #1599's two credential/data-loss cases with nothing recorded. Struck the
  parenthetical, and added a Fix bullet requiring one clause on the `docs/security.md` #1599 entry
  plus a line in the PR body. (The asymmetry the reviewer flagged is real: `F-config-1802.md`
  already records its *risk-reducing* writer-count change.)
- *(non-blocking)* 16 MiB has no measured basis — the ledger row is `[read]`/"Agent-reported" with
  no size. The cap bullet now says so, cites the one measurement taken (a real `~/.claude.json` on
  this machine at 121,720 bytes, which also leaves the sweep comment's "routinely multi-megabyte"
  unverified), and names the legible `CONFIG_TOO_LARGE` refusal — not the number — as the durable
  half, so a later measurement can move it freely.
- *(non-blocking)* Test 2's "byte-identical" assertion replaced with `statSync(p).size` + unchanged
  `mtimeMs`: the guard is a `statSync` before any read, so comparing two 16 MiB buffers proves
  nothing and prints a 16 MB diff on failure.
- *(non-blocking)* The api-routes spec now states how to build the fixture: `applyConfig` is a
  direct import at `api-routes.ts:88` (called at `:939`) and is **not** in
  `IntegrationsRoutesDeps`, so the file must really be oversize — sparse `truncateSync`, never
  `"x".repeat(...)`.
- *(non-blocking)* Added the wizard assertion for `CONFIG_TOO_LARGE` to
  `tests/client/integration-wizard-push-support.test.ts`. "Done when" claimed the wizard result and
  nothing pinned it; `resultErrorText`'s `default` arm falls back to `result.message`
  (`IntegrationWizardModal.svelte:503-518`), so a missing `case` is invisible — the same hazard
  #1802 already covers for `CONFIG_MALFORMED`.
- *(non-blocking, reversing a round-1 decision)* Adopted the `oversize` kind in `src/cli/doctor.ts`
  rather than deferring it: ~6 lines (a `statSync` import, a union member, a size branch before the
  read, one warn arm) in a file this branch already edits, plus one `doctor.test.ts` case. The
  wizard's `tandem doctor` pointer is restored on that condition. Round 1's "Not in scope" naming
  carried no issue number, which is an untracked deferral; the two-person rule is to fix a
  five-line gap found in passing.

**Not adopted**

- None.

**File-set change:** this spec now also touches `docs/security.md` (the #1599 entry),
`src/cli/doctor.ts`, `tests/cli/doctor.test.ts` and
`tests/client/integration-wizard-push-support.test.ts`.
