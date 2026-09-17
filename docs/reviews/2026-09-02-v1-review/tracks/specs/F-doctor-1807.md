# F-doctor — #1807 doctor passes a user-level `~/.claude.json` entry on key presence alone

Branch `fix/doctor-and-skill-version-skew-1806`. Closes #1807. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:19`. **Depends on #1806** — the port it
compares against is the one doctor actually probed.

## Problem

`checkUserMcpConfig` (`src/cli/doctor.ts:1206-1213`) does `if (!servers.tandem) warn else
r.pass("tandem registered in ~/.claude.json")` — key presence, nothing else. Its project-level twin
validates the same entry (`:1042-1043`): `tandem.type !== "http" || !tandem.url?.includes("/mcp")`
→ warn. So a leftover entry from an older install (`type: "stdio"`, a URL with no `/mcp`, or 3479
after the user moved the server) reads green in the file Claude Code actually consults, while
Claude Code cannot connect.

The port half is real: `buildMcpEntries` writes `` `${MCP_URL}/mcp` `` with `MCP_URL` hardcoded to
`DEFAULT_MCP_PORT` (`apply.ts:186`, `:511`), so an install moved with `TANDEM_MCP_PORT` gets a
config pointing at 3479 no matter what — and nothing says so today.

## Fix

`src/cli/doctor.ts` only. **The user level gains the validation; `checkMcpJson` is not touched
and no shared evaluator is introduced** (see the scope cut).

- Thread the port: `checkUserMcpConfig(r, cliAvailable, mcpPort)`, called from `runDoctor`, which
  already has `mcpPort` in scope (`:2877`). No new option, no second env read (#1806 keeps one
  resolution site).
- Module-private `validateUserTandemEntry(entry, mcpPort, cliAvailable): { message, fix } | null`,
  applied where `r.pass("tandem registered in ~/.claude.json")` is today. `null` → that same pass,
  byte-for-byte; otherwise `r.warn(message, fix)`. `reportEntryCommand` still runs either way.
  Order:
  1. A non-empty string `command` → `null`. A stdio entry in `~/.claude.json` is a hand-edit or a
     plugin-managed shape, and `reportEntryCommand` (`:1213`) already owns it — warning
     "unexpected config" there is a regression dressed as a fix.
  2. `type !== "http"`, or `url` missing / not parseable by `new URL()`, or **the parsed protocol
     is not `http:`**, or the parsed pathname not containing `/mcp` → message
     `` `~/.claude.json tandem: unexpected config — type=${type}, scheme=${scheme},
     pathHasMcp=${bool}` ``, `fix` = `setupApplyRemedy(cliAvailable())`. On an unparsable url both
     `scheme` and `pathHasMcp` render `(unparsable)`.
     **`pathHasMcp` is computed, not the constant `false`** — this arm also fires on a bad `type`
     with a perfectly good `/mcp` path (test 1), where a hardcoded `false` would be a false
     statement in doctor output. **`scheme` is named for the same reason**: `https://127.0.0.1:3479/mcp`
     clears type, path, host and port while Claude Code's TLS handshake fails, and without the
     scheme the warn reads `type=http, pathHasMcp=true` and names nothing actionable. Both `type`
     and `scheme` go through `describeClampedValue` — see the redaction bullet below.
  3. **The hostname is not one of `127.0.0.1` / `localhost` / `[::1]`** → message naming the
     SHAPE (`url names a non-loopback host`), never the hostname, and stating the condition
     truthfully: the server *listens on loopback unless it was started with `TANDEM_BIND_HOST`*.
     `fix` = a hand-edit pointing at `127.0.0.1:<mcpPort>`, prefixed with that same condition
     (*if Tandem was not started with `TANDEM_BIND_HOST`*). Doctor runs in the user's shell, which
     need not carry the server's env, so it does not pretend to know the bind host — it warns
     either way and lets the reader apply the condition. Host BEFORE port: a remote host on the
     *right* port is the one shape this check must never certify, and reporting the port there
     names the wrong field.
     `TAURI_HOSTNAME` is deliberately NOT in the set — this arm decides REACHABILITY, and the SDK's
     `localhostHostValidation()` 403s every `/mcp` request carrying `Host: tauri.localhost` on a
     default loopback bind.
  4. `parsedUrl.port !== String(mcpPort)` → message naming the observed port (or `(none)` when the
     URL carries none) and `mcpPort`, `fix`: *edit the `url` in `~/.claude.json` to port `<mcpPort>`,
     or unset `TANDEM_MCP_PORT` and restart Tandem*. **Compare the string form and treat a
     port-less URL as a mismatch** — the entry must name Tandem's MCP port explicitly; that is what
     kills the `URL.port`-is-a-string bug (`"3479" !== 3479` is always true) without a
     `defaultPortForProtocol` helper.
  5. Otherwise `null`.
- **The port warn must never emit `setupApplyRemedy`.** `MCP_URL` is hardcoded, so `setup --apply`
  re-writes 3479 and the warn re-fires forever — the dead-end-remedy defect this file has already
  been corrected for twice (`src/cli/doctor.ts:1163-1190`, and the doctrine by name at
  `:1345-1360`). The warn is unclearable on a deliberately moved install until `MCP_URL` is fixed;
  that is a chosen cost — a correct warning beats a green check on a config Claude Code cannot use.
- **No message and no `data` bag interpolates the `url` or any part of its path.**
  `checkUserMcpConfig`'s own docblock (`:1173-1180`) records why: `~/.claude.json` carries bearer
  tokens, `user-mcp-config` survives the `/api/diagnostics` filter, and the Report-a-bug link
  prefills a public issue body. The only scrubber downstream, `redactUserPaths`
  (`diagnostics.ts:83-115`), collapses paths and knows nothing about URL userinfo or a query token
  — and `r.warn` forwards `data` verbatim, so `r.warn(msg, fix, { url })` would satisfy every
  message-only assertion and still ship the credential. **`type` is NOT echoed verbatim**: arm 2
  fires precisely when the value is not enum-shaped, so `describeClampedValue` renders anything
  outside `/^[A-Za-z0-9_-]{1,32}$/` as `(unexpected)` — a `\r\x1b[2K` value repaints doctor's own
  warn line as a pass, a bare `\n` forges a second result line, and the value is length-unbounded
  on the way to the Report-a-bug prefill. The scheme takes the same renderer: it comes off a
  *parsed* `URL` so control bytes are impossible, but one renderer keeps the two fields from
  drifting apart on the rule that governs both. The scheme is the only part of the url that is
  ever named, and it can carry no secret — it is neither host, userinfo, path nor query.
- `warn`, never `fail` — parity with the twin; `tandem doctor` must not start exiting 1 on a
  machine whose tools arrive via the plugin.

Rules that bite: none of Critical Rules 1–9 touch this path; no route, no tool, no testid, no skill
edit.

## Tests

`tests/cli/doctor.test.ts`, extending the existing `checkUserMcpConfig wiring (~/.claude.json)`
describe (scratch `mkdtempSync` home, `vi.unstubAllEnvs()` in `afterEach` — **never the real
HOME**). Its `beforeEach` stubs `HOME` only today (`:2026-2031`); **it gains
`vi.stubEnv("USERPROFILE", home)` in the same commit** so the specs are machine-independent on
Windows.

1. `{ tandem: { type: "stdio", url: "http://127.0.0.1:3479/mcp" } }` → `user-mcp-config` warn whose
   message contains `type=stdio` **and `pathHasMcp=true`**. Kills "validate url only" and pins the
   computed boolean.
2. `{ tandem: { type: "http", url: "http://127.0.0.1:3479/" } }` → warn naming `pathHasMcp=false`,
   and the message must not contain the raw url. Kills "validate type only".
3. `{ tandem: { type: "http", url: "http://127.0.0.1:9999/mcp" } }` → warn naming **9999 and
   3479**, plus `expect(warn?.fix).not.toMatch(/setup --apply/)` (precedent:
   `tests/cli/doctor.test.ts:2057`). The issue's headline case, and the dead-end remedy is the half
   that ships silently.
4. **Redaction**, asserted over `JSON.stringify(report.results.filter((x) => x.check ===
   "user-mcp-config"))` — the whole filtered set, not one `find` (`checkUserMcpConfig` emits
   several outcomes under that name, `:1206-1230`), and `JSON.stringify` so `fix` and the `data`
   bag are covered, not just `message`. Two entries: `http://tok:s3cret@example.invalid:9999/mcp?key=abc`
   and `http://example.invalid:9999/mcp/s3cret` → each warns, and neither `s3cret`, `key=abc` nor
   the raw url appears anywhere.
5. `{ tandem: { command: "/abs/node", args: [] } }` → the `user-mcp-config` results **contain the
   pass whose message is `tandem registered in ~/.claude.json`** (`:1209`), and
   `reportEntryCommand`'s own outcome still appears. Assert the positive: that pass is reachable
   only when arm 1 returns `null`, so it reds if the `command` arm is dropped **and** if the
   validator returns `null` while emitting nothing at all.
6. **Healthy entry passes and says nothing about the url**:
   `{ type: "http", url: "http://tok:s3cret@127.0.0.1:3479/mcp?key=abc" }` → a **pass** with the
   existing message, and the same stringified-absence assertion as spec 4. Keep a plain
   `…:3479/mcp` pass assertion too, so an over-eager arm reds every working install.
7. Port threading: `runDoctor({ mcpPort: 4918 })` with a `…:3479/mcp` entry in the scratch home →
   the warn names 4918. The only spec that proves `mcpPort` reaches this check.
8. **Port-less URL**: `{ tandem: { type: "http", url: "http://127.0.0.1/mcp" } }` → a
   `user-mcp-config` warn whose message names **`(none)`** and **`3479`**, with
   `expect(warn?.fix).not.toMatch(/setup --apply/)`. This is the only spec that pins arm 3's
   "treat a port-less URL as a mismatch" half: every other URL here carries an explicit port, and
   spec 2's `…:3479/` short-circuits at arm 2 before arm 3 runs. Without it, the shape a reader
   reaches for to avoid warning on a port-less URL — `if (parsedUrl.port && parsedUrl.port !==
   String(mcpPort))` — is green on specs 1-7 while leaving port 80 reading
   `tandem registered in ~/.claude.json`, which is exactly the issue's stated defect: green in the
   file Claude Code consults, and Claude Code cannot connect.

## Done when

A wrong `type`, a non-`http:` scheme, a URL without `/mcp`, a non-loopback host, and a port that
disagrees with the probed MCP port each warn at the user level; no `user-mcp-config` outcome —
warn or pass, in `message`, `fix` or `data` — echoes the raw `url`, its hostname or any part of
its path; a non-enum-shaped `type` renders `(unexpected)` rather than reaching the output; the
port and host warns' `fix` does not name `setup --apply`; a stdio entry still passes and is left
to `reportEntryCommand`; a healthy HTTP entry passes; typecheck + the CLI suite green.

## Not in scope

`checkMcpJson` and the project-level `.mcp.json` messages (unchanged); a reachability comparison
against a live server's advertised port; `MAX_CONFIG_BYTES` in doctor (it does not fall out of this
validation — doctor reads through `readClaudeConfig`, a different reader from
`readConfigForMutation` — and the wave note says take it only if it does); the `tandem-channel`
entry's own validation.

## For Bryan

- **`apply.ts`'s hardcoded `MCP_URL`** (`:186`, `:511`) writes 3479 into every config regardless of
  `TANDEM_MCP_PORT`, which is what makes arm 3's warn unclearable on a moved install. Fixing it is
  a design call, not a mechanical edit: `MCP_URL` also feeds the desktop stdio entry's `TANDEM_URL`
  (`:502`) and the shim's (`:518`), and the *setup shell's* environment need not be the server's.
- `tandem doctor` has no config size cap while `setup` refuses at 16 MiB (#1891's For-Bryan item).

## Files touched

`src/cli/doctor.ts`, `tests/cli/doctor.test.ts`.

## Review corrections (scope cut)

**Removed**

- *The shared exported `evaluateTandemHttpEntry` with a six-field `opts` bag, and every change it
  dragged into `checkMcpJson`* — the `commandArmOwnedByCaller` flag, the project level's new
  `brokenFileFix()` / `portFix` strings, and specs 8 and 9. The issue asks for the **user-level**
  check to validate as the project one does; refactoring the project level is a behaviour change
  it did not request. **This makes the outstanding finding on spec 5 moot at the root**: with no
  shared evaluator there is no wording-dependent arm to guard. Spec 5 still asserts the positive
  pass message rather than a substring absence, per that finding's own fix.
- *`defaultPortForProtocol`* — a new helper for a case that cannot change any verdict (a port-less
  `https` entry mismatches the local MCP port either way). Arm 3 compares `parsedUrl.port` against
  `String(mcpPort)` and reports `(none)`, which is smaller and has the string/number bug designed
  out. The port-less-`https` spec went with it.
- *The requirement to file an `MCP_URL` issue and cite its number in a user-facing `fix` string*,
  and the `/#\d{3,}/` placeholder assertion that guarded it. The remedy now stands on its own
  wording; the defect is recorded under `bryan`.
- *The three round-by-round correction logs.* Their surviving decisions are inline: the redaction
  rule and its stringified-set assertions, the computed `pathHasMcp`, the no-`setup --apply` port
  remedy, and the both-env-vars stub.

**Kept**

Type, path and port validation at the user level with the observed values named; the stdio
carve-out; the redaction rule (the entries this fires on are exactly the ones whose url can carry a
credential, and the check reaches a prefilled public issue body).

## Review corrections (post-cut)

- **Spec 8 (port-less URL) added.** The seven specs left after the scope cut all carried an
  explicit port, so the port arm's stated requirement — treat a missing `URL.port` as a mismatch
  and report `(none)` — was pinned by nothing, and the natural `if (parsedUrl.port && …)` spelling
  passed all of them while leaving `http://127.0.0.1/mcp` (port 80) green. This is **not** the
  port-less-`https` spec the cut removed: that one existed to exercise `defaultPortForProtocol`,
  which is still gone. This one exercises the `(none)` branch the cut's own replacement design
  introduced.

## Review corrections (rounds 2–3, implementation)

Three review rounds against the implementation changed `validateUserTandemEntry`'s behaviour, and
the sections above are written to match what shipped. Recorded here rather than left implicit,
because each one was a *pass on a config Claude Code cannot use* — the defect #1807 names — and
the Tauri entry below was introduced by a well-meant arm added to prevent exactly that.

- **The non-loopback host arm (new arm 3).** A `http://attacker.example:3479/mcp` entry cleared
  every other arm, so doctor certified green the one shape where Claude Code would send
  `tandem_getTextContent` output and `tandem_edit` payloads to somebody else's machine.
- **`TAURI_HOSTNAME` removed from the loopback set.** It was added on the grounds that the desktop
  WebView's own origin is that name. `server.ts` passes `allowedHosts` — the only list
  `tauri.localhost` is on — solely when a LAN IP resolved; on a default loopback bind the SDK
  installs `localhostHostValidation()`, whose allowlist is exactly `localhost` / `127.0.0.1` /
  `[::1]`, and every `/mcp` request carrying `Host: tauri.localhost` is answered `403 Invalid
  Host`. The WebView origin is a CORS/Origin concern, not an MCP url host.
- **The scheme half of arm 2, and `scheme=` in its message.** Tandem's MCP server is plaintext
  HTTP on loopback, so `https://127.0.0.1:3479/mcp` passed type, path, host and port while the TLS
  handshake failed and no `tandem_*` tool ever appeared.
- **`describeClampedValue` for `type` and `scheme`.** The spec's original "`type` stays verbatim
  (enum-shaped)" was false on the one branch that prints it: arm 2 fires precisely when the value
  is *not* enum-shaped, and `~/.claude.json` is arbitrary JSON from disk that reaches
  `/api/diagnostics` and the public Report-a-bug prefill unbounded in length.

## Review corrections (post-ship)

- **The non-loopback warn no longer says "loopback-only".** That sentence was false under
  `TANDEM_BIND_HOST` (`docs/configuration.md`; `src/server/bind-check.ts`; `server.ts` puts the
  resolved LAN IP into the SDK's `allowedHosts`), so a user who deliberately bound to the LAN and
  pointed `~/.claude.json` at that IP got a warn on a working setup whose `fix` broke it. Doctor
  runs in the user's shell, which need not carry the server's env, so it cannot know the bind host
  and does not pretend to: the arm stays a warn, the message reads *listens on loopback unless it
  was started with `TANDEM_BIND_HOST`*, and the `fix` is prefixed with the same condition. The
  no-url-interpolation rule is untouched — neither string names the hostname. The LAN-address spec
  pins the new wording and the absence of the old one.
