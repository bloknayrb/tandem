# F-runtime — #1759 the stdio bridge's identity check includes `APP_VERSION`, so every Tandem upgrade breaks Claude Desktop until it is restarted

Branch `fix/push-paths-runtime-1759`. Closes #1759. Ledger:
`docs/reviews/2026-09-02-v1-review/areas/shared-cli.md:14`. Probe: none scripted — the harness in
`tests/cli/mcp-stdio.test.ts` (`makeSessionServer` + `fake.setServerInfo` + `fake.retireSession`)
already reproduces the whole outage in-process, so the spec's tests *are* the probe.

## Problem

`describeServerInfo` (`src/cli/mcp-stdio.ts`, currently `:269-273`) renders `serverInfo` as
`` `${name}@${version}` ``, and that string is the identity the reconnect compares
(`captureNegotiated` stores it in `negotiatedServerInfo`; `runReconnect`'s fail-closed check at
`:1104-1113` compares it plus `protocolVersion`). The server's `serverInfo.version` is
`APP_VERSION` (`src/server/mcp/server.ts`, `new McpServer({ name: "tandem", version: APP_VERSION })`),
so a **normal upgrade** — desktop auto-update, `npm i -g tandem-editor` — is byte-for-byte
indistinguishable from a foreign process that grabbed the port. Every request after the upgrade
returns `-32000 upstream identity changed across re-initialize` until the user quits and reopens
Claude Desktop, and the retry ladder replays `initialize` at the `BACKOFF_MAX_MS` = 30 s cap
forever, minting a fresh server-side MCP session each time (ADR-045 LRU churn).

The existing spec at `tests/cli/mcp-stdio.test.ts:2106` (`"fails the reconnect closed when the
upstream identity changes"`) sets `{ name: "not-tandem", version: "9.9.9" }` — name *and* version
together — so it cannot see this, and `tests/cli/mcp-stdio.test.ts:1557-1565` pins the
`name@version` render as if it were the contract.

## Fix

Split "who is this" from "what version is it". Identity = `serverInfo.name` + `protocolVersion`;
the version is logged, never compared.

- `readHandshakeIdentity` returns `{ protocolVersion, serverName, serverVersion }`. `serverName`
  comes from a new `describeServerName(info)`: `typeof i?.name === "string" ? i.name : "<unknown>"`.
  Keep the sentinel and keep its existing rationale comment — a server that omits `serverInfo` is
  already non-conforming, `protocolVersion` is the remaining discriminator, and failing every
  reconnect against it would break a working setup to defend against an attacker who can already
  bind the loopback port. `serverVersion` is `typeof i?.version === "string" ? i.version :
  "<unknown>"`.
- **Delete `describeServerInfo`** rather than keeping it beside the new function. Two renderers
  where one is the contract is precisely how the compared string and the logged string drift, and
  the one-reader-for-both-handshakes argument in its own doc comment applies to the replacement.
  Its only importer is the test file.
- `captureNegotiated` writes `negotiatedServerName` and `negotiatedServerVersion` in place of
  `negotiatedServerInfo`. **They must stay written-together-or-not-at-all**, because the
  `negotiatedProtocolVersion === undefined` branch at `:1093` reads "one clause, not two" from
  exactly that property.
- `runReconnect`'s check compares `identity.protocolVersion !== negotiatedProtocolVersion ||
  identity.serverName !== negotiatedServerName`. The thrown message names the *names*
  (`was 2024-11-05/tandem, now 2024-11-05/not-tandem`) — keep the literal
  `upstream identity changed across re-initialize`. Exactly **one** spec greps it today
  (`tests/cli/mcp-stdio.test.ts:2123`, plus the PR body); spec test 2 below is the second, which is
  why that literal must not be reworded in the same change that adds the version-adoption line.
- **`readHandshakeIdentity` has a second interpolation site the rename must follow.** The
  `negotiatedProtocolVersion === undefined` branch at `:1093-1102` ends with
  `` refusing to adopt ${identity.protocolVersion}/${identity.serverInfo} `` — it becomes
  `` ${identity.protocolVersion}/${identity.serverName} ``. `tsc` catches it, so this is a
  don't-be-surprised note rather than a silent hazard; it is called out because **that same branch
  is the one #1805's preflight-recovery path lands on**, and #1805 changes its behaviour. Land
  #1759 first (the implementation order already says so) so #1805 edits the renamed form.
- Immediately before that check, when the name and protocol match but
  `identity.serverVersion !== negotiatedServerVersion`, write one stderr line —
  `` `[tandem mcp-stdio] upstream version changed across re-initialize (was X, now Y); adopting the upgraded server` `` — and assign `negotiatedServerVersion = identity.serverVersion` so the next
  upgrade in the same process logs against the current value rather than the launch-time one.
- **Do not cap the identity-fail retry loop**, despite the issue's third suggestion. A cap makes a
  bridge that can never heal, which is the regression #1805 and #1804 are fixing in the same PR and
  which this module's header comment ("We do NOT exit — killing a Claude Desktop child nothing will
  respawn is the regression this exists to prevent") already forbids in spirit. The churn the issue
  measured is a *consequence* of the version comparison: once an upgrade is adopted, there is no
  identity-fail loop to cap. Against a genuinely foreign server a 30 s probe is the price of
  healing when the real server returns. Recorded as an assumption.
- **Two tracked docs become false and are corrected in the same PR**, on the same rule #1804 applies
  to `docs/architecture.md` and `docs/mcp-tools.md`: a doc a change falsifies is fixed by that
  change. Both are present-tense descriptions of shipped behaviour, not dated historical records,
  and `grep -rn "serverInfo" docs/*.md CLAUDE.md` returns exactly these two lines — so they are the
  complete carrier set.
  - **`CLAUDE.md:181`** reads "it replays the captured handshake under a private id and **fails
    closed if `serverInfo`/`protocolVersion` changed**, never exiting on failure". After this fix
    the compared identity is `serverInfo.name` + `protocolVersion`, and a changed version is
    deliberately adopted and logged. Rewrite that clause as: **fails closed if the server *name* or
    `protocolVersion` changed — a version change is adopted and logged (#1759) — a
    substituted-upstream sanity check, not an authentication control; a process that can bind the
    port can report any name**. Keep the rest of the sentence, including "never exiting on failure",
    which #1805 and #1804 make more true rather than less. The trailing clause is not padding: the
    module's own doc comment (`src/cli/mcp-stdio.ts:260-267`) already records that the check cannot
    defend against a process that can bind the loopback port, and an unqualified "fails closed" in
    the MCP/Server gotcha list is exactly the shape the Security section warns about ("Do not read a
    gate as a guarantee"). No test reads this line, which is why it would otherwise rot.
  - **`docs/decisions.md:1611`** — the ADR-045 amendment — says the bridge replays the handshake
    "verifying `protocolVersion` and `serverInfo` against the original handshake and failing closed
    on a mismatch". Narrow that clause to: **verifying `protocolVersion` and the server *name*
    against the original handshake and failing closed on a mismatch — a changed server *version* is
    adopted and logged (#1759)**. Leave the rest of the amendment intact, including "It never
    exits", which #1805 makes more true. Nothing pins this sentence either.
- Rules that bite: **stdout is reserved** (Critical Rule 3) — every line above goes to
  `process.stderr.write`, never `console.log`. No Y.Doc write, no Y.Map key, no `/api` route, no
  MCP tool, so Critical Rules 1, 2 and 9 are not engaged.

## Tests

All in `tests/cli/mcp-stdio.test.ts`, reusing `makeSessionServer` / `setServerInfo` /
`retireSession` / `handshake`.

1. **Version-only change reconnects, twice.** Handshake, `fake.setServerInfo({ name: "fake-tandem",
   version: "9.9.9" })`, `fake.retireSession()`, send `tools/list` id 2 → exactly one response for
   id 2 and it is **not** an error; stderr contains `upstream version changed across
   re-initialize` and does **not** contain `upstream identity changed`. Kills today's code and any
   fix that only loosens the comparison when both fields move.
   **Then drive a second cycle in the same process** — `fake.setServerInfo({ name: "fake-tandem",
   version: "9.9.10" })`, `fake.retireSession()`, `tools/list` id 3 → non-error, and the *second*
   `upstream version changed` line reads `was 9.9.9, now 9.9.10`. That half is the only thing
   pinning the `negotiatedServerVersion = identity.serverVersion` reassignment the Fix requires;
   without it an implementation that logs against the launch-time `0.0.0-test` forever passes every
   other spec here, and the spec and its tests would disagree about what is contracted.
2. **Name-only change still fails closed.** Same shape with `{ name: "not-tandem", version:
   "0.0.0-test" }` (version identical) → id 2 answers `-32000`, stderr contains `upstream identity
   changed across re-initialize`, `child.exitCode` is `null`. Kills a fix that drops `serverInfo`
   from the comparison entirely — the fail-open the check exists to stop.
3. **Protocol-only change still fails closed.** Extend the fake with a `setProtocolVersion` knob
   alongside `setServerInfo`; name and version identical, `protocolVersion` `"2025-01-01"` → id 2
   answers `-32000`. Kills a fix that collapses both halves into a name check.
4. **No churn after an adopted upgrade.** In test 1, count `initialize` POSTs reaching the fake:
   exactly one after the retirement (the replay), and none in the following 3 s. Kills a fix that
   logs "upgraded" but still throws, leaving the 30 s ladder running.
5. **Rewrite `describeServerInfo`'s unit block (`:1557`) as `describeServerName`**: `{name:"tandem",
   version:"1.2.3"} → "tandem"`; `{name:"tandem"} → "tandem"` (the version is now irrelevant, which
   is the point); `undefined` / `null` / `{name: 1}` → `"<unknown>"`. Keep the sentinel-collision
   comment.
6. Leave the existing `:2106` spec in place — after the rename it *is* test 2's both-changed
   sibling and remains a valid fail-closed case.

## Done when

A reconnect across a version-only change succeeds and says so; a *second* upgrade in the same
process logs against the adopted value, not the launch-time one; name-only and protocol-only changes
still fail closed with the unchanged message; no repeated `initialize` after an adopted upgrade;
`describeServerInfo` has no remaining referents; **neither `CLAUDE.md:181` nor
`docs/decisions.md:1611` says the version is compared** — `grep -rn "serverInfo" docs/*.md CLAUDE.md`
returns no line claiming a version comparison; `npm run typecheck` +
`npx vitest run tests/cli/mcp-stdio.test.ts` green.

**Files touched.** `src/cli/mcp-stdio.ts`, `tests/cli/mcp-stdio.test.ts`, `CLAUDE.md`,
`docs/decisions.md`.

## Not in scope

Terminating the stale server-side session on an identity failure (the bridge deliberately never
sends `terminateSession`); the `SESSION_STABLE_MS` pacing; the ADR-045 LRU policy; #1790's plugin
version pin.

## Review corrections (round 1)

**Adopted**

- *The `:1093` no-baseline message also interpolates the removed `identity.serverInfo`.* Verified at
  `src/cli/mcp-stdio.ts:1101`. Added to the Fix bullet list, with the cross-reference to #1805 the
  finding asked for.
- *"two specs and the PR body grep for" the fail-closed literal overstates the count.* Verified:
  `grep -rn "upstream identity changed across re-initialize"` finds exactly one spec,
  `tests/cli/mcp-stdio.test.ts:2123`. Corrected to one today / two after spec test 2 lands.

**Not adopted**

- None.

## Review corrections (round 2)

**Adopted**

- *#1759 falsifies `CLAUDE.md:181` ("fails closed if `serverInfo`/`protocolVersion` changed") in the
  same PR that treats a doc made false by the change as a must-fix (#1804's precedent).* Verified
  verbatim, and verified that nothing pins the sentence — `grep` for the phrase returns only
  `CLAUDE.md`, so it would rot silently. Adopted: `CLAUDE.md` joins the fix's file set with the
  replacement wording, and "Done when" names it.

**Not adopted**

- None.

## Review corrections (round 3)

**Adopted**

- *#1759 falsifies a second tracked doc — the ADR-045 amendment at `docs/decisions.md:1611` states in
  the present tense that the bridge verifies `serverInfo` against the original handshake — and that
  file is not in the spec's file set, so "Done when" overclaims completeness while a live doc keeps
  telling the next reader that the version is compared.* Verified verbatim at
  `docs/decisions.md:1611`, and verified that it is the only remaining carrier:
  `grep -rn "serverInfo" docs/*.md CLAUDE.md` returns exactly `decisions.md:1611` and `CLAUDE.md:181`.
  Adopted: `docs/decisions.md` joins the fix's file set with the narrowed wording (`protocolVersion`
  and the server *name*, version adopted and logged), the rest of the amendment — including "It never
  exits" — left intact, and "Done when" now names both files with a grep-shaped criterion rather than
  one file.
- *The replacement `CLAUDE.md` wording risks reading as a security guarantee: the compared identity
  is forgeable by any process that can bind the loopback port, which is the same process class the
  check's own doc comment says it cannot defend against.* Verified at `src/cli/mcp-stdio.ts:260-267`,
  which already records the trade for the `<unknown>` sentinel. Adopted: the rewrite now ends "— a
  substituted-upstream sanity check, not an authentication control; a process that can bind the port
  can report any name", keeping the line consistent with the Security section's own "Do not read a
  gate as a guarantee" rule. Costs one clause.
- *The Fix requires reassigning `negotiatedServerVersion` after an adopted upgrade, but no specced
  test observes it, so a second upgrade in one process would log against the launch-time value with
  every test still green.* Verified: tests 1–5 each drive exactly one version change. Adopted rather
  than dropping the requirement — test 1 now drives a second `setServerInfo`/`retireSession` cycle
  and asserts the second stderr line reads `was 9.9.9, now 9.9.10`, and "Done when" names it. The
  alternative the finding offered (delete the reassignment) was not taken: without it the log line
  becomes progressively more misleading across a long-lived Claude Desktop session, which is the
  audience the line exists for.

**Not adopted**

- None.
