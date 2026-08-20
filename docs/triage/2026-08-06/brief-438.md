# Per-client identity, after the ground moved (#438 re-scoped)

**Issues:** #438, #1252, #1253, #1249   **Decision needed:** Should #438 close as superseded — with
its remaining work living in #1252/#1253/#1249 — and the era question be answered "dual-era, legacy
branch retained indefinitely, no removal date set"?

## What these are

#438's Phase 1 shipped: ADR-045 (`docs/decisions.md:900`, accepted 2026-07-22, PR #1233) keys one
`McpServer` per transport by `Mcp-Session-Id`, so Claude Code and Cowork no longer evict each other.
Coverage: `tests/server/transport-registry.test.ts`, `mcp-multi-session.test.ts`,
`mcp-session-context.test.ts`.

What #438's body still asks for, and where it now stands:

- **§3.3 per-client inbox — still global.** `src/server/mcp/awareness.ts:54` — `surfacedIds` is a
  module-level `Map`, keyed `${documentId}:${itemId}` (`ledgerKey`, :71), not by client. Same for
  `replySurfacedIds` (:68). Unchanged since filing.
- **§3.4 directed event routing — still broadcast.** Confirmed in ADR-045's Cross-references
  paragraph ("Still single-client after this change and tracked separately").
- **§3.1/§3.2 identity — the mechanism was deleted upstream.** MCP `2026-07-28` (SEP-2567/SEP-2575)
  removes protocol-level sessions, `Mcp-Session-Id`, and `initialize`. ADR-045's 2026-07-30 amendment
  and `docs/spikes/per-client-identity-spec.md:10` both say plainly: *nothing new may be keyed on a
  session-scoped `clientId`*. §4's recommendation table is annotated "read as the shipped legacy
  design, not as forward guidance"; §4.1's sequencing is marked superseded.
- Nothing is broken today: SDK 1.30.0 (what `package-lock.json` pins) still exports
  `LATEST_PROTOCOL_VERSION = '2025-11-25'`.

Three successor issues already own the pieces: **#1252** (era strategy), **#1253** (what the stateless
server shape actually is, incl. re-testing ADR-012's untested 2024 "stateless mode crashes" claim),
**#1249** (`hasSession` becomes partial — supplement, don't invert its failure mode).

## Why they stalled

#438 stalled because its foundation was withdrawn mid-flight. §3.3/§3.4 are *sequenced off* an
identity scheme, and the identity scheme's substrate (`Mcp-Session-Id`) is being deleted, while its
replacement is unavailable: `io.modelcontextprotocol/clientInfo` is spec-marked self-reported,
"SHOULD NOT" drive behavior, and carries only `{name, version}` — two concurrent Claude Code instances
send byte-identical values. So the work is not blocked on effort; it is blocked on an external
dependency (the TS SDK adopting `2026-07-28`) that has not happened.

The compatibility matrix bounds the answer hard: modern-client→legacy-server **fails**, and
legacy-client→modern-server **fails** with *no fall-forward*. Dual-era is the only non-breaking
destination.

> **Note added 2026-08-20 (#1332, PR #1548) — the snapshot text above is superseded on two points;
> it is left as written.** `io.modelcontextprotocol/clientInfo` does not carry only `{name, version}`
> — SDK 1.30.0's `ImplementationSchema` already declared `name`, `version`, and optional `title`,
> `icons`, `description` and `websiteUrl`, and the GA v2 `Implementation` type matches. The
> conclusion drawn from it is unchanged: none of those six fields is per-connection, so two
> concurrent Claude Code instances still send byte-identical values. And the external dependency is
> no longer un-happened — `@modelcontextprotocol/server@2.0.0` went GA 2026-07-27. See ADR-045's
> Decision 6 bullet in [`docs/decisions.md`](../../decisions.md).

## Options

1. **Close #438 as superseded; let #1252/#1253/#1249 carry it.** Costs a body edit recording which
   acceptance criteria shipped (transport multiplexing) and which moved (identity, inbox, routing).
   Forecloses nothing — the spike doc survives and is already amended.
2. **Keep #438 open as the umbrella over the three.** Costs a fourth issue's attention on a topic
   where the sub-issues are better-written than the parent, and #438's body actively misleads
   (§3.2 premise, §4 table, §4.1 sequencing all annotated "superseded" in the spike but not in the
   issue).
3. **Do §3.3 (per-client inbox) now, era-independently.** Tempting because the inbox bug is real, but
   there is no client key to use on the modern branch, so it would ship a legacy-only fix that has to
   be redone. Only worth it if two-Claude-inbox contention is hurting today — no evidence it is.
4. **Answer #1252 pre-emptively as "modern-only at the SDK bump".** Cheapest to implement, and it is
   the one irrecoverable choice: it breaks every un-upgraded Claude Code and Cowork install on one
   day, client-side unrecoverable.

## Recommendation

**Option 1, plus commit the era position now**: dual-era, legacy branch retained with **no removal
date**, reviewed only if Claude Code itself ships modern-only. Deciding this costs nothing today and
removes the single scenario (option 4) that cannot be undone. Note the watch item honestly: what keeps
Tandem working is Claude Code's *implementation* choosing to probe-and-fall-back, not a protocol
guarantee — there is no signal that surfaces a change before users hit it.

Order the successors: **#1253 first** (a probe, not a design — and ADR-012's stale crash claim sits
directly on the migration path), then #1249, then #1252's timing once the SDK moves. §3.3/§3.4 stay
parked behind the identity scheme.

## If yes / If no

**If yes:** edit #438's body with a "shipped / moved / dropped" map, close it, cross-link the three
successors; add a one-paragraph amendment to ADR-045 recording the dual-era-indefinitely position and
pointing at #1252; add a recurring check of the SDK's `SUPPORTED_PROTOCOL_VERSIONS` (a `tandem doctor`
line or a scheduled agent) since #1252's watch item currently has no detector. No `src/` changes.

**If no:** #438 stays open and its body needs the same rewrite anyway, or it keeps handing readers a
superseded design table — and #1252 stays unanswered, which leaves the modern-only path live as a
default rather than a rejected option.
