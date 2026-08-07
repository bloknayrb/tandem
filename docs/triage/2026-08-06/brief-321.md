# Hocuspocus WebSocket LAN auth — the precondition never fired

**Issues:** #321   **Decision needed:** Close #321 as "condition unmet", or park it with a named reopen trigger — which?

## What these are

#321 (filed 2026-04-17, `deferred`, `needs-design-decision`) proposes token auth on the Hocuspocus
WebSocket, explicitly conditioned: *"If a future use case requires Cowork or another sandboxed context
to connect to the Hocuspocus WS directly."* Its own Priority section says *"Low until a concrete need
surfaces. Don't build on spec."*

The precondition is unmet, and the code says so:

- **Hocuspocus is hard-bound to loopback with a comment naming this exact scenario.**
  `src/server/yjs/provider.ts:107-112` — `address: "127.0.0.1"`, `// Hocuspocus always binds loopback
  — the MCP bind-host env var does not apply here. WebSocket collaboration traffic stays local-only
  per the Cowork architecture.` `TANDEM_BIND_HOST` (`src/server/index.ts:512`) reaches only the MCP/API
  listener.
- **Cowork does not speak HTTP to Tandem at all, let alone WS.** ADR-023 (`docs/decisions.md:172`):
  the Cowork VM does not forward loopback HTTP, so the bridge is `npx -y tandem-editor@<v> mcp-stdio`
  — a stdio proxy that runs *on the host* and relays to `http://localhost:3479/mcp`. Probe 6 measured
  zero `tandem_*` tools over HTTP-in-plugin. Nothing crosses the VM boundary except stdio JSON-RPC.
- **Codex (#1265) is a host-local managed child**, spawned by the supervisor with an MCP config
  pointing at loopback — same posture as Claude Code. No sandbox, no WS.
- **The launcher is forbidden from widening the bind, except behind an opt-in nobody has built.**
  `src-tauri/src/integrations_probe.rs:322-324`: *"The launcher MUST NEVER set `TANDEM_BIND_HOST=0.0.0.0`
  unless the user has opted into LAN mode with an auth token (#477 PR 4 out of scope)."* The `unless`
  clause is the exception, and it is **unimplemented** — PR 4 was declared out of scope, so no code path
  sets the var today. The prohibition is therefore absolute in practice but conditional in principle:
  building that opt-in is exactly what would fire #321's precondition.

One thing did change since filing: the WS is no longer origin-check-only. `onAuthenticate`
(`provider.ts:136-144`) now runs, gating every room — including `CTRL_ROOM` — on the server run's
`generationId`. That is a stale-tab correctness gate, **not** a security token (the generation is
served by loopback-only `GET /api/info`), but it means the auth *hook wiring* #321 scoped is already
in place; only the credential would be new.

## Why they stalled

Not neglect — the issue is a correctly-written conditional that has been evaluated as false at every
look. It carries `deferred` + `needs-design-decision`, so triage keeps re-reading it as an open design
question when it is actually a dormant trigger. The cost is one issue's worth of recurring attention,
paid roughly quarterly since April.

## Options

1. **Close as "condition unmet", link ADR-023 + `provider.ts:112`.** Costs nothing; forecloses the
   free-standing paper trail if LAN collaboration is ever proposed. The design sketch (subprotocol vs
   first-message, constant-time compare, layered origin check) is preserved in the closed issue body,
   which is fully recoverable.
2. **Park: strip `needs-design-decision`, keep `deferred`, edit the body to state the trigger.**
   Costs a few minutes and keeps one dormant issue in the open count. Forecloses nothing.
3. **Build it now.** Rejected by the issue's own text. It would also be built against no consumer, so
   the wire format would be unvalidated — the exact failure mode the "don't build on spec" line names.

## Recommendation

**Option 2, park.** Close is tempting and nearly right, but #321 is the only artifact naming the
loopback-binding assumption as a *decision* rather than an incidental comment, and it is a real
constraint on any future multi-device or LAN-collaboration story. The trigger to write in:
**reopen when any consumer needs Y.Doc sync from a context that cannot reach 127.0.0.1** — a
sandboxed VM, a second device, or a hosted collaborator. Removing `needs-design-decision` is what
stops it from re-surfacing in triage; nothing is pending Bryan's design input until the trigger fires.

## If yes / If no

**If park (yes):** one edit to the issue body adding the trigger sentence, drop the
`needs-design-decision` label. No code work. Optionally, a one-line pointer from
`docs/decisions.md` ADR-023's consequences to #321 so the constraint is discoverable from the ADR.

**If close (no):** same label/close action, plus a sentence in ADR-023's consequences recording *why*
WS stays loopback — otherwise the constraint lives only in a code comment and a closed issue, and the
next person proposing LAN mode has to rediscover it.
