# F-doctor — #1807 doctor passes a user-level `~/.claude.json` entry on key presence alone

Branch `fix/doctor-and-skill-version-skew-1806`. Closes #1807. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:19`. No experiment (`[read]` row).
**Depends on #1806** — the port comparison below probes the port doctor actually resolved.

## Problem

`checkUserMcpConfig` (`src/cli/doctor.ts`) does `if (!servers.tandem) warn else r.pass("tandem
registered in ~/.claude.json")` — key presence, nothing else. Its project-level twin in
`checkMcpJson` validates the same entry: `tandem.type !== "http" || !tandem.url?.includes("/mcp")`
→ `warn(".mcp.json tandem: unexpected config — type=…, url=…")`. So a leftover entry from an older
install (`type: "stdio"`, a URL with no `/mcp`, or 3479 after the user moved the server) reads
green in the file Claude Code actually consults, while Claude Code cannot connect.

The port half is real and not hypothetical: `buildMcpEntries` (`apply.ts:511`) writes
`` `${MCP_URL}/mcp` `` with `MCP_URL` hardcoded to `DEFAULT_MCP_PORT` (`apply.ts:186`), so an
install moved with `TANDEM_MCP_PORT` gets a config pointing at 3479 no matter what — and today
nothing says so.

## Fix

`src/cli/doctor.ts` only.

- Extract the inline `.mcp.json` branch into an exported pure
  `evaluateTandemHttpEntry(entry: unknown, label: string, mcpPort: number): EvalOutcome | null`,
  in the file's established `evaluateX` + `recordEvaluation` shape (model:
  `evaluateOrphanedVite`, `evaluateTandemPlugin`). Order matters:
  1. `entry` not an object → `null` (caller keeps its own missing/absent handling).
  2. **A non-empty string `command` → `null`.** A stdio entry in `~/.claude.json` is a hand-edit
     or a plugin-managed shape (the existing comment above `reportEntryCommand` says so), and
     `reportEntryCommand` already owns it. Without this arm the new validator warns "unexpected
     config" on every Claude-Desktop-style entry — a regression dressed as a fix.
  3. `type !== "http"` or `url` missing / not parseable by `new URL()` / path not containing
     `/mcp` → `warn`, message naming the observed `type=` and `url=` (the twin's wording, kept
     verbatim so the two levels read alike), `fix` = `setupApplyRemedy(cliAvailable())` at the
     user level and the existing `brokenFileFix()` at the project level — passed in by the caller,
     not chosen inside, because a project-local `.mcp.json` is not Tandem's to rewrite.
  4. URL port (`new URL(url).port || "80"`) ≠ `mcpPort` → `warn` naming **both** numbers and the
     env var, e.g. `~/.claude.json tandem points at port 3479 but Tandem is configured for 4918
     (TANDEM_MCP_PORT) — Claude Code will not connect`.
  5. Otherwise `pass` with the existing text.
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
2. `{ tandem: { type: "http", url: "http://127.0.0.1:3479/" } }` → warn naming the url. Kills
   "validate type only".
3. `{ tandem: { type: "http", url: "http://127.0.0.1:9999/mcp" } }` → warn naming **9999 and
   3479**. Kills a validator that accepts any `/mcp` URL — the issue's headline case.
4. `{ tandem: { command: "/abs/node", args: [...] } }` → **no** `unexpected config` warn from the
   new validator. Kills arm 2 being dropped.
5. The healthy entry (`type: "http"`, `…:3479/mcp`) still `pass`es — the existing BOM spec already
   asserts this; add an explicit one so a future over-eager arm reds every working install.
6. Project-level twin, in the `checkMcpJson` describe: the same wrong-port entry in a temp cwd's
   `.mcp.json` warns too, and its `fix` still names `.mcp.json.example` (kills a copy-paste that
   fixes one level and kills the other's remedy).
7. Port mismatch under `TANDEM_MCP_PORT`: with #1806 wired, `vi.stubEnv("TANDEM_MCP_PORT", "4918")`
   + a `…:3479/mcp` entry + `runDoctorCli({ json: true })` → the warn names 4918. This is the only
   spec that proves the threading reaches the CLI rather than only `runDoctor(opts)`.

## Done when

Both levels run one validator; a wrong `type`, a URL without `/mcp`, and a port that disagrees
with the probed MCP port each warn with the observed value; a stdio entry and a healthy HTTP entry
are untouched; typecheck + the CLI suite green.

## Not in scope

A reachability comparison against a live server's advertised port (the probed port is the same
answer with no ordering change — `user-mcp-config` runs before `ports`); `MAX_CONFIG_BYTES` in
doctor; the `tandem-channel` entry's own validation; `apply.ts`'s hardcoded `MCP_URL` (a separate
defect, named in the PR body, no issue in this group).
