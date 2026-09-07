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

- **The cap moves to `src/shared/integrations/contract.ts` and becomes `16 * 1024 * 1024`.**
  `export const MAX_CONFIG_BYTES = 16 * 1024 * 1024;` lands there, beside the new
  `ERROR_CODE_CONFIG_TOO_LARGE`, and `apply.ts` imports it (deleting the local `const` at `:223`);
  `src/cli/doctor.ts` imports it from the same place. **Not exported from `apply.ts`**, which was
  round 2's shape: `doctor.ts`'s docblock (`:22-23`) constrains it to "Pure Node.js built-ins only
  … so the module bundles cleanly and the standalone shim can mirror it", and `apply.ts` would drag
  in `node:crypto`, `./acl-win.js`, `../platform.js`, the whole `SKILL_CONTENT` payload (`:46`) and
  a **module-load `readFileSync`** — `const CLI_VERSION = resolveCliVersion()` at `:214` runs at
  import time and reads `package.json` on the tsx/vitest path. `tests/cli/doctor-path-safety.test.ts`
  also replaces `node:fs` for everything in doctor's graph, so that side effect would land inside a
  mocked-fs suite. `contract.ts` is a leaf with **no imports at all**, and `doctor.ts` already reaches
  it (`:44`, today a type-only import), so this adds no runtime edge doctor did not already have in
  spirit. The value is justified from the sizes this issue reports,
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
- **Rewrite the constant's docblock, which travels with it** (today `apply.ts:216-222`, after the
  move `src/shared/integrations/contract.ts`). Both of its present claims become false
  the moment the cap moves: "the realistic `.claude.json` is single-digit kilobytes" and "the cap is
  generous enough that no legitimate user hits it" are exactly what #1801 refutes. The replacement
  states the new bound and its **cost**, which is the thing a later reader needs: the cap bounds an
  in-memory read, and both readers parse synchronously — `applyConfig` at `:1014` (`statSync`) and
  `:1034` (`readFileSync`) blocks the server on the wizard route, and `readConfigForMutation`'s
  `JSON.parse` runs on the pre-launcher startup sweep (`:1883-1886`), whose own docblock advertises
  async I/O but not an async parse. Raising the cap moves that budget with it. No behaviour change
  beyond the constant's value and its new home.
- **`docs/security.md`, the #1599 entry — one clause naming BOTH directions, because raising the cap
  moves two of its callers at once.** `readConfigForMutation` returns `{status:"skipped", reason:"oversize"}` above the cap
  (`apply.ts:1249`) and `refreshAllMcpEntryBinaries` `continue`s without writing (`:1901`), so every
  config in the **5–16 MiB band is immune to the boot sweep today** and becomes exposed the moment
  the cap moves: below the cap the sweep falls through to the full-root writeback at `:1957`, which
  `docs/security.md:447` names as the writer that resurrects a live bearer token after
  `uninstall-scrub.ts:453` and `:449` names as the writer that silently drops a fresh install while
  reporting success. That is exactly the "routinely multi-megabyte" population this issue is about,
  moving from immune to covered. **This is a risk-widening change and must be recorded** — add a
  clause to the #1599 entry saying so, and say so in the PR body. No code change; one sentence.
  (The asymmetry to avoid: `F-config-1802.md` already requires a `docs/security.md:453` clause for
  its own writer-count change, and that one *reduces* risk.)

  **The clause must name both directions, in one sentence.** `apply.ts:1249` gates *every*
  `readConfigForMutation` caller, and its docblock at `:1237` names `removeConfigEntries` as one of
  the two — the uninstall scrub (`uninstall-scrub.ts:453`), which the #1599 entry's own
  *"Uninstall — does **not** fail closed"* bullet calls the sharp edge because a surviving entry
  "carries a *live, indefinitely valid* credential". Today a 5–16 MiB config makes that scrub
  **skip**; after the raise it is actually scrubbed. So the same move enlarges the set the boot
  sweep read-modify-writes (risk-widening) **and** the set the uninstall scrub can clean
  (risk-reducing, touching the credential-remanence bullet). A clause that records only the sweep
  half tells a later reader half the truth about a bullet the entry itself flags as the sharp edge.
- **`src/cli/doctor.ts` — add the missing `oversize` kind, in the same branch.** Without it the new
  refusal names a condition doctor reports as `ok`, and the "Not in scope" deferral would be
  untracked. `readClaudeConfig` (`:600-623`) does a bare `readFileSync` with no size branch and its
  `ClaudeConfigRead` union (`:548-555`) has no oversize member. Add `statSync` to the `node:fs`
  import (`:27`), import `MAX_CONFIG_BYTES` from `../shared/integrations/contract.js`, add a
  `| { kind: "oversize" }` member, and then — **the placement and the error contract are the whole
  of this bullet, and getting either wrong is a real bug the suite cannot see:**

  ```ts
  export function readClaudeConfig(path: string): ClaudeConfigRead {
    if (rejectUnsafeWindowsPrefix(path) !== null) return { kind: "unsafe-path" };
    let raw: string;
    try {
      if (statSync(path).size > MAX_CONFIG_BYTES) return { kind: "oversize" };
      raw = readFileSync(path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "absent" };
      return { kind: "unreadable" };
    }
    // …unchanged from here
  ```

  Two rules, both load-bearing:

  1. **The stat goes AFTER `rejectUnsafeWindowsPrefix`, never before the read in the sense of
     "above the path screen".** That first line exists so no syscall touches a hostile path (#1417):
     CLAUDE.md's rule is that a UNC path must be refused "**before** any filesystem call — `is_file()`
     on a network path performs the SMB handshake the check exists to prevent". A `statSync` hoisted
     above it re-opens the NTLM-relay leak, and **`tests/cli/doctor-path-safety.test.ts` is
     structurally unable to catch it**: its assertion is `expect(_readFileSyncSpy).not.toHaveBeenCalled()`
     (`:437-440`), and its own `node:fs` mock stubs `statSync` for hostile prefixes as deliberate
     CONTAINMENT that "asserts nothing" (`:58-86`, comment at `:71-74`). A misplaced stat is
     therefore silently refused in test, green, and shipping a real
     `statSync("\\\\attacker\\share\\.claude.json")` on Windows.
  2. **The stat goes INSIDE the existing `try`, so the function stays total.** `ClaudeConfigRead`
     has no error member and every call site is unguarded; a bare `statSync` throws ENOENT on the
     **commonest** path (no `~/.claude.json`, i.e. every fresh install) and EACCES/ELOOP on the
     redirected-profile one, and `Recorder.check` turns that into
     `fail("user-mcp-config check crashed (Error) …", "Please report this at …/issues")` — a clean
     warn with a remedy becomes a file-a-bug line, and `tandem doctor` / `tandem_diagnostics` crash
     where they used to report. Inside the try, ENOENT still answers `absent` and EACCES/EISDIR/ELOOP
     still answer `unreadable`, so **`tests/cli/doctor-path-safety.test.ts:450-464` stays green
     unchanged** (`absent.json` → `absent`; the directory case still reaches `readFileSync` and
     EISDIR because a directory's `size` is far under the cap).

  **All four call sites, and what happens at each** — `readClaudeConfig` is called at `:1110`,
  `:1492`, `:1939` and `:1944`, and two of them read `read.value` after exhausting the known kinds,
  so a new union member is a **typecheck failure** there unless an arm is added:

  - **`:1110` (`checkUserMcpConfig`, `~/.claude.json`)** — a dedicated
    `if (read.kind === "oversize") { r.warn(…); return; }` **above** the
    `unreadable || malformed` check at `:1130`. Message "~/.claude.json is too large for Tandem to
    rewrite safely", fix "Tandem will not rewrite a config this large. Nothing was changed."
    Path-free and size-free — this text reaches Copy Diagnostics.
    **Not** an arm inside the `:1149-1158` ternary, which round 2 said: that ternary sits *inside*
    the block guarded by `:1130`, so an arm added there is unreachable and the TS2339 at `:1163`
    survives.
  - **`:1492` (`checkDesktopMcpConfig`)** — its own dedicated arm, above the merged
    `unreadable || malformed` check at `:1513`, with the same two sentences worded for the desktop
    config and keeping the `DESKTOP_RESTART_NOTE` hop. **#1801 owns this arm; #1802's rewording of
    that site is scoped to `unreadable || malformed` and does not touch it.**
  - **Forbidden repair:** widening either predicate to `read.kind !== "ok"`. It clears the type error
    and makes doctor print "is not valid JSON" / "could not be read as JSON" about a file that is
    valid and readable — the exact mistranslation class this issue exists to remove.
  - **`:1944` (`checkTandemPlugin`'s wizard read)** — **no arm**, deliberately. It reads the same
    `~/.claude.json` that `:1110` just reported on, and the code's own comment at `:1969`
    ("Anything but `ok` is already reported by `checkUserMcpConfig`") is that contract; it falls
    through to `wizardTandemEntry = false` and there is no typecheck problem, because the site tests
    `=== "ok"` rather than exhausting kinds.
  - **`:1939` (`checkTandemPlugin`'s `~/.claude/settings.json`)** — **one warn, not a fall-through**,
    for the reason that function's own docblock gives at `:1925-1930`: `enabledPlugins === null`
    means "absent or unreadable — NOT evidence", so "folding a refusal into it would make the
    refusal silent: the one case where 'absence is not evidence' is actively wrong, because we know
    why we did not look." Nothing else reports this file. Mirror the shape of the `unsafe-path` arm
    just above (`:1952-1958`): `if (settingsRead.kind === "oversize") { r.warn(…); return; }`, four
    lines, same path-free text.

  This is the two-person "fix it rather than file it" rule applied to a small gap in a file this
  branch already edits (`F-config-1802.md` rewrites two other sites in it) — but it is **not the
  "~6 lines" round 2 called it**: the honest count is the union member, the import, the guarded stat,
  and three warn arms.
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
  these wire codes verbatim, so the route arm maps one to the other with no table. **`MAX_CONFIG_BYTES`
  lands in this same file** (see the cap bullet above), which is why the file is edited once rather
  than twice.
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

1. `"accepts a config under the cap"` — a **fixed, modest** under-cap payload: reuse case (3)'s
   6 MiB body rather than `"x".repeat(MAX_CONFIG_BYTES - 1024)`. Read the file back and assert
   `mcpServers.tandem.url` (not-throwing alone is satisfied by a silent no-op). **The boundary stays
   pinned to the constant by case (4), not by this payload** — a `MAX_CONFIG_BYTES - 1024` string
   would materialise ~16 MiB, `JSON.parse` it and re-`JSON.stringify` it with 2-space indent on
   every run of the file, on top of case (3)'s own 6 MiB, and the old 5 MiB version of this case was
   already the heaviest thing in the suite. The payload must be real bytes (it has to parse), so the
   sparse trick is unavailable here — which is exactly why it should be small.
2. `"rejects a config above the cap"` — replaces today's `"x".repeat(5 MiB + 1)` body with the
   sparse form: `writeFileSync(p, "")` then `truncateSync(p, MAX_CONFIG_BYTES + 1)`, so no 16 MiB
   of bytes is written and the size guard throws before any read. Assert `ConfigRefusalError` with
   `reason === "CONFIG_TOO_LARGE"`, **keep today's `toThrow(/refusing to read/)` on the message**
   (the CLI half of "Done when" — `applyConfigWithToken` at `apply.ts:2327` and `writeTargets` at
   `setup.ts:208-211` both print `err.message`, and nothing else asserts that text survives the
   refactor), and prove nothing was written with
   **`statSync(p).size === MAX_CONFIG_BYTES + 1` plus an unchanged `mtimeMs`** — *not* a byte
   comparison, which would materialise and string-compare two 16 MiB buffers and print a 16 MB diff
   on failure. The guard is a `statSync` before any read (`apply.ts:1012-1022`), so a content
   assertion proves nothing extra. Kills a fix that raises the cap and leaves the refusal as a bare
   `Error` the route cannot classify.
3. New: a **6 MiB** well-formed config (one large string field) applies successfully and keeps its
   other `mcpServers` entries. This is the discriminating test — red on today's 5 MiB cap, green
   only if the cap actually moved. 6 MiB is chosen as "comfortably past the old cap", not as a
   measured figure; anything above 5 MiB + a margin serves. It does not duplicate (1): (1) proves an
   under-cap config is written rather than silently no-op'd, (3) pins that the cap went *past the
   size the issue reports*. Kills a fix that only improves the error text.
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

`tests/cli/doctor.test.ts` — **two** cases, one per non-trivial arm, both using the sparse
`truncateSync` fixture:

- `~/.claude.json` above `MAX_CONFIG_BYTES` → `checkUserMcpConfig`'s "too large" warn, and the `fix`
  string contains neither the path nor a byte count. Without it the wizard's restored
  `tandem doctor` pointer is again a promise nothing keeps.
- an oversize Claude Desktop config → `checkDesktopMcpConfig`'s own "too large" warn, with the same
  leak assertions. This is the arm that would otherwise be repaired by widening the predicate to
  `read.kind !== "ok"` and reporting "could not be read as JSON" about a valid file.

(The `:1939` `~/.claude/settings.json` arm gets no case: reaching it needs a >16 MiB fixture for a
file that is never large, and the arm exists to satisfy the `:1925-1930` docblock rule rather than
to be exercised. Say so in the PR body rather than leaving it unexplained.)

`tests/cli/doctor-path-safety.test.ts` — **no new case, but it is a touched suite and must be run.**
Two of its existing specs are what the stat's placement is judged by: `:437-440` (hostile paths
still answer `unsafe-path` with `readFileSync` never called) and `:450-464` (`absent.json` →
`absent`, a directory → `unreadable`). If either is red, the stat is in the wrong place. Note in the
PR body that the ordering itself is *not* pinned by that suite — its `statSync` stub silently
absorbs a misplaced stat (`:58-86`) — so the placement rests on review, and the specs above only
catch the totality half.

No boot-sweep test is added: that log line exists and is unchanged. Say so in the PR body with the
`:1893-1899` citation, so the issue's third bullet is closed by evidence rather than by silence.

## Done when

The cap is 16 MiB, lives in `src/shared/integrations/contract.ts`, and its docblock states the new
bound, its parse cost and that the number is an unmeasured judgment; a 6 MiB config applies; an
oversize config refuses with `CONFIG_TOO_LARGE` through the CLI message (pinned by the surviving
`/refusing to read/` assertion), the wizard result (pinned by a client test) and **both** of
`tandem doctor`'s new `oversize` arms; `readClaudeConfig` is still total, still screens the path
before any syscall, and `tests/cli/doctor-path-safety.test.ts` is green unchanged; the over-cap case
derives its boundary from the constant and case (4) pins the floor; the `docs/security.md` #1599
clause recording **both** the sweep's widened population and the scrub's widened reach lands with
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

## Review corrections (round 3)

**Adopted**

- *(blocking, three findings on one line)* The doctor bullet said to add a
  `statSync(path).size > MAX_CONFIG_BYTES` branch **"before the read"**, with no ordering relative
  to the path screen and no error handling. Followed literally that is two bugs. **(a) Security:**
  `readClaudeConfig`'s first line is `rejectUnsafeWindowsPrefix` precisely so no syscall touches a
  hostile path (#1417); a stat above it performs the SMB/NTLM handshake the check exists to prevent,
  and `tests/cli/doctor-path-safety.test.ts` cannot see it — its assertion is
  `expect(_readFileSyncSpy).not.toHaveBeenCalled()` (`:437-440`) and its own `node:fs` mock stubs
  `statSync` for hostile prefixes as containment that "asserts nothing" (`:58-86`, `:71-74`), so a
  misplaced stat is green in test and real on Windows. **(b) Totality:** `ClaudeConfigRead` has no
  error member and today ENOENT is caught *inside* the `readFileSync` try; a bare `statSync` throws
  on the commonest path of all — no `~/.claude.json`, every fresh install — and `Recorder.check`
  turns that into "check crashed … Please report this at …/issues", crashing `tandem doctor` and
  `tandem_diagnostics` where they used to warn, with `doctor-path-safety.test.ts:456` and
  `doctor.test.ts:2026-2032` red. The bullet now carries the literal placement (after the screen,
  inside the existing `try`, ENOENT → `absent`, everything else → `unreadable`) as a code block, and
  `tests/cli/doctor-path-safety.test.ts` is added to the touched-suite list with the two specs that
  judge it named.
- *(blocking, two findings)* The `oversize` member was added to `ClaudeConfigRead` with **one** warn
  arm named, and that arm was placed "beside the `malformed`/`unreadable` ternary at `:1149-1158`" —
  which sits *inside* the block already guarded by `:1130`, so it is unreachable and the type error
  survives. `readClaudeConfig` has four call sites, two of which read `read.value` after exhausting
  the known kinds (`:1163`, `:1537`), so the new member is a TS2339 at both. The bullet now
  enumerates all four with the outcome at each: `:1110` and `:1492` get dedicated arms **above** the
  `unreadable || malformed` checks; `:1944` deliberately gets none (same file, and `:1969`'s own
  comment is that contract); `:1939` gets a warn rather than falling into `enabledPlugins = null`,
  per that function's docblock at `:1925-1930` ("the one case where 'absence is not evidence' is
  actively wrong, because we know why we did not look"). Widening either predicate to
  `read.kind !== "ok"` is named and forbidden — it prints "is not valid JSON" about a valid file,
  the mistranslation this issue exists to remove. `doctor.test.ts` gains the second (desktop) case,
  and the spec now says #1801 owns the `checkDesktopMcpConfig` `oversize` arm so it does not collide
  with #1802's rewording of the same site.
- *(non-blocking, two findings)* `MAX_CONFIG_BYTES` moves to `src/shared/integrations/contract.ts`
  rather than being exported from `apply.ts`. Importing it from `apply.ts` would give `doctor.ts` —
  whose docblock (`:22-23`) constrains it to built-ins so the standalone shim can mirror it — a
  runtime edge to `node:crypto`, `acl-win`, `platform`, the `SKILL_CONTENT` payload and a
  **module-load `readFileSync`** (`const CLI_VERSION = resolveCliVersion()`, `apply.ts:214`), inside
  a suite that replaces `node:fs` wholesale. `contract.ts` has no imports at all and doctor already
  reaches it at `:44`.
- *(non-blocking)* The `docs/security.md` #1599 clause was scoped to the boot sweep only. The same
  cap gates `readConfigForMutation`'s other caller, `removeConfigEntries` — the uninstall scrub the
  entry itself calls the sharp edge for credential remanence — so raising it also makes 5–16 MiB
  configs *scrubbable*. The clause must now name both directions in one sentence.
- *(non-blocking, two findings)* Test 1 no longer allocates `MAX_CONFIG_BYTES - 1024` (~16 MiB of
  real bytes, parsed and re-serialised every run, on top of test 3's 6 MiB). It uses a fixed modest
  under-cap payload; the boundary stays pinned to the constant by test 4's floor assertion. Noted
  that test 1's payload must be real bytes — it has to parse — which is why keeping it small is the
  available lever.
- *(non-blocking)* Test 2 keeps today's `toThrow(/refusing to read/)` alongside the new
  `ConfigRefusalError` / `reason` assertions. "Done when" claimed the refusal reaches the CLI
  message and only the wizard and doctor halves had named tests; both CLI printers emit
  `err.message`, so nothing else would notice the text vanishing in the refactor.

**Not adopted**

- None.

**File-set change:** `MAX_CONFIG_BYTES` now lives in `src/shared/integrations/contract.ts` (which
this spec already edited for the error codes) rather than `src/server/integrations/apply.ts`, and
`tests/cli/doctor-path-safety.test.ts` joins the touched-suite list (run-only, no new case).
