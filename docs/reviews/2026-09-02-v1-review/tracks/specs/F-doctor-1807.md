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
     - **The port-less default comes from the protocol, not a hardcoded `"80"`.** Add a
       module-private `defaultPortForProtocol(protocol: string): number` to `src/cli/doctor.ts`
       — **it does not exist today** (`grep -rn defaultPortForProtocol src/` is empty); this spec
       introduces it. It returns 443 for `https:` and 80 otherwise; a port-less `https://…/mcp`
       entry must not be reported as "points at port 80".
  5. Otherwise `pass` — **with a per-level message, not one shared string.** "The existing text"
     differs at each level and there is no pass-message seam in `opts`, so spell both out or the
     single natural implementation (`` `${label} tandem → ${url}` ``, the project wording at
     `src/cli/doctor.ts:1045`) silently opens a *new* credential path through the pass arm:
     - **`.mcp.json` (`redactUrl: false`)**: `` `${label} tandem → ${url}` ``, unchanged.
     - **`~/.claude.json` (`redactUrl: true`)**: the byte-for-byte existing string
       `tandem registered in ~/.claude.json` (`src/cli/doctor.ts:1209`). **It never interpolates
       `url`, and it must not start.** Arms 3 and 4 do not fire on a healthy-*shaped* URL, so
       `http://tok:s3cret@127.0.0.1:3479/mcp?key=abc` reaches the pass arm — same
       `type`/`/mcp`/port as a clean install, and the credential is in the parts nothing looks
       at. A pass arm that echoed `url` would put it on the wire for every such user, with
       nothing warning them.

- **The message is redacted at the user level and verbatim at the project level, and the two
  deliberately differ.** `opts.redactUrl` is what splits them:
  - **`.mcp.json` (`redactUrl: false`)** keeps today's wording byte-for-byte **for arm 3 only**:
    `` `${label} tandem: unexpected config — type=${type}, url=${url}` ``.
  - **Arm 4's message never interpolates `url`, at EITHER level.** The two port numbers are the
    whole finding, and arm 4 fires only on urls that already passed the shape checks — a
    `type: "http"`, `/mcp`-terminated url naming a non-default port is exactly the hosted or remote
    endpoint most likely to carry a credential, so widening today's verbatim project-level echo
    onto that population is a new exposure rather than preserved wording. The exposure would be
    bounded (`mcp-json` is in `CWD_DEPENDENT_CHECKS`, `src/cli/doctor.ts:455-461`, and
    `filterDevRepoChecks` strips it from `/api/diagnostics` and `tandem_diagnostics`,
    `src/server/mcp/routes/diagnostics.ts:39,57`), which is why it is a message rule rather than a
    second `redactUrl` level — but "bounded to the CLI terminal" is not a reason to print it.
  - **`~/.claude.json` (`redactUrl: true`)** never interpolates the raw `url`, **and never
    interpolates the pathname either**:
    - Arm 3 prints `type=<observed>` plus `pathHasMcp=<computed boolean>` (or, for a URL
      `new URL()` rejects, the literal `url=(unparsable)`). **The boolean is computed, not the
      constant `false`**: arm 3 also fires on `type !== "http"` with a perfectly good `/mcp`
      pathname (test 1 is exactly that entry), where a hardcoded `pathHasMcp=false` would be a
      false statement in doctor output. **Not `path=<value>`.** A path segment is a standard
      credential carrier for exactly this population — hosted MCP endpoints commonly embed the
      key as `https://host/v1/<token>/mcp` — and `pathHasMcp=false` names the finding, which the
      value does not add to. The `fix` string is what tells the user what to do.
    - Arm 4 prints `type=` and the two port numbers only. **No path at all**: arm 4 fires only
      when the pathname already contains `/mcp`, so the path is not the finding there — while
      `/mcp/<secret>` satisfies that condition and would be printed verbatim.
  - **Redaction covers the whole outcome, not just `message`.** At `redactUrl: true` the
    outcome's `data` bag carries no `url` and no copy of the raw entry either.
    `recordEvaluation` forwards `result.data` straight into `r.warn`
    (`src/cli/doctor.ts:411-422`), and `redactUserPaths` "walks the WHOLE report" precisely
    because "the per-check `data` bag is free-form and several checks put the raw directory in
    it" (`diagnostics.ts:100-107`) — it collapses paths, and knows nothing about URL userinfo or
    a query token. So `r.warn(msg, fix, { url })` would satisfy every message-only assertion and
    still ship the credential.

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

- **Arm 4 carries its own remedy and must never emit `setupApplyRemedy` — at EITHER level.**
  `MCP_URL` is hardcoded to `DEFAULT_MCP_PORT` (`apply.ts:186`, `:511`), so on a
  `TANDEM_MCP_PORT=4918` install `tandem setup --apply` **re-writes 3479** and the warn re-fires
  unchanged, forever. That is the dead-end-remedy defect this file has already been corrected for
  twice — `src/cli/doctor.ts:1163-1190` (the #1802 malformed arm, which "carries NO
  `setupApplyRemedy`… prescribing either is a dead-end fix line") and `:1345-1360` (the doctrine
  by name, #1404: *a remedy that cannot work is worse than no remedy*).

  **So `portFix` is supplied at BOTH call sites, and is never `brokenFileFix()`.**
  `brokenFileFix` ends in `setupApplyRemedy(cliAvailable())` (`src/cli/doctor.ts:986-988`, already
  asserted to match `/tandem setup --apply|AI Assistant/` at `tests/cli/doctor.test.ts:2168-2170`),
  and its other half — "delete it and rely on Tandem's global registration" — falls back to
  `~/.claude.json`, which names 3479 too. Both branches re-fire the same warn forever. Doctor
  already says in-product that a project-local `.mcp.json` is "not managed by … `tandem setup
  --apply`" (`:1077-1081`), so the remedy is doubly dead there.

  - **`~/.claude.json`** (`portFix`):

    > Edit the `url` in ~/.claude.json to port `<mcpPort>`, or unset `TANDEM_MCP_PORT` and restart
    > Tandem. `tandem setup --apply` writes the default port and will not fix this. (#<MCP_URL issue>)

  - **`.mcp.json`** (`portFix`): names the file the user must edit, since it is theirs:

    > Edit the `url` in .mcp.json to port `<mcpPort>`, or unset `TANDEM_MCP_PORT` and restart
    > Tandem — this project-local file is not managed by `tandem setup --apply`.
    > (#<MCP_URL issue>)

  `brokenFix` (arm 3) is the one that keeps a rewrite remedy: `setupApplyRemedy(cliAvailable())` at
  the user level, `brokenFileFix()` at the project level. For a wrong `type` or a `/mcp`-less URL,
  rewriting the entry genuinely resolves it.

- **The arm-4 warn is unclearable for a deliberately moved install, and that is a chosen cost.**
  Because `MCP_URL` is hardcoded, no Tandem-written config can satisfy arm 4 on a
  `TANDEM_MCP_PORT` install — the only ways out are hand-editing the file or abandoning the port
  move, and the warn persists until the tracked `MCP_URL` issue lands. That is the same
  unclearable-warning shape `src/cli/doctor.ts:1938` warns against, so it is stated here as a
  trade rather than left to be discovered: a *correct* warning naming a real misconfiguration
  beats a green check on a config Claude Code cannot use. Arm 4's `fix` cites the issue number, so
  the user sees the same reasoning.

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
describe. Its `beforeEach` stubs `HOME` only today (`tests/cli/doctor.test.ts:2026-2031`); **it
gains `vi.stubEnv("USERPROFILE", home)` in the same commit**, so specs 1–9 are machine-independent
on Windows too and spec 10 — which runs the whole doctor through `runDoctorCli` and so reaches
`checkTandemPlugin`'s `homedir()`-adjacent reads — does not need a describe of its own. Scratch
HOME via `mkdtempSync`, `vi.unstubAllEnvs()` in `afterEach` — **never the real HOME**:

1. `{ tandem: { type: "stdio", url: "http://127.0.0.1:3479/mcp" } }` → `user-mcp-config` warn whose
   message contains `type=stdio` **and `pathHasMcp=true`**. Kills "validate url only", and pins
   `pathHasMcp` as computed rather than a constant — this entry's pathname does contain `/mcp`.
2. `{ tandem: { type: "http", url: "http://127.0.0.1:3479/" } }` → warn naming `pathHasMcp=false`,
   and the message must **not** contain the raw `http://127.0.0.1:3479/` (nor a `path=` value).
   Kills "validate type only", and pins the redaction's shape-not-value rule for arm 3.
3. `{ tandem: { type: "http", url: "http://127.0.0.1:9999/mcp" } }` → warn naming **9999 and
   3479**. Kills a validator that accepts any `/mcp` URL — the issue's headline case. Plus
   `expect(warn?.fix).not.toMatch(/setup --apply/)`, mirroring `tests/cli/doctor.test.ts:2057`:
   the dead-end remedy is the half that ships silently. **And
   `expect(warn?.fix).toMatch(/#\d{3,}/)`** — `portFix`'s wording ends in the `MCP_URL` issue
   number, which is filed during this PR (see Not in scope). Nothing else would catch a literal
   `(#<MCP_URL issue>)` placeholder shipping in a user-facing remedy.
4. **Redaction, discriminating cases — asserted over EVERY `user-mcp-config` outcome, not one
   found result and not `message`.** Two entries, each `→` a warn that names 9999, with the
   absence asserted over
   `JSON.stringify(report.results.filter((x) => x.check === "user-mcp-config"))`.
   `JSON.stringify`, not `warn?.message`: it covers `message`, `fix` and the `data` bag in one
   non-sniffable check, and `data` is the channel a message-only assertion misses entirely (see the
   redaction bullet). **The filter, not a single `find`:** `checkUserMcpConfig` emits several
   results under that check name (`src/cli/doctor.ts:1206-1230` — the tandem outcome, then
   `reportEntryCommand`, then the two channel outcomes), so a leak in a sibling outcome is
   invisible to a one-result assertion.
   - `{ type: "http", url: "http://tok:s3cret@example.invalid:9999/mcp?key=abc" }` → contains
     neither `s3cret` nor `key=abc` nor the raw url. Kills a copy of the twin's verbatim `url=`
     interpolation at the level that reaches a prefilled public issue body.
   - `{ type: "http", url: "http://example.invalid:9999/mcp/s3cret" }` → contains neither
     `s3cret` nor the raw url. Kills arm 4 printing `path=`, which is a live token carrier
     precisely because arm 4 requires `/mcp` in the pathname.
5. `{ tandem: { command: "/abs/node", args: [...] } }` → **assert the POSITIVE, wording-independent
   outcome**: the `user-mcp-config` results **contain a pass whose message is
   `tandem registered in ~/.claude.json`** (`src/cli/doctor.ts:1209`), and `reportEntryCommand`'s
   own outcome for the stdio entry still appears. That pass is reachable only when the evaluator
   returns `null` for a `command` entry, so it reds if arm 2 is made unconditional — and it also
   reds on an implementation that returns `null` **and emits nothing at all**, which today's
   `recordEvaluation` (`src/cli/doctor.ts:411-413`, silent on `null`) makes easy to ship. A bare
   "no `unexpected config` warn" assertion catches neither: the Fix pins that substring only for
   the **project**-level message (`redactUrl: false`), so the user-level warn is free to be worded
   differently and pass vacuously with arm 2 dropped. Keep
   `expect(JSON.stringify(userResults)).not.toContain("unexpected config")` as a secondary
   assertion only.
6. **The healthy entry passes AND says nothing about the url.** Use a healthy-*shaped* entry that
   carries a credential payload: `{ type: "http", url: "http://tok:s3cret@127.0.0.1:3479/mcp?key=abc" }`
   → a `user-mcp-config` **pass** whose message is the existing `tandem registered in
   ~/.claude.json`, with the absence asserted over
   `JSON.stringify(report.results.filter((x) => x.check === "user-mcp-config"))` — neither
   `s3cret` nor `key=abc` nor the raw url, in **any** outcome under that check name (same
   sibling-outcome reason as spec 4). Asserting only `status === "pass"` is non-discriminating on
   exactly the property this arm exists to establish. Keep a plain `…:3479/mcp` pass assertion too,
   so a future over-eager arm reds every working install.
7. Port-less `https`: `{ tandem: { type: "http", url: "https://example.invalid/mcp" } }` warns
   naming **443**, not 80. Kills the hardcoded `|| "80"` default.
8. Project-level twin, in the `checkMcpJson` describe. Two entries, and which one gets which
   remedy is the point — the project arm carries no `fix` at all today
   (`src/cli/doctor.ts:1042-1043` passes one argument), so both pin new behaviour:
   - **Arm 3** (wrong `type`, or a `/mcp`-less URL) in a temp cwd's `.mcp.json` → warn whose `fix`
     **gains `brokenFileFix()`**. Rewriting the entry genuinely fixes this one.
   - **Arm 4** (the same wrong-port entry) → warn whose `fix` is the project-level `portFix`,
     naming editing `.mcp.json`'s `url`, plus
     `expect(warn?.fix).not.toMatch(/setup --apply/)` and `expect(warn?.fix).toMatch(/#\d{3,}/)` —
     both assertions spec 3 already carries at the user level. `brokenFileFix()` ends in
     `setupApplyRemedy(cliAvailable())` (`src/cli/doctor.ts:986-988`), so pinning it here would
     ship and lock in the dead-end remedy the Fix section forbids. **And
     `expect(warn?.message).not.toContain(url)`** — arm 4's message names the two ports and never
     the url, at this level too (see the redaction bullet).
9. **Project-level `command` entry** — the arm-2 regression guard. A `.mcp.json` whose `tandem`
   entry is `{ command: "/abs/node", args: [] }` still produces an `mcp-json` **warn** and must
   NOT produce a `pass` containing `undefined`. Without `commandArmOwnedByCaller` this spec is
   the one that reds.
10. Port mismatch under `TANDEM_MCP_PORT`: with #1806 wired, `vi.stubEnv("TANDEM_MCP_PORT", "4918")`
    + a `…:3479/mcp` entry + `runDoctorCli({ json: true })` → the warn names 4918. This is the only
    spec that proves the threading reaches the CLI rather than only `runDoctor(opts)`. It relies
    on the `USERPROFILE` stub added to this describe's `beforeEach` above — the same both-variables
    rule as #1806's wiring describe, for the same reason (this spec runs the whole doctor).

## Done when

A wrong `type`, a URL without `/mcp`, and a port that disagrees with the probed MCP port each warn
with the observed value at **both** levels; **no `user-mcp-config` outcome — warn or pass, in
`message`, `fix` or `data` — echoes the raw `url` or any part of its path**, while the
project-level one still does; the port warn's `fix` does not name `setup --apply` at **either**
level; a stdio entry warns at the project level and is left to `reportEntryCommand` at the user
level; a healthy HTTP entry passes; typecheck + the CLI suite green.

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
names. Arm 4's remedy — and its `fix` string — cite that number, which is what keeps the user
unblocked in the meantime.

**Naming the rule this departs from**, so a reviewer does not read the new issue as an untracked
deferral: CLAUDE.md's Development Workflow says "if you find something broken while working, fix
it rather than filing it", and this sweep's own Decision B for #1827 chose "**No new issue** —
#1754 stays open with a comment" (`docs/plans/2026-09-06-open-issues-sweep.md:24`). The departure
is deliberate and narrow: choosing *which* environment `MCP_URL` should read — the setup shell's
or the server's — is a design call with three consumers (the MCP entry, the desktop stdio entry's
`TANDEM_URL` at `apply.ts:502`, and the shim's at `:518`), not a mechanical fix, and no existing
issue covers it. File one rather than commenting on an unrelated one.

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

## Review corrections (round 2)

**Adopted**

- **BLOCKING** *The shared evaluator leaks the raw `~/.claude.json` `url` through its PASS arm.*
  "Otherwise `pass` with the existing text" had no per-level seam, so the natural implementation
  is the project wording `` `${label} tandem → ${url}` `` (`src/cli/doctor.ts:1045`) — and arms 3
  and 4 do not fire on a healthy-shaped URL, so `http://tok:s3cret@127.0.0.1:3479/mcp?key=abc`
  reaches it. Arm 5 now spells both messages out: the user level stays the byte-for-byte existing
  `tandem registered in ~/.claude.json` (`:1209`) and never interpolates `url`. Spec 6 is
  repointed onto a healthy-shaped entry carrying a credential payload and asserts the absence,
  not just the status.
- **BLOCKING** *Redaction was asserted only against `message`, while the per-check `data` bag
  reaches `/api/diagnostics` and the prefilled issue body unscrubbed for credentials.*
  `recordEvaluation` forwards `result.data` into `r.warn` (`src/cli/doctor.ts:411-422`) and
  `redactUserPaths` collapses paths only (`diagnostics.ts:83-115`, and `:100-107` says it walks
  the whole report *because* `data` is free-form). The redaction bullet now covers the whole
  outcome — no `url` and no raw entry in `data` — and specs 4 and 6 assert over
  `JSON.stringify(warn)` / `JSON.stringify(pass)` rather than `?.message`.
- **BLOCKING** *Arm 4's `path=` prints a credential-carrying path component: `/mcp/<secret>`
  satisfies the "pathname contains `/mcp`" condition the arm fires under.* The user-level message
  now prints **no path value at all**: arm 4 is `type=` plus the two port numbers, and arm 3 is
  `type=` plus `pathHasMcp=false`. Spec 2 is repointed onto `pathHasMcp=false`; spec 4 gains a
  `http://example.invalid:9999/mcp/s3cret` case.
- **BLOCKING** *The spec contradicted itself on the port-mismatch remedy — spec 8 pinned
  `brokenFileFix()`, which ends in `setupApplyRemedy(cliAvailable())`
  (`src/cli/doctor.ts:986-988`), for the one arm the Fix forbids it in* (raised twice). The Fix
  now states `portFix` is supplied at **both** call sites and is never `brokenFileFix()`, gives
  the project-level wording (edit `.mcp.json`'s `url`, which doctor already says at `:1077-1081`
  that `setup --apply` does not manage), and spec 8 is split: arm 3 gains `brokenFileFix()`, arm 4
  gets `portFix` plus `expect(warn?.fix).not.toMatch(/setup --apply/)`.
- *`defaultPortForProtocol` was described as though it exists.* `grep -rn defaultPortForProtocol
  src/` is empty; the Fix now marks it as a new module-private helper in `src/cli/doctor.ts`.
- *The arm-4 warn is unclearable for a deliberately moved install — the same shape the spec cites
  doctrine against.* Added as an explicit stated trade in the Fix, with the reason it is still the
  right call, and arm 4's `fix` now cites the `MCP_URL` issue number so the user sees it too.
- *Requiring a new issue for `MCP_URL` departs from the two-person fix-rather-than-file rule and
  from this sweep's own Decision-B precedent, without saying so.* Not-in-scope now names both
  rules and why this one is a design call with three consumers rather than a mechanical fix.
- *Specs 1–9 extend a `HOME`-only describe while spec 10 needs both variables.* The Tests preamble
  now requires `vi.stubEnv("USERPROFILE", home)` in that describe's `beforeEach` in the same
  commit (`tests/cli/doctor.test.ts:2026-2031` stubs `HOME` alone today), and spec 10 refers to it
  rather than restating a separate rule.

**Not adopted**

- None.

## Review corrections (round 3)

**Adopted**

- **BLOCKING** *Spec 5 — the only guard on `commandArmOwnedByCaller` at the user level — asserted
  the absence of a substring the Fix pins only for the PROJECT-level message, so it passes
  vacuously with arm 2 dropped.* It now asserts the positive, wording-independent outcome: the
  `user-mcp-config` results contain the pass whose message is `tandem registered in
  ~/.claude.json` (`src/cli/doctor.ts:1209`), reachable only when the evaluator returns `null` for
  a `command` entry, plus `reportEntryCommand`'s outcome. The `unexpected config` negative is
  demoted to a secondary assertion.
- *Spec 5 also did not pin that today's `pass` survives, so an implementation returning `null` and
  emitting nothing passed every spec while deleting the outcome* (`recordEvaluation` is silent on
  `null`, `src/cli/doctor.ts:411-413`). Covered by the same rewrite — the pass and
  `reportEntryCommand`'s outcome are both required.
- *Arm 4's project-level message was free to interpolate the raw `url`, widening the verbatim echo
  onto exactly the population whose url is most likely to carry a credential.* The redaction bullet
  now scopes the byte-for-byte project wording to **arm 3** and states that arm 4 never
  interpolates `url` at either level, with the bounded-exposure note (`CWD_DEPENDENT_CHECKS` /
  `filterDevRepoChecks`) as context rather than justification. Spec 8's arm-4 case gains
  `expect(warn?.message).not.toContain(url)`.
- *Arm 3's user-level message was specified as a fixed `pathHasMcp=false`, but arm 3 also fires on
  `type !== "http"` with a good `/mcp` pathname — test 1 is exactly that entry, so the literal
  would be a false statement in doctor output.* The field is now `pathHasMcp=<computed boolean>`,
  and spec 1 asserts `pathHasMcp=true` alongside `type=stdio`.
- *The `(#<MCP_URL issue>)` placeholder can ship in a user-facing remedy with nothing asserting the
  substitution happened* (raised twice). Specs 3 and 8's arm-4 case gain
  `expect(warn?.fix).toMatch(/#\d{3,}/)`, which reds while the placeholder is unresolved.
- *The redaction Done-when covers every `user-mcp-config` outcome while specs 4 and 6 stringified a
  single found result — `checkUserMcpConfig` emits several under that name
  (`src/cli/doctor.ts:1206-1230`), so a sibling leak is invisible.* Both specs now assert over
  `JSON.stringify(report.results.filter((x) => x.check === "user-mcp-config"))`.

**Not adopted**

- None.
