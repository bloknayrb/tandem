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

- **`runDoctor` does not read the environment.** Its header contract ("Performs NO `process.argv`
  reads… Embedders that know their live ports pass them via `opts`") stays true, and one
  resolution site means the server embedder cannot end up with the CLI's answer layered under its
  own. `vitePort`/`homeOverride` are untouched.
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
platform this wave runs on), exactly as the `checkUserMcpConfig wiring` describe does; `afterEach`
does `vi.unstubAllEnvs()` and `rmSync`. The only live variable in these specs is the port.

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
3. Same shape for `TANDEM_MCP_PORT` with a listener bound on it, asserting the message names it
   under the same word-boundary rule — kills a fix that wires only `wsPort` (the two are separate
   `??` reads).

Both wiring tests must avoid the reserved harness ports and 3478/3479 by construction: take the
port from a `listen(0)` handle, never a literal.

## Done when

`TANDEM_PORT=<n> tandem doctor` and `TANDEM_MCP_PORT=<n> npm run doctor` probe `<n>` and say so;
the three specs above are green; `runDoctor`'s no-env contract is intact; typecheck + the CLI
suite green.

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
