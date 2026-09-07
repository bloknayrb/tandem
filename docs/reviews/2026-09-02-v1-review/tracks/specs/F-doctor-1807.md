# F-doctor — #1807 doctor passes a user-level `~/.claude.json` entry on key presence alone

Branch `fix/doctor-and-skill-version-skew-1806`. Closes #1807. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:19`. No experiment (`[read]` row).
**Depends on #1806** — the port comparison below probes the port doctor actually resolved.

## Problem

`checkUserMcpConfig` (`src/cli/doctor.ts:1213`) does `if (!servers.tandem) warn else r.pass("tandem
registered in ~/.claude.json")` — key presence, nothing else. Its project-level twin in
`checkMcpJson` validates the same entry (`src/cli/doctor.ts:1041-1043`):
`tandem.type !== "http" || !tandem.url?.includes("/mcp")` →
`warn(".mcp.json tandem: unexpected config — type=…, url=…")`. So a leftover entry from an older
install (`type: "stdio"`, a URL with no `/mcp`, or 3479 after the user moved the server) reads
green in the file Claude Code actually consults, while Claude Code cannot connect.

The port half is real and not hypothetical: `buildMcpEntries` (`apply.ts:511`) writes
`` `${MCP_URL}/mcp` `` with `MCP_URL` hardcoded to `DEFAULT_MCP_PORT` (`apply.ts:186`), so an
install moved with `TANDEM_MCP_PORT` gets a config pointing at 3479 no matter what — and today
nothing says so. **That also settles what arm 4's remedy may say; see below.**

## Fix

`src/cli/doctor.ts` only.

- Extract the inline `.mcp.json` branch into an exported pure
  `evaluateTandemHttpEntry(entry, opts): EvalOutcome | null`, in the file's established
  `evaluateX` + `recordEvaluation` shape (model: `evaluateOrphanedVite`, `evaluateTandemPlugin`).
  `opts` carries `label`, `mcpPort`, `redactUrl: boolean`, `commandArmOwnedByCaller: boolean`,
  `brokenFix: string` and `portFix: string`. Order matters:

  1. `entry` not an object → `null` (caller keeps its own missing/absent handling).
  2. **A non-empty string `command` → `null`, but ONLY when `commandArmOwnedByCaller` is true.**
     This arm is a **user-level** fact, not a property of the entry shape. At `~/.claude.json`
     a stdio entry is a hand-edit or a plugin-managed shape and `reportEntryCommand` already owns
     it (`src/cli/doctor.ts:1213`), so warning "unexpected config" there would be a regression
     dressed as a fix. `checkMcpJson` calls `reportEntryCommand` for the **channel** entry only
     (`:1074`) and never for `tandem`, so making arm 2 unconditional would delete the project
     level's only diagnostic for a stdio `tandem` entry and hand it to the `else` arm, which
     emits `r.pass('.mcp.json tandem → undefined')` — a warn silently replaced by a false pass.
     So: `commandArmOwnedByCaller: true` at the `~/.claude.json` call site, `false` at
     `.mcp.json`.
  3. `type !== "http"`, or `url` missing / not parseable by `new URL()`, or the parsed pathname not
     containing `/mcp` → `warn`, `fix` = `opts.brokenFix` (`setupApplyRemedy(cliAvailable())` at the
     user level, the existing `brokenFileFix()` at the project level — passed in by the caller, not
     chosen inside, because a project-local `.mcp.json` is not Tandem's to rewrite).
  4. `Number(parsedUrl.port || defaultPortForProtocol(parsedUrl.protocol)) !== mcpPort` → `warn`
     naming **both** numbers and the env var, `fix` = `opts.portFix`.
     - **`Number(...)`, not a bare `.port`.** `URL.port` is a *string*; `"3479" !== 3479` is
       always true, so a literal comparison would warn on every healthy install (TS2367 catches
       it, but spell it correctly in the spec so it is not rediscovered).
     - **The port-less default comes from the protocol, not a hardcoded `"80"`.**
       `defaultPortForProtocol` returns 443 for `https:` and 80 otherwise; a port-less
       `https://…/mcp` entry must not be reported as "points at port 80".
  5. Otherwise `pass` with the existing text.

- **The message is redacted at the user level and verbatim at the project level, and the two
  deliberately differ.** `opts.redactUrl` is what splits them:
  - **`.mcp.json` (`redactUrl: false`)** keeps today's wording byte-for-byte:
    `` `${label} tandem: unexpected config — type=${type}, url=${url}` ``.
  - **`~/.claude.json` (`redactUrl: true`)** never interpolates the raw `url`. It prints
    `type=<observed>` plus the parsed `port=` and `path=` (and, for a URL `new URL()` rejects,
    the literal `url=(unparsable)` — the value itself is not echoed).

  This is not symmetry for its own sake. The `.mcp.json` twin can echo safely only because
  `mcp-json` **is stripped from field reports**: it is in `CWD_DEPENDENT_CHECKS`
  (`src/cli/doctor.ts:455-461`), which `filterDevRepoChecks`
  (`src/server/mcp/routes/diagnostics.ts:56-69`) drops from `/api/diagnostics`.
  `user-mcp-config` is **not** in that list, and `checkUserMcpConfig`'s own docblock
  (`src/cli/doctor.ts:1173-1180`) says why that matters: *"~/.claude.json carries bearer tokens /
  API keys. This check survives the /api/diagnostics filter, so its message reaches the Copy
  Diagnostics clipboard — destined for public issues."* The only scrubber left downstream is
  `redactUserPaths` (`diagnostics.ts:83-115`), which collapses home and app-data **paths** and
  knows nothing about a credential in a URL — and the Report-a-bug link prefills a public issue
  body, which makes the human review step an opt-out. Arms 3 and 4 fire precisely on entries
  Tandem did not write (hand-edited, another install, a remote host), which is the population
  whose `tandem` URL can carry userinfo or a query token. `type` stays verbatim in both: it is a
  short enum-shaped field, not a credential carrier.

- **Arm 4 carries its own remedy and must never emit `setupApplyRemedy`.** `MCP_URL` is hardcoded
  to `DEFAULT_MCP_PORT` (`apply.ts:186`, `:511`), so on a `TANDEM_MCP_PORT=4918` install
  `tandem setup --apply` **re-writes 3479** and the warn re-fires unchanged, forever. That is the
  dead-end-remedy defect this file has already been corrected for twice — `src/cli/doctor.ts:1163-1190`
  (the #1802 malformed arm, which "carries NO `setupApplyRemedy`… prescribing either is a dead-end
  fix line") and `:1345-1360` (the doctrine by name, #1404: *a remedy that cannot work is worse
  than no remedy*). So `portFix` names the two things that actually work, and says what
  `setup --apply` would do:

  > Edit the `url` in ~/.claude.json to port `<mcpPort>`, or unset `TANDEM_MCP_PORT` and restart
  > Tandem. `tandem setup --apply` writes the default port and will not fix this.

  `brokenFix` (arm 3) keeps `setupApplyRemedy(cliAvailable())` at the user level — for a wrong
  `type` or a `/mcp`-less URL, rewriting the entry genuinely resolves it.

- `warn`, never `fail`, in every arm — parity with the twin, and `tandem doctor` must not start
  exiting 1 on a machine whose tools arrive via the plugin. (Assumption; see `assumptions`.)
- Thread `mcpPort` from `runDoctor` into `checkMcpJson` and `checkUserMcpConfig` (both already
  receive `r` and `cliAvailable`; add the parameter, no new option). `runDoctor` already has
  `mcpPort` in scope — do **not** re-read the environment there (#1806 keeps one resolution site).
- `checkUserMcpConfig` keeps reading `HOME`/`USERPROFILE` itself and keeps its `homeIsUnsafe`
  screen (#1417) — the new code runs strictly after the read that already happened.
- **`MAX_CONFIG_BYTES` is not added to doctor.** It does not fall out of this validation for free
  (doctor reads through `readClaudeConfig`, a different reader from `readConfigForMutation`), and
  the wave note says take it only if it does. Listed under `bryan`.

Rules that bite: none of Critical Rules 1–9 touch this path; no route, no tool, no testid, no
skill edit.

## Tests

`tests/cli/doctor.test.ts`, extending the existing `checkUserMcpConfig wiring (~/.claude.json)`
describe (scratch HOME via `mkdtempSync` + `vi.stubEnv("HOME", …)` — **never the real HOME**):

1. `{ tandem: { type: "stdio", url: "http://127.0.0.1:3479/mcp" } }` → `user-mcp-config` warn whose
   message contains `type=stdio`. Kills "validate url only".
2. `{ tandem: { type: "http", url: "http://127.0.0.1:3479/" } }` → warn naming `path=/`, and the
   message must **not** contain the raw `http://127.0.0.1:3479/`. Kills "validate type only", and
   pins the redaction.
3. `{ tandem: { type: "http", url: "http://127.0.0.1:9999/mcp" } }` → warn naming **9999 and
   3479**. Kills a validator that accepts any `/mcp` URL — the issue's headline case. Plus
   `expect(warn?.fix).not.toMatch(/setup --apply/)`, mirroring `tests/cli/doctor.test.ts:2057`:
   the dead-end remedy is the half that ships silently.
4. **Redaction, discriminating case.** `{ tandem: { type: "http", url:
   "http://tok:s3cret@example.invalid:9999/mcp?key=abc" } }` → warn that names 9999, and whose
   `message` contains **neither** `s3cret` **nor** `key=abc`. Kills a copy of the twin's verbatim
   `url=` interpolation at the level that reaches a prefilled public issue body.
5. `{ tandem: { command: "/abs/node", args: [...] } }` → **no** `unexpected config` warn from the
   new validator. Kills arm 2 being dropped at the user level.
6. The healthy entry (`type: "http"`, `…:3479/mcp`) still `pass`es — the existing BOM spec already
   asserts this; add an explicit one so a future over-eager arm reds every working install.
7. Port-less `https`: `{ tandem: { type: "http", url: "https://example.invalid/mcp" } }` warns
   naming **443**, not 80. Kills the hardcoded `|| "80"` default.
8. Project-level twin, in the `checkMcpJson` describe: the same wrong-port entry in a temp cwd's
   `.mcp.json` warns too, and its `fix` **gains** `brokenFileFix()` — the project arm carries no
   `fix` at all today (`src/cli/doctor.ts:1042-1043` passes one argument), so this pins new
   behaviour rather than preserving old.
9. **Project-level `command` entry** — the arm-2 regression guard. A `.mcp.json` whose `tandem`
   entry is `{ command: "/abs/node", args: [] }` still produces an `mcp-json` **warn** and must
   NOT produce a `pass` containing `undefined`. Without `commandArmOwnedByCaller` this spec is
   the one that reds.
10. Port mismatch under `TANDEM_MCP_PORT`: with #1806 wired, `vi.stubEnv("TANDEM_MCP_PORT", "4918")`
    + a `…:3479/mcp` entry + `runDoctorCli({ json: true })` → the warn names 4918. This is the only
    spec that proves the threading reaches the CLI rather than only `runDoctor(opts)`. Same
    scratch-home rule as #1806's wiring describe: stub **both** `HOME` and `USERPROFILE`.

## Done when

A wrong `type`, a URL without `/mcp`, and a port that disagrees with the probed MCP port each warn
with the observed value at **both** levels; the user-level message never echoes the raw `url`
while the project-level one still does; the port warn's `fix` does not name `setup --apply`; a
stdio entry warns at the project level and is left to `reportEntryCommand` at the user level; a
healthy HTTP entry passes; typecheck + the CLI suite green.

## Not in scope

A reachability comparison against a live server's advertised port (the probed port is the same
answer with no ordering change — `user-mcp-config` runs before `ports`); `MAX_CONFIG_BYTES` in
doctor; the `tandem-channel` entry's own validation.

**`apply.ts`'s hardcoded `MCP_URL` is a real defect and needs a tracked home, not a PR-body
mention.** It is deliberately not bundled: `MCP_URL` also feeds the desktop stdio entry's
`TANDEM_URL` and the channel shim's, and deriving it from the *setup shell's*
`TANDEM_MCP_PORT` — which need not be the environment the server is launched in — is a design
decision, not a mechanical two-line fix. So it exceeds "bundle small tangential fixes in". **The
PR must file an issue for it and cite that number here before merging**; a note living only in a
PR body surfaces in no `gh issue list`, which is the failure mode CLAUDE.md's dated-gates rule
names. Arm 4's remedy is what keeps the user unblocked in the meantime.

## Files touched

`src/cli/doctor.ts`, `tests/cli/doctor.test.ts`.

## Review corrections (round 1)

**Adopted**

- *The user-level message would echo the raw `url` of `~/.claude.json` into a check that survives
  the `/api/diagnostics` filter and reaches a prefilled public issue body.* Added `redactUrl` to
  the evaluator's options and a dedicated paragraph in Fix: the user level prints `type=`, `port=`
  and `path=` (or `url=(unparsable)`), the project level keeps the verbatim wording, and the spec
  now states why the two differ, with the `CWD_DEPENDENT_CHECKS` / `filterDevRepoChecks` /
  `redactUserPaths` chain cited. New discriminating spec 4 (userinfo + query token).
- *Arm 4 inherited `setupApplyRemedy`, which provably re-writes the same wrong port* (raised
  three times). Arm 4 now takes its own `portFix`, the spec states it must never emit
  `setupApplyRemedy` while `MCP_URL` is hardcoded, and spec 3 asserts
  `fix).not.toMatch(/setup --apply/)` against the existing precedent at `doctor.test.ts:2057`.
- *Arm 2 applied to the shared validator deletes the project level's only stdio diagnostic and
  replaces it with `pass('… → undefined')`.* Arm 2 is now gated on `commandArmOwnedByCaller`,
  true only at `~/.claude.json`, with the two `reportEntryCommand` call sites cited. New spec 9
  pins the project-level `command` entry.
- *`new URL(url).port || "80"` mis-reads a port-less `https` entry.* The default now comes from
  the parsed protocol (443 / 80), with new spec 7.
- *The port comparison mixes a string and a number.* Spelled `Number(...) !== mcpPort` in the Fix,
  with the TS2367 note.
- *Test 6 described a preserved `fix` the project arm does not have.* Reworded (now spec 8): the
  project arm **gains** `brokenFileFix()`; `doctor.ts:1042-1043` passes one argument today.
- *Done-when's "Both levels run one validator" is enforced by no test.* Softened to the
  observable properties the specs actually assert (each condition warns at both levels, plus the
  redaction and remedy splits), rather than a structural claim nothing checks.
- *`apply.ts`'s `MCP_URL` was parked with "named in the PR body", against the two-person
  fix-rather-than-file rule.* Not-in-scope now explains why bundling it is a design decision
  rather than a small fix, and **requires the PR to file a tracked issue and cite the number
  here**.

**Not adopted**

- *Bundle the `MCP_URL` fix into this PR* (the alternative offered by the same finding). `MCP_URL`
  also feeds the desktop stdio entry's `TANDEM_URL` and the channel shim's, and the setup shell's
  environment is not necessarily the server's — so choosing what it should read is a design call
  that would land untested inside a doctor-only PR, against this wave's minimal-fix lesson. The
  tracked-issue requirement above is taken instead.
