# F-doctor — #1806 `tandem doctor` ignores `TANDEM_PORT` / `TANDEM_MCP_PORT`

Branch `fix/doctor-and-skill-version-skew-1806`. Closes #1806. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:18`. No experiment — the row is `[read]`;
the wiring test below is the experiment. **First of four; #1807 threads the port this fix
resolves, so land it first.**

## Problem

`runDoctorCli` (`src/cli/doctor.ts`, the `report = await runDoctor();` call inside its `try`)
calls `runDoctor()` with no options, while `RunDoctorOptions` already carries `wsPort`/`mcpPort`
and `runDoctor` resolves them as `opts.wsPort ?? DEFAULT_WS_PORT`. Nothing in the CLI path ever
supplies them, so a user who moved the server with the documented `TANDEM_PORT` /
`TANDEM_MCP_PORT` (`docs/configuration.md:13-14`, honoured at `src/server/index.ts:98-99`) gets
`Ports 3478 + 3479 not listening — server not running` plus a remedy that starts a **second**
instance on the defaults — into #1758's lock-then-`freePort` sequence. `scripts/doctor.mjs`
(`npm run doctor`) routes through the same wrapper and has the same hole. The
`/api/diagnostics` embedder does **not** — it already threads live ports
(`src/server/mcp/routes/diagnostics.ts:47-49`), which is why this only ever bit the CLI.

The issue's second half ("print the ports doctor probed") is **already satisfied**: all three
branches of `checkPorts` interpolate `wsPort`/`mcpPort` into their message. Pin it, don't rewrite
it.

## Fix

`src/cli/doctor.ts` only. Two additions, both in the printer half of the file:

- A module-private `envPort(raw: string | undefined, fallback: number): number` that **mirrors
  `src/server/index.ts:98-99` deliberately**: `parseInt(raw || String(fallback), 10)`, then
  `Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback`. `parseInt`, not `Number` and not
  `backend-ports.ts`'s `/^\d{1,5}$/` — the point is to probe **where the server actually binds**,
  and the server's `parseInt` binds `4918abc` on 4918. Diverging into a stricter parser would
  re-create the false "not running" for exactly the inputs the server accepts.

  **The `1..65535` clamp is a probe-side decision, not a mirror of the server, and `0` is the
  case that proves it.** `src/server/index.ts:98` is a bare `parseInt` with no guard, and
  `listen(0)` binds successfully on an OS-chosen ephemeral port — so `TANDEM_PORT=0` is not
  "what the server would fail to bind". It is *undiagnosable from outside the process*: doctor
  cannot know which port the kernel handed out, so neither `0` nor the default is a correct
  probe. The clamp picks the default because that is the answer whose message (`3478 not
  listening`) is at least a shape the user recognises. Say this in the code comment rather than
  claiming the guard only covers unbindable input.
- `resolveDoctorPortsFromEnv(env: NodeJS.ProcessEnv = process.env): { wsPort: number; mcpPort: number }`,
  **exported** (unit-testable, and the name says where it reads from), returning
  `{ wsPort: envPort(env.TANDEM_PORT, DEFAULT_WS_PORT), mcpPort: envPort(env.TANDEM_MCP_PORT, DEFAULT_MCP_PORT) }`.
  `runDoctorCli` calls `runDoctor(resolveDoctorPortsFromEnv())`.

Not changed, on purpose:

- **`runDoctor` does not read the two PORT variables.** Not "reads no environment" — it already
  reads `HOME`/`USERPROFILE` (`src/cli/doctor.ts:1106`, `:1970`) and `TANDEM_APP_DATA_DIR`, and
  the `homeOverride` docblock (`:2860-2862`) records that `checkUserMcpConfig` deliberately keeps
  doing so. Its header contract is narrower than that: "Performs NO `process.argv` reads and NEVER
  calls `process.exit`" (`:2871-2874`), plus "Embedders that know their live ports pass them via
  `opts`". One port-resolution site means the server embedder cannot end up with the CLI's answer
  layered under its own. `vitePort`/`homeOverride` are untouched.
- **`src/server/index.ts` is not refactored onto the shared helper.** Its lenient `parseInt` is
  the behaviour being mirrored, and rewriting the boot path is risk with no issue behind it.
- No new check, no new message. `checkPorts` already names the ports.

Rules that bite: Critical Rule 3 does not apply here (`runDoctorCli`'s stdout is the documented
CLI surface — see its header). No Y.Doc, no Y.Map, no testid, no `/api` route, no gated tool.

## Tests

`tests/cli/doctor.test.ts`, in a new `describe`.

**The new describe stubs a scratch home, not just the port.** `RunDoctorCliOptions` is `{ json?:
boolean }` (`src/cli/doctor.ts:2974-2976`) and `runDoctorCli` calls `runDoctor()` with no opts
(`:3005`), so there is no `homeOverride` seam on this path: tests 2 and 3 run the *whole* doctor,
including `checkUserMcpConfig` and `checkTandemPlugin`, which read `HOME`/`USERPROFILE`
directly. The reads are read-only, but leaving them pointed at the operator's real home makes the
specs' outcomes depend on machine state — the rule this group carries from #1894. So the
describe's `beforeEach` does `mkdtempSync` plus `vi.stubEnv("HOME", dir)` **and**
`vi.stubEnv("USERPROFILE", dir)` (both — `homedir()` reads `USERPROFILE` on Windows, which is the
platform this wave runs on); `afterEach` does `vi.unstubAllEnvs()` and `rmSync`. The only live
variable in these specs is the port.

**Do not copy the `checkUserMcpConfig wiring` describe's `beforeEach` verbatim** — it stubs `HOME`
alone (`tests/cli/doctor.test.ts:2026-2031`), which is safe *there* only because
`checkUserMcpConfig` reads `process.env.HOME || process.env.USERPROFILE` itself
(`src/cli/doctor.ts:1107`) and never falls through to `homedir()`. These specs run the whole
doctor, so the both-variables rule above is new, not inherited.

1. **Resolver table** on the exported `resolveDoctorPortsFromEnv({ TANDEM_PORT: …, TANDEM_MCP_PORT: … })`:
   `"4918"` → 4918; unset → 3478/3479; `""` → default (the `||` arm, which is why the server's
   spelling matters); `"4918abc"` → **4918**, not the default — kills a strict-regex resolver that
   would still misreport a server the real `parseInt` bound; `"abc"` → default; `"0"` and
   `"70000"` → default (the clamp, per the comment above).
2. **Wiring** — the discriminating one, because #1806 *is* a resolver-exists-but-is-not-called
   bug and a table test alone passes on the broken code. Bind a real `net` server on an ephemeral
   port, `vi.stubEnv("TANDEM_PORT", String(port))`, `vi.spyOn(process.stdout, "write")`, run
   `await runDoctorCli({ json: true })`, `JSON.parse` the captured document, and assert on the
   `ports` result's `message`.

   **Assert structurally, never by substring exclusion.** `expect(message).toMatch(new
   RegExp(String.raw`\b${port}\b`))` for the probed port, and `expect(message).not.toMatch(/\b3478\b/)`
   for the default. A bare `not.toContain("3478")` is an intermittent false red with no
   diagnosable cause: ephemeral ports such as 33478, 43478, 53478, 63478 and 34780–34789 all
   contain that digit string, and the harness cannot choose which one the kernel hands out.
   Close the listener in `afterEach`.
3. Same shape for `TANDEM_MCP_PORT` with a listener bound on it, asserting the message names the
   probed port under the same word-boundary rule — kills a fix that wires only `wsPort` (the two
   are separate `??` reads).

   **Its negative is `not.toMatch(/\b3479\b/)`, and `3478` is EXPECTED to appear.** With only the
   MCP port listening, `checkPorts` takes its partial branch and emits
   `` `Partial: port ${wsPort} down, port ${mcpPort} up` `` (`src/cli/doctor.ts:2081-2084`) —
   `wsPort` is still the default there because only `TANDEM_MCP_PORT` was stubbed. Copying test
   2's `not.toMatch(/\b3478\b/)` across therefore fails on correct code. Assert the absence of the
   *default MCP* port, which is the value this spec discriminates.

**The MCP-port listener must be an `http.createServer` that answers, not a bare `net` server.**
`runDoctor` runs `checkHealth` whenever the MCP probe succeeds (`src/cli/doctor.ts:2953-2959`) and
`httpGet` defaults to `timeoutMs = 3000` (`:2219`); a socket that accepts and never replies burns
that full 3 s inside vitest's 5 s default, on top of the ~335-`statSync` PATH walk `cliAvailable`
performs on a machine without the CLI (`:1258-1262`). A four-line
`http.createServer((_, res) => { res.statusCode = 404; res.end(); })` answers immediately and
still fails the health check, which is all the spec needs. Give **both** wiring specs an explicit
`20_000` ms timeout anyway, with that reason in a comment — test 2 pays the PATH walk too.

Both wiring tests must avoid the reserved harness ports and 3478/3479 by construction: take the
port from a `listen(0)` handle, never a literal.

## Done when

`TANDEM_PORT=<n> tandem doctor` and `TANDEM_MCP_PORT=<n> npm run doctor` probe `<n>` and say so;
the three specs above are green; **`runDoctor` gains no read of `TANDEM_PORT`/`TANDEM_MCP_PORT` —
the resolution site stays in `runDoctorCli`**; typecheck + the CLI suite green.

**The criterion is scoped to the READ, not the token**:
`grep -n 'process\.env\.TANDEM_PORT\|process\.env\.TANDEM_MCP_PORT' src/cli/doctor.ts` returns
only the two lines inside `resolveDoctorPortsFromEnv`. A bare-token grep is already false at HEAD
— `src/cli/doctor.ts:2873` is the `RunDoctorOptions` docblock ("the `/api/diagnostics` route on a
`TANDEM_PORT`-overridden server") — and #1807 lands two more mentions on this same branch, inside
arm 4's user-facing `portFix` strings ("or unset `TANDEM_MCP_PORT` and restart Tandem"). A
criterion that reads red on correct code invites a reviewer to delete the env-var name from a
remedy that needs it.

**Not** "`runDoctor` reads no environment": it already reads `HOME`, `USERPROFILE` and
`TANDEM_APP_DATA_DIR`, and its `homeOverride` docblock (`src/cli/doctor.ts:2860-2862`) says
`checkUserMcpConfig` deliberately keeps doing so. The header contract that must stay true is the
one it actually states — no `process.argv` reads, no `process.exit` (`:2871-2874`).

## Not in scope

`src/server/index.ts`'s parse; a doctor check that *reports* an unparseable `TANDEM_PORT` (the
fallback is silent, and the probed port is printed — see `assumptions`); `TANDEM_URL` /
`TANDEM_BIND_HOST`; #1758's lock sequence.

## Files touched

`src/cli/doctor.ts`, `tests/cli/doctor.test.ts`.

## Review corrections (round 1)

**Adopted**

- *`0` diverges from the server, which does bind `listen(0)`.* The spec asserted the clamp
  "covers only what the server would fail to bind at all", which `src/server/index.ts:98`
  contradicts. The Fix section now states the real reason `0` falls back — an ephemeral port is
  undiagnosable from outside the process — and requires that reason in the code comment. The
  table spec keeps `"0"` → default.
- *The wiring specs' `not.toContain("3478")` is an intermittent false red.* Replaced with
  word-boundary regexes in both directions (Tests 2 and 3), with the ephemeral-port collision
  cases named so the assertion is not "simplified" back.
- *The new describe runs the whole doctor against the real HOME.* Tests now open with an explicit
  scratch-home rule: `mkdtempSync` plus `vi.stubEnv` on **both** `HOME` and `USERPROFILE`
  (`homedir()` reads `USERPROFILE` on Windows), `vi.unstubAllEnvs()` in `afterEach` — matching the
  existing `checkUserMcpConfig wiring` describe, and closing the machine-dependence the #1894 rule
  exists for.

**Not adopted**

- None.

## Review corrections (round 2)

**Adopted**

- *Test 3's negative, copied from test 2, fails on correct code.* With only the MCP port bound,
  `checkPorts` takes its partial branch and names `wsPort` — still the default 3478
  (`src/cli/doctor.ts:2081-2084`). Test 3 now spells its own negative:
  `not.toMatch(/\b3479\b/)`, with a sentence saying 3478 is expected to appear.
- *The wiring specs' bare `net` listener makes doctor run `checkHealth` against a socket that
  never answers — a 3 s stall inside vitest's 5 s default.* The MCP-port spec now specifies a
  four-line `http.createServer` returning 404, and both wiring specs carry an explicit `20_000` ms
  timeout with the PATH-walk reason in a comment (`httpGet` default `timeoutMs = 3000` at
  `src/cli/doctor.ts:2219`; `cliAvailable`'s ~335 `statSync` calls at `:1258-1262`).
- *The scratch-home rule cited a precedent that does not exist.* `tests/cli/doctor.test.ts:2026-2031`
  stubs `HOME` only. The "exactly as … does" clause is gone; the paragraph now states the
  both-variables rule as **new**, and says why the existing describe is safe with one stub
  (`checkUserMcpConfig` reads `HOME || USERPROFILE` itself at `src/cli/doctor.ts:1107`) while
  these specs, which run the whole doctor, are not.
- *Done-when asserted a `runDoctor` no-env property that no test checks and the code does not
  have.* Replaced with the checkable form — `runDoctor` gains no read of
  `TANDEM_PORT`/`TANDEM_MCP_PORT`, the resolution site stays in `runDoctorCli` — plus a paragraph
  naming what the header contract actually says. The same false claim in "Not changed, on
  purpose" is corrected in place.

**Not adopted**

- None.

## Review corrections (round 3)

**Adopted**

- *The Done-when grep criterion is already false at HEAD, and #1807 falsifies it a second time on
  this branch* (raised twice). The criterion is now scoped to the read —
  `grep -n 'process\.env\.TANDEM_PORT\|process\.env\.TANDEM_MCP_PORT' src/cli/doctor.ts` returns
  only the two lines inside `resolveDoctorPortsFromEnv` — with both falsifying sites named
  (`src/cli/doctor.ts:2873`'s docblock, and #1807's arm-4 `portFix` strings), so a reviewer does
  not "fix" a red criterion by deleting the env-var name from a user-facing remedy.

**Not adopted**

- None.
