# F-doctor — #1806 `tandem doctor` ignores `TANDEM_PORT` / `TANDEM_MCP_PORT`

Branch `fix/doctor-and-skill-version-skew-1806`. Closes #1806. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:18`. **First of four; #1807 uses the port
this fix resolves, so land it first.**

## Problem

`runDoctorCli` calls `report = await runDoctor();` with no options (`src/cli/doctor.ts:3005`),
while `RunDoctorOptions` already carries `wsPort`/`mcpPort` and `runDoctor` resolves them as
`opts.wsPort ?? DEFAULT_WS_PORT` (`:2877-2878`). Nothing on the CLI path supplies them, so a user
who moved the server with the documented `TANDEM_PORT` / `TANDEM_MCP_PORT` (`docs/configuration.md:13-14`,
honoured at `src/server/index.ts:98-99`) gets `Ports 3478 + 3479 not listening — server not
running` plus a remedy that starts a **second** instance on the defaults. `scripts/doctor.mjs`
(`npm run doctor`) routes through the same wrapper. The `/api/diagnostics` embedder already
threads live ports (`src/server/mcp/routes/diagnostics.ts:47-49`), which is why this only bit the
CLI.

The issue's second half ("print the ports doctor probed") is **already satisfied** — all three
`checkPorts` branches interpolate `wsPort`/`mcpPort`. Pin it, don't rewrite it.

## Fix

`src/cli/doctor.ts` only, both additions in the printer half:

- Module-private `envPort(raw: string | undefined, fallback: number): number` that **mirrors
  `src/server/index.ts:98-99` deliberately**: `parseInt(raw || String(fallback), 10)`, then
  `Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback`. `parseInt`, not `Number` and not
  `backend-ports.ts`'s `/^\d{1,5}$/` — the point is to probe **where the server actually binds**,
  and the server's `parseInt` binds `4918abc` on 4918. A stricter parser would re-create the false
  "not running" for exactly the inputs the server accepts.

  **The `1..65535` clamp is a probe-side decision, not a mirror of the server.** `listen(0)` binds
  an OS-chosen ephemeral port, so `TANDEM_PORT=0` is not "input the server would reject" — it is
  *undiagnosable from outside the process*. The clamp picks the default because `3478 not
  listening` is at least a shape the user recognises. Say that in the code comment.
- `resolveDoctorPortsFromEnv(env: NodeJS.ProcessEnv = process.env): { wsPort: number; mcpPort: number }`,
  **exported**, returning `{ wsPort: envPort(env.TANDEM_PORT, DEFAULT_WS_PORT), mcpPort:
  envPort(env.TANDEM_MCP_PORT, DEFAULT_MCP_PORT) }`. `runDoctorCli` calls
  `runDoctor(resolveDoctorPortsFromEnv())`.

Not changed: `runDoctor` gains no read of the two variables (one resolution site, so the server
embedder cannot end up with the CLI's answer layered under its own); `src/server/index.ts` is not
refactored onto the helper; no new check and no new message.

Rules that bite: Critical Rule 3 does not apply (`runDoctorCli`'s stdout is the documented CLI
surface — see its header at `:2993-2996`). No Y.Doc, no Y.Map, no testid, no `/api` route.

## Tests

`tests/cli/doctor.test.ts`, one new `describe`.

**Its `beforeEach` stubs a scratch home, not just the port.** `runDoctorCli` has no `homeOverride`
seam, so tests 2 and 3 run the *whole* doctor, including `checkUserMcpConfig` and
`checkTandemPlugin`, which read `HOME`/`USERPROFILE` directly. `mkdtempSync` plus
`vi.stubEnv("HOME", dir)` **and** `vi.stubEnv("USERPROFILE", dir)` — both, because `homedir()`
reads `USERPROFILE` on Windows, the platform this wave runs on; `vi.unstubAllEnvs()` + `rmSync` in
`afterEach`. Do **not** copy the existing `checkUserMcpConfig wiring` describe's `beforeEach`
(`tests/cli/doctor.test.ts:2026-2031`), which stubs `HOME` alone — safe there only because that
check reads `HOME || USERPROFILE` itself (`src/cli/doctor.ts:1107`).

1. **Resolver table** on `resolveDoctorPortsFromEnv({ … })`: `"4918"` → 4918; unset →
   3478/3479; `""` → default (the `||` arm, which is why the server's spelling matters);
   `"4918abc"` → **4918**, not the default — kills a strict-regex resolver; `"abc"` → default;
   `"0"` and `"70000"` → default (the clamp).
2. **Wiring** — the discriminating one, because #1806 is a resolver-exists-but-is-not-called bug
   and a table test alone passes on the broken code. Bind a real listener on an ephemeral port,
   `vi.stubEnv("TANDEM_PORT", String(port))`, spy `process.stdout.write`, `await
   runDoctorCli({ json: true })`, `JSON.parse` the captured document, assert on the `ports`
   result's message: a word-boundary regex built from the probed port must match, and
   `expect(message).not.toMatch(/\b3478\b/)`. **Word boundaries, never `not.toContain("3478")`** —
   ephemeral ports 33478/43478/53478/63478 and 34780–34789 all contain that digit string, and the
   harness cannot choose which one the kernel hands out. Close the listener in `afterEach`.
3. Same shape for `TANDEM_MCP_PORT` — kills a fix that wires only `wsPort` (two separate `??`
   reads). **Its negative is `not.toMatch(/\b3479\b/)`, and `3478` is EXPECTED to appear**: with
   only the MCP port up, `checkPorts` takes its partial branch and names the still-default
   `wsPort` (`src/cli/doctor.ts:2081-2084`), so copying test 2's negative fails on correct code.

**The MCP-port listener is an `http.createServer` that answers, not a bare `net` server.**
`runDoctor` runs `checkHealth` whenever the MCP probe succeeds (`:2953-2959`) and `httpGet`
defaults to `timeoutMs = 3000` (`:2219`); a socket that never replies burns 3 s inside vitest's
5 s default. Four lines returning 404 answer immediately and still fail the health check. Give
both wiring specs an explicit `20_000` ms timeout, with the reason in a comment — test 2 also pays
`cliAvailable`'s ~335-`statSync` PATH walk (`:1258-1262`). Both take their port from a `listen(0)`
handle, never a literal, so the reserved harness ports and 3478/3479 are avoided by construction.

## Done when

`TANDEM_PORT=<n> tandem doctor` and `TANDEM_MCP_PORT=<n> npm run doctor` probe `<n>` and say so;
the three specs are green; the resolution site stays in `runDoctorCli`; typecheck + the CLI suite
green.

## Not in scope

`src/server/index.ts`'s parse; a doctor check that *reports* an unparseable `TANDEM_PORT`;
`TANDEM_URL` / `TANDEM_BIND_HOST`; #1758's lock sequence.

## Files touched

`src/cli/doctor.ts`, `tests/cli/doctor.test.ts`.

## Review corrections (scope cut)

**Removed**

- *The `grep`-based Done-when criterion* ("returns only the two lines inside
  `resolveDoctorPortsFromEnv`"). It is a drift guard the issue did not ask for, no test runs it,
  and it was already false at HEAD (`src/cli/doctor.ts:2873`'s docblock) — a criterion that reads
  red on correct code invites deleting an env-var name from a remedy that needs it.
- *The three round-by-round correction logs.* Their substantive decisions are inline above: the
  `0`/clamp rationale, the word-boundary assertions, test 3's own negative, the `http` listener
  and timeout, and the both-variables scratch-home rule.

**Kept**

Everything the issue names: the two env vars reach `runDoctor` through the CLI wrapper, and the
probed port is printed. No finding was outstanding against this spec.
