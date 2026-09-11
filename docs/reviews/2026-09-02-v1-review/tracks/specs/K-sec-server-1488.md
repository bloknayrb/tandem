# K-sec-server — #1488: the `/.well-known` presence oracle is an ACCEPTED finding; this PR changes no code for it

Branch `fix/security-lows-server-half-log-injection-unbounded-frames-a-leaking-413-and-two-presence-status-oracles-1822`. **Refs #1488 only, and #1488 is already CLOSED** (*not planned*, 2026-09-08; retitled `security(accepted):` on 2026-09-11). It sits on this group's row as a cross-reference because #1822 item 7's phantom-200s analysis touches the adjacent surface in the same file. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:462`. Tracked home for the acceptance: `docs/security.md:495-505` (`### Accepted (bounded) — decided, not fixed`), written there by #1979 on 2026-09-11.

## Problem

Nothing to fix. Restating the two halves so a reviewer does not re-derive either wrongly:

- **Half 1 — the oracle. ACCEPTED.** `src/server/mcp/server.ts`'s two `/.well-known/oauth-protected-resource[/mcp]` handlers (registered at `:736-760`, above `app.use(mcpApp)` at `:761`) carry no middleware at all: no `authMiddleware`, no `lanAwareApiMiddleware`, and — because they are above the mount — not the SDK's `hostHeaderValidation` either. They are therefore DNS-rebinding-reachable regardless of CORS, which is a real exception to `CLAUDE.md`'s confident phrasing of the loopback rule. Bryan accepted it: the payload is three fixed strings with a literal `127.0.0.1` and no PII, and the only thing it leaks — *Tandem is running on this port* — is already obtainable from `/health`. **An accepted finding is a live code condition, not a queue entry.** Adding `lanAwareApiMiddleware` here would silently overturn a recorded decision.
- **Half 2 — the wrong ordering comment. FIXED, not accepted.** `46decbd6` corrected it; `server.ts:678-680` now reads "mounted BEFORE the per-route DNS-rebinding check" and goes further than the issue asked, and `tests/server/server-security-invariants.test.ts:286-330` pins it behaviourally (a reordering fails with `expected 403 to be 401`), not by string match. Do not re-fix it and do not cite it as outstanding.

## Fix

**None.** Two traps the issue itself refutes, both of which look like hardening and are not:

- **The `Access-Control-Allow-Origin: *` on those two routes is not the mechanism.** The named consumer is Claude Code, a CLI that sends no `Origin` and enforces no CORS; RFC 9728 does not mandate the header; Tandem has no browser-based MCP client. The header is currently unused rather than required, so **removing it closes nothing** — it is a diff that changes behaviour for no security gain.
- **Do not add `lanAwareApiMiddleware`.** Loopback callers pass it unchanged, so the change looks free; the open question the issue actually poses is whether a supported **non-loopback** MCP client probes `/.well-known` by a hostname outside the allowlist, and that is Bryan's to answer. He answered it by accepting the finding.

If a reviewer believes the acceptance is wrong, the place to say so is the PR body — not the code.

## Tests

**None added.** The existing pins already cover both halves and must stay green, which is the whole test obligation here: `tests/server/server-security-invariants.test.ts:43-91` (Invariant 6 — both metadata routes, including the Host-spoof case) and `:286-330` (#1488 half 2's ordering guard). #1822 item 3 registers a JSON error handler on `mcpApp`, which is mounted **below** these two routes, so it cannot reach them — the Invariant 6 specs passing unchanged is the evidence for that claim.

## Done when

The PR body states, in one short paragraph, that #1488 was read, that it is an accepted finding, and that no code changed for it — so the next reader of this branch does not re-open it. `docs/security.md`'s accepted-findings entry is **not** edited (it was rewritten hours before this work; re-editing it is how a reconciliation date drifts).

## Not in scope

Any change to the two `/.well-known` handlers, their wildcard CORS header, or the "deliberately unguarded" comment above them. Re-fixing half 2. Editing `docs/security.md:495-505`.
