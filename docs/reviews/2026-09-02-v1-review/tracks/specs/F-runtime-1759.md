# F-runtime — #1759 the stdio bridge's identity check includes `APP_VERSION`, so every Tandem upgrade breaks Claude Desktop until it is restarted

Branch `fix/push-paths-runtime-1759`. Closes #1759. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:14`. Probe: none scripted — the harness in
`tests/cli/mcp-stdio.test.ts` (`makeSessionServer` + `fake.setServerInfo` + `fake.retireSession`)
already reproduces the whole outage in-process, so the spec's tests *are* the probe.

## Problem

`describeServerInfo` (`src/cli/mcp-stdio.ts:269-273`) renders `serverInfo` as `` `${name}@${version}` ``
and that string is the identity the reconnect compares (`captureNegotiated` stores it in
`negotiatedServerInfo`; `runReconnect`'s fail-closed check at `:1104-1113` compares it plus
`protocolVersion`). `serverInfo.version` is `APP_VERSION`, so a **normal upgrade** — desktop
auto-update, `npm i -g tandem-editor` — is byte-for-byte indistinguishable from a foreign process
that grabbed the port. Every request afterwards returns `-32000 upstream identity changed across
re-initialize` until the user quits and reopens Claude Desktop, and the ladder replays `initialize`
at the `BACKOFF_MAX_MS` = 30 s cap forever, minting a fresh server session each time (ADR-045 LRU
churn). The existing spec at `tests/cli/mcp-stdio.test.ts:2106` changes name *and* version together
so it cannot see this, and `:1557-1565` pins the `name@version` render as if it were the contract.

## Fix

All in `src/cli/mcp-stdio.ts`. Split "who is this" from "what version is it": identity is
`serverInfo.name` + `protocolVersion`; the version is logged, never compared.

- `readHandshakeIdentity` returns `{ protocolVersion, serverName, serverVersion }`. `serverName`
  comes from a new `describeServerName(info)` — `typeof i?.name === "string" ? i.name : "<unknown>"`,
  keeping the sentinel and its rationale comment — and `serverVersion` is the same shape over
  `i?.version`. **Delete `describeServerInfo`** rather than keeping it beside the new function; two
  renderers where one is the contract is how the compared string and the logged string drift. Its
  only importer is the test file.
- `captureNegotiated` writes `negotiatedServerName` and `negotiatedServerVersion` in place of
  `negotiatedServerInfo`, **written-together-or-not-at-all**: the `negotiatedProtocolVersion ===
  undefined` branch at `:1093` reads "one clause, not two" from exactly that property.
- `runReconnect`'s check becomes `identity.protocolVersion !== negotiatedProtocolVersion ||
  identity.serverName !== negotiatedServerName`, the thrown message naming the names. Keep the
  literal `upstream identity changed across re-initialize` — one spec greps it today (`:2123`), and
  test 2 below is the second.
- The no-baseline branch at `:1093-1102` interpolates `identity.serverInfo`; it becomes
  `identity.serverName`. `tsc` catches this — noted only because **#1805 changes that same branch**,
  so land #1759 first (the implementation order already says so).
- Immediately before the identity check, when name and protocol match but `identity.serverVersion
  !== negotiatedServerVersion`, write one stderr line — `` `[tandem mcp-stdio] upstream version
  changed across re-initialize (was X, now Y); adopting the upgraded server` `` — and assign
  `negotiatedServerVersion = identity.serverVersion`, so a second upgrade in one long-lived session
  logs against the current value rather than the launch-time one.
- **Do not cap the identity-fail retry loop**, despite the issue's third suggestion. A cap makes a
  bridge that can never heal — the regression #1805 and #1804 fix in the same PR, and which this
  module's header comment already forbids in spirit. The churn the issue measured is a *consequence*
  of the version comparison: once an upgrade is adopted there is no identity-fail loop to cap.
  Recorded as an assumption.
- **Two one-clause doc corrections**, because this change makes both sentences false and nothing
  pins either, so they would rot silently. `CLAUDE.md:181`: "**fails closed if
  `serverInfo`/`protocolVersion` changed**" → "**fails closed if the server *name* or
  `protocolVersion` changed — a version change is adopted and logged (#1759)**", keeping the rest of
  the sentence including "never exiting on failure". `docs/decisions.md:1611` (the ADR-045
  amendment): "verifying `protocolVersion` and `serverInfo` against the original handshake" →
  "verifying `protocolVersion` and the server *name* … — a changed server *version* is adopted and
  logged (#1759)", leaving "It never exits" intact.
- Rules that bite: **stdout is reserved** (Critical Rule 3) — every line above is
  `process.stderr.write`. No Y.Doc write, no Y.Map key, no `/api` route, no MCP tool.

## Tests

All in `tests/cli/mcp-stdio.test.ts`, reusing `makeSessionServer` / `setServerInfo` /
`retireSession` / `handshake`.

1. **Version-only change reconnects.** Handshake, `fake.setServerInfo({ name: "fake-tandem",
   version: "9.9.9" })`, `fake.retireSession()`, `tools/list` id 2 → exactly one response for id 2
   and it is **not** an error; stderr contains `upstream version changed across re-initialize` and
   does **not** contain `upstream identity changed`. Kills today's code and any fix that only
   loosens the comparison when both fields move.
2. **Name-only change still fails closed.** Same shape with `{ name: "not-tandem", version:
   "0.0.0-test" }` (version identical) → id 2 answers `-32000`, stderr contains `upstream identity
   changed across re-initialize`, `child.exitCode` is `null`. Kills a fix that drops the name from
   the comparison entirely — the fail-open the check exists to stop.
3. **Rewrite the `describeServerInfo` unit block (`:1557`) as `describeServerName`**:
   `{name:"tandem",version:"1.2.3"} → "tandem"`; `{name:"tandem"} → "tandem"` (the version is now
   irrelevant, which is the point); `undefined` / `null` / `{name: 1}` → `"<unknown>"`. Keep the
   sentinel-collision comment.
4. Leave the existing `:2106` spec in place — after the rename it is test 2's both-changed sibling
   and remains a valid fail-closed case.

## Done when

A reconnect across a version-only change succeeds and says so; a name-only change still fails closed
with the unchanged message; `describeServerInfo` has no remaining referents; neither `CLAUDE.md:181`
nor `docs/decisions.md:1611` says the version is compared; `npm run typecheck` +
`npx vitest run tests/cli/mcp-stdio.test.ts` green.

**Files touched.** `src/cli/mcp-stdio.ts`, `tests/cli/mcp-stdio.test.ts`, `CLAUDE.md`,
`docs/decisions.md`.

## Not in scope

Terminating the stale server-side session on an identity failure; `SESSION_STABLE_MS` pacing; the
ADR-045 LRU policy; #1790's plugin version pin; capping the retry ladder.

## Review corrections (scope cut)

The round 1–3 logs were replaced by this section; the corrections that survive are folded into Fix
and Tests (the `:1101` interpolation rename, the one-spec grep count, both doc clauses, and the
"sanity check, not authentication" framing carried by CLAUDE.md's new wording).

**Removed**

- **Test 3 (protocol-only change) and its new `setProtocolVersion` knob on the fake.** The protocol
  half of the comparison is untouched here, and adding a harness knob to re-pin unchanged behaviour
  is scope the issue did not ask for; the existing `:2106` spec already exercises fail-closed.
- **Test 4 (count `initialize` POSTs, assert none for 3 s after an adopted upgrade).** Redundant and
  wall-clock-bound: test 1's **non-error** response for id 2 already proves the reconnect did not
  throw, and the 30 s ladder exists only downstream of that throw.
- **Test 1's second upgrade cycle** (`9.9.9` → `9.9.10`, asserting the second line reads `was 9.9.9,
  now 9.9.10`). The `negotiatedServerVersion` reassignment it pinned stays in Fix — one assignment
  on the line that logs — but a second retire/reconnect round-trip to observe a log string's
  argument is over-specification for a line no machine reads.

**Kept though outside `src/cli/mcp-stdio.ts`:** the two doc clauses. Each is one sentence this
change makes factually false, in files the project treats as instruction — two edits, not a
mechanism.

## Review corrections (second pass, post-PR)

**The identity is the name alone; `protocolVersion` is adopted like the version.** The first pass
kept `protocolVersion` in the fail-closed comparison ("the protocol half of the comparison is
untouched here"). That was wrong for the same reason the version was: the negotiated value is
whatever the server's bundled SDK answers — `SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ?
requested : LATEST` — so an SDK-bumping Tandem upgrade moves it for the very same replayed
`initialize`, and the bridge then threw `upstream identity changed` on every backoff tick, forever.
`runReconnect` now fails closed only on the server name (and on a *missing* `protocolVersion`,
because the baseline sentinel is `negotiatedProtocolVersion === undefined` and adopting `undefined`
would erase it), and logs-and-adopts a moved protocol version exactly as it does the server version.
Test 3's `setProtocolVersion` knob — cut in the first pass as scope — came back as the pin for this:
`adopts a protocol-version change across a reconnect when the server name matches`. `CLAUDE.md` and
the ADR-045 amendment were re-corrected to match.

**One writer, in fact.** The deferred-handshake branch's comment called `captureNegotiated` "the one
writer of the baseline" while the version-adoption line thirty lines later assigned
`negotiatedServerVersion` directly. `setBaseline` is now the single assigner; `captureNegotiated`
and the adoption path both call it, so the claim is true rather than aspirational.
