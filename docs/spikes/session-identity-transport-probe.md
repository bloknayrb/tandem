# Spike: getting a Claude-session identity onto the `/mcp` connection

**Status:** proposed — probe not yet run
**Issue:** #438 (per-client identity), prerequisite for #452
**Supersedes:** the "switch Claude Code to the stdio bridge" recommendation in
`.claude/plans/brainstorm-and-investigate-whether-elegant-scott.md` Phase 0, and
that plan's Phase 0 probe description (see "Reconciling with the plan" below)
**Related:** [per-client-identity-spec.md](per-client-identity-spec.md) §3.1,
[ADR-045](../decisions.md#adr-045), [ADR-012](../decisions.md#adr-012)

## The problem this spike exists to answer

Phase 1 (PR #1233, ADR-045) made the MCP server hold one `McpServer` per
`Mcp-Session-Id`, so two Claude Code sessions can now coexist. That fixed
eviction. It did **not** give the server any way to tell *which Claude session*
a given MCP session belongs to.

The asymmetry is not "push side vs pull side". It is **subprocess vs direct
socket**:

| Connection | Spawned how | Carries `X-Claude-Session-Id`? |
| --- | --- | --- |
| `/api/events` via channel shim (`src/channel/event-bridge.ts`) | subprocess of Claude Code | **yes** — `src/shared/sse-consumer.ts:232` fetches through `authFetch`, which attaches the header unconditionally (`cli-runtime.ts:174-181`) |
| `/api/events` via plugin monitor (`src/monitor/run.ts`) | subprocess of Claude Code | **yes** — same `sse-consumer.ts` code path |
| `/mcp` via plugin manifest (stdio bridge) | subprocess of Claude Code | **yes** — forwarded at `mcp-stdio.ts:127-130` |
| `/mcp` via `buildMcpEntries` (`apply.ts:256-258`, what `tandem setup` writes) | **no subprocess** — Claude Code's own process opens the socket | **no** |

Every path that involves a child process gets the id for free, because Claude
Code injects `CLAUDE_CODE_SESSION_ID` into children. The direct-HTTP `/mcp`
entry is the sole exception, and it is the entry every CLI user actually has.
Verified against the live `~/.claude.json` on this machine: the `tandem` entry
sits in **user scope** (top-level `mcpServers`), is direct-HTTP, and carries only
a static bearer token.

One further gap, independent of transport: the server currently reads the header
**only for `/mcp`, and only at `initialize`** (`server.ts:164-166`, consumed by
`openSession`). Nothing reads it on `/api/events` yet. That is a small addition,
but it is an addition — the push side has the identity and the server throws it
away.

**Scope of the blocker.** The missing `/mcp` identity blocks **auto-claim** — a
tab learning which session touched it. It does *not* block routing, the picker,
per-session inbox ledgers, or the registry, all of which can key on the SDK's own
`Mcp-Session-Id` plus the push-side header. An earlier framing of this as
"blocks Phases 2-4" was wrong.

## Why not the stdio bridge

The plan's original recommendation was to point Claude Code CLI at
`tandem mcp-stdio`, the same bridge the plugin manifest uses. Three reasons not
to:

1. **ADR-012 exists because of this.** "The stdio transport disconnects after
   the first `tandem_open` under Claude Code (Issue #8). Extensive investigation
   confirmed the bug is in Claude Code's stdio pipe management, not Tandem's
   server." The plugin path lives with it; making it the default for every CLI
   user re-adopts a known-bad transport for the *primary* surface.
2. **It reintroduces the version pin.** `npx -y tandem-editor@<CLI_VERSION>`
   goes stale on every release, and there is a live known bug where a stale
   global `tandem-editor` shadows the `@version` pin.
3. **It adds a system-Node dependency.** The HTTP entry needs none; the desktop
   app ships its own sidecar Node.

## Candidate mechanisms

Five, ranked by cost. The probe's job is to find the cheapest one that works.

**The dominant axis is not cost, it is failure shape.** A, C and E fail *soft*:
the header is absent or invalid, `normalizeSessionId` rejects it, and Tandem
degrades to no-identity while continuing to work. B can fail *hard* — see F1
below. Weigh that above the latency numbers.

### A — `${VAR}` expansion in a static header

Claude Code expands `${VAR}` / `${VAR:-default}` in `.mcp.json` and
`~/.claude.json`, and `headers` is an explicitly supported expansion location.
So:

```json
"headers": {
  "Authorization": "Bearer <token>",
  "X-Claude-Session-Id": "${CLAUDE_CODE_SESSION_ID:-}"
}
```

Zero processes, zero latency, one-line change to `buildMcpEntries`. It works
**only if** two things hold: the variable is present in Claude Code's *own*
process environment (not merely injected into subprocesses), and expansion
happens per-session at connect time rather than once at config load. Neither is
documented. Expect this to fail; it costs one probe to find out and it is by far
the best outcome if it doesn't.

**This mechanism has a dangerous failure mode that must be closed before it is
probed.** The documented behaviour for an unset variable with no default is that
the text is passed through **literally** — every session sends the string
`${CLAUDE_CODE_SESSION_ID}`. That string is *not* rejected by our validator:
`SESSION_ID_RE` is `/^[\x21-\x7e]+$/` (`src/shared/cli-runtime.ts:107`), the
whole printable-ASCII range, and `$`, `{`, `}` are all inside it. The literal
passes `normalizeSessionId` and arrives looking like a perfectly good session
id — **identical across every session**. That is worse than no identity: a
silent collision that routes every session's events to every other session while
appearing healthy.

Two consequences:

1. The `${VAR:-}` default is **load-bearing**, not cosmetic. Never emit the
   bare form.
2. Do not rely on that alone. Before P-A runs, tighten `normalizeSessionId` to
   reject `$`, `{`, and `}` outright. No legitimate id contains them — the
   stdio path forwards a UUID — so this costs nothing and turns a silent
   collision into a clean "no identity". Belt and braces, because the config
   file is hand-editable and a `:-` can be lost in a merge.

### B — `headersHelper`

`headersHelper` runs a shell command at connection time and merges its JSON
stdout into the connection headers. Documented properties:

- runs **from the session's current working directory** → `process.cwd()` gives
  project identity for free, with no config-file-per-repo
- runs **fresh on each connection**, at session start and on reconnect
- 10-second timeout; dynamic headers override same-named static ones
- requires Claude Code **v2.1.195+** (this machine: 2.1.218). *This floor is
  taken from Claude Code's MCP docs and has not been cross-checked against a
  changelog entry — verify before shipping a version gate on it.*
- Claude Code sets `CLAUDE_CODE_MCP_SERVER_NAME` / `_URL` for the helper

It would emit:

```json
{"X-Claude-Session-Id": "<CLAUDE_CODE_SESSION_ID if visible>", "X-Claude-Cwd": "<cwd>"}
```

Both fields best-effort; omit either when unavailable. Even if the session id is
invisible to the helper, **cwd alone covers the real use case** — one Claude
Code session per repo.

**B's serious problems, which rule it out unless the probe clears them:**

- **It can fail hard, taking Tandem with it.** The helper must write valid JSON
  to stdout; a non-zero exit or malformed output is reported to fail the
  *connection* with an auth error — not merely to omit the header. If the script
  crashes, its path goes stale after an update, or the Node binary moves,
  **Tandem's tools disappear from that session entirely**, which is strictly
  worse than today's always-works static header. A and C cannot do this.
- **It is a shell string, not an argv pair.** An earlier draft of this doc
  claimed it reuses "the exact shape `buildMcpEntries` already emits for the
  channel shim". That is wrong: the shim is `{command, args:[path]}`, spawned
  without a shell. `headersHelper` is one string parsed by a shell whose
  identity on Windows is undocumented (cmd.exe vs PowerShell — different quoting
  rules). **A path containing a space breaks it**, and that is not hypothetical:
  any Windows user whose account name has a space in it has spaces in
  `%LOCALAPPDATA%`.
- **Blast radius is every project.** The `tandem` entry is user-scope, so the
  helper runs on every Claude Code session in every directory, Tandem-related or
  not. The per-connection Node boot and the hard-failure mode are both paid
  there too.
- **It is hostile to synced/portable configs.** An absolute
  `nodeBinary`/script path baked into `~/.claude.json` is invalid on any other
  machine or after a reinstall — and per the first bullet, invalid means broken,
  not degraded.
- **Reported bugs exist.** Two behaviours have been reported against Claude
  Code: the helper silently never being invoked, and it not being re-invoked on
  long-lived HTTP transports at refresh boundaries. *These came from a review
  agent's search and are recorded here as things to test, not as established
  fact — do not cite the issue numbers without confirming them.* P-B1 and P-B4
  exist to test the behaviours directly, which is the only citation that matters.

If B is adopted anyway, the constraints are: absolute paths only, quoted
correctly for the platform shell, `isValidNodeBinary` on the interpreter
(`src/server/mcp/routes/_shared.ts:19`), script inside the Tandem install tree,
and the script must **never** exit non-zero — on any internal error it emits
`{}` and exits 0, so a Tandem bug can never take down the user's MCP connection.
Note also that `headersHelper` at project/local scope only runs after the
workspace trust dialog, while at user scope it runs unconditionally — which is
exactly why the string we write must never be attacker-influenced.

### C — static project-identifying header in a project-scoped `.mcp.json`

```json
{"mcpServers": {"tandem": {"type": "http", "url": "...",
  "headers": {"X-Tandem-Project": "tandem"}}}}
```

No process, no latency, fails soft. Costs: one checked-in file per repo; project
scope **outranks** user scope and replaces the entry wholesale (fields are not
merged across scopes), so this file must reproduce the full working entry; it
triggers per-repo approval and, since v2.1.196, does not self-approve in an
untrusted clone. It also lands on **every contributor who clones the repo**,
including those who never run Tandem — so it must degrade cleanly when no
Tandem server is listening rather than erroring at Claude Code startup.
Granularity is per-*project*, never per-session.

**Hard constraint:** a checked-in `.mcp.json` must NOT carry the bearer token.
It does not need to — `authMiddleware` exempts loopback by socket address
(`src/server/auth/middleware.ts:161-168`), and the URL is `127.0.0.1`. If a
variant ever needs the token, it goes in via `${TANDEM_AUTH_TOKEN}` expansion,
never a literal.

### D — accept picker-only binding

No `/mcp` identity, no auto-claim. The tab picker still works, bindings still
route, unbound documents still broadcast, and — because the push side already
carries identity — **notifications can still be routed**. This is the honest
floor and it is a perfectly shippable product: it just makes the user set the
binding once per tab instead of the tab learning it.

Note this is a much better floor than it looks. If P-C0 passes, D delivers the
originally reported symptom's fix (wake only the relevant session) in full. Only
the *learning* is lost.

### E — socket → PID correlation (named to be ruled out)

Because Claude Code's own process opens the loopback socket to `:3479`, the
server could map the accepted socket's remote port to its owning PID via OS APIs
(`GetExtendedTcpTable` on Windows, `/proc/net/tcp` on Linux) and read that
process's environment or cwd — recovering identity with no client cooperation at
all.

**Rejected, but record why:** platform-specific code on three OSes; reading
another process's environ needs elevated privileges on macOS and on hardened
Linux; it breaks the moment the connection is not loopback (LAN mode is a
supported configuration); and inspecting the user's other processes is a posture
Tandem should not adopt for a convenience feature. Listed so a future reader
knows it was considered rather than missed.

**Also ruled out: a self-reporting handshake tool** (spec §3.1 Option B) — a tool
Claude calls to announce its own session id. Claude Code has no supported way for
the agent to read its own session id from inside a session, so the agent has
nothing to report. *(Same caveat as above: this came from a review agent's search
of open feature requests and is not independently confirmed. It is cheap to
verify — if the id ever becomes introspectable, this option reopens.)*

## The probe

Run against a dev server with request-header logging on `/mcp` **and**
`/api/events`. **Log only header names and a hash or short prefix of values** —
`Authorization` is in the same object.

Ordered. Stop early if an earlier step settles the question.

| # | Question | Method | Decides |
| --- | --- | --- | --- |
| **P-C0** | Does the **channel shim** deliver a distinct `X-Claude-Session-Id` per concurrent session on `/api/events`? | Log the header server-side on `/api/events`; run two Claude Code sessions in two repos | Whether push-side routing works **at all**. Costs nothing new — the shim already sends it |
| **P-C1** | Same question for the **plugin monitor** | Same, with the monitor path instead | Whether the monitor is a second viable push path or must fall back to broadcast |
| **P-C2** | Does the push side's identity **match** the `/mcp` side's for the same logical session? | With both connected, compare the ids/cwds the two connections report | The correlation tier. See F2 below — existence is not enough |
| P-A | Does `${CLAUDE_CODE_SESSION_ID:-}` in a user-scope `headers` entry arrive as a real id? | Add the header to `~/.claude.json`, restart two sessions, log what `/mcp` receives **at `initialize`** | A vs B/C/D |
| P-B1 | Does a `headersHelper` run at all, and what does `/mcp` receive? | Point it at a script echoing a fixed sentinel | B viable |
| P-B2 | Does the helper's env contain `CLAUDE_CODE_SESSION_ID`, **distinct per session**? | Helper logs `^CLAUDE` env keys to a file; two sessions | full identity vs cwd-only |
| P-B3 | Is the helper's `cwd` the session's project dir? | Helper logs `process.cwd()`; run from two repos | cwd-only fallback |
| P-B4 | Does the helper re-run with a fresh value on a **natural** reconnect? | Manual reconnect first; then leave a session idle for hours and re-check | whether the value can go stale. A manual reconnect may not exercise the same path as a real refresh — a pass here is weak evidence |
| **P-B5** | What happens when the helper **fails**? | Delete the script / make it exit 1 / emit malformed JSON, then use Tandem | **Gating for B.** If the connection dies rather than degrading, B is disqualified unless the never-exit-nonzero rule fully contains it |
| P-C | Does a `.mcp.json`-scoped static header reach `/mcp`, and does it override the user-scope entry as documented? | Add a project-scoped entry in one repo only | C viable |

**Measure at `initialize`, not at `tools/call`.** Tandem captures
`claudeSessionId` only during the initialize handshake (`server.ts` `openSession`
← `onsessioninitialized`); a header that appears on later POSTs but not on
initialize is useless to us today. The plan doc's Phase 0 says "log the headers a
live `tools/call` carries" — that is the wrong measurement and this document
supersedes it.

**Run P-C0 first.** It is nearly free, it tests the *canonical* push path (per
CLAUDE.md the channel shim is canonical and the monitor is the installable
alternative), and a pass means the originally reported symptom is fixable
without any of A/B/C. The earlier draft of this doc put the monitor first; that
was backwards — it tests the newer, non-default mechanism.

## Correlation and degradation

Two connections must be tied together: `/mcp` (tool calls, where auto-claim
originates) and `/api/events` (SSE, where notifications are delivered).

- **Best case** (P-A or P-B2 yes): both carry the same `X-Claude-Session-Id`.
  Correlation is an equality check.
- **Fallback** (P-B3 yes, P-B2 no): `/mcp` carries `X-Claude-Cwd`, the push side
  reports its own cwd, and the registry correlates on normalized cwd. Two
  sessions in the same directory collapse into one identity — acceptable,
  because that is not the target scenario, but it must be *visible*: the
  registry marks such an entry ambiguous and the picker labels it, rather than
  silently routing to the wrong session.
- **Floor** (all no): outcome D — push-side routing only, no auto-claim.

### The degradation rule, and the branch that breaks it

**Rule:** no resolvable identity → no auto-claim; picker still works; unbound
documents broadcast; a monitor with no identity receives everything. Nothing is
ever silently dropped *because identity was missing*. This is what keeps manual
`tandem monitor` and older Claude Code versions working.

**The rule is not sufficient on its own.** It enumerates no-identity, unbound,
and bound-match. There is a fourth branch: **bound + identity resolved + does
not match.** Construct it from the cwd fallback — `/mcp` resolves cwd `X` via
the helper, the push subprocess independently resolves cwd `Y` through a
different spawn path, and `X ≠ Y` by so much as a trailing separator or a
symlink resolution. `shouldDeliver` then correctly concludes "I have an identity
and it isn't this binding's" and drops the event.

By the letter of the rule nothing is lost: the delivery ledger never marks it
delivered, so `tandem_checkInbox` surfaces it on the owner's next pull. But the
entire point of the feature is **push-driven idle wake**, and the session is
idle precisely because the push that should have woken it went nowhere. Nothing
will poll. The event is lost by the only measure that matters.

Mitigations, all required:

1. Add this branch explicitly to the delivery table and to the `shouldDeliver`
   unit-test matrix. It is not an edge case; it is the failure mode of the
   fallback tier.
2. Normalize aggressively on both sides before comparing (realpath, case-fold on
   Windows, strip trailing separators) — and normalize with **the same helper**,
   not two implementations.
3. **Fail open on mismatch, not closed.** If a document is bound to session `S`
   and the only connected sessions all have identities that differ from `S`,
   broadcast rather than drop. A bound-but-absent owner should not silence the
   event for everyone; that is the offline case, and D's floor behaviour is the
   right answer there.
4. Count mismatch drops and surface them in `tandem doctor`. A routing model
   that can silently discard has to be observable.

## Reconciling with the plan

`.claude/plans/brainstorm-and-investigate-whether-elegant-scott.md` Phase 0
describes a different probe: it measures headers on `tools/call`, and it puts
the monitor question second. Both are superseded here — this document is the
canonical probe description. The plan's Phases 1-4 are otherwise unaffected.

## What ships out of this spike

The probe is not the deliverable. Whichever mechanism wins, the change to
`buildMcpEntries` is a handful of lines, and the follow-on work — registry,
bindings, per-session ledgers, picker — is Phases 2-4 of the existing plan and
does not change shape based on the outcome. Three things do change:

- whether Phase 3's auto-claim path is built at all, or the picker is the only
  way a tab gets bound (P-A/P-B/P-C vs D);
- whether push routing is per-session or broadcast (P-C0/P-C1);
- whether the correlation tier is identity-equality or cwd-matching, which
  determines how much of the mismatch machinery above is needed.

**No probe outcome threatens PR #1233 / ADR-045.** Phase 1 keys purely on the
SDK-generated `Mcp-Session-Id` (`transport-registry.ts`) and never on
`X-Claude-Session-Id`, so it stands regardless.
