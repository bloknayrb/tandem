# K-sec-server — #1488: the `/.well-known` presence oracle is an ACCEPTED finding; this PR changes no code for it

Branch `fix/security-lows-server-half-log-injection-unbounded-frames-a-leaking-413-and-two-presence-status-oracles-1822`. **Refs #1488 only, and #1488 is already CLOSED** (*not planned*, 2026-09-08; retitled `security(accepted):` on 2026-09-11 — verified via `gh` in review round 1). It sits on this group's row as a cross-reference because #1822 item 7's phantom-200s analysis touches the adjacent surface in the same file. Ledger: `docs/plans/2026-09-06-open-issues-sweep.md:462`. Tracked home for the acceptance: `docs/security.md:495-505` (`### Accepted (bounded) — decided, not fixed`), written there by #1979 on 2026-09-11, and mirrored in `CLAUDE.md`'s security bullet as the fourth accepted finding.

## Problem

Nothing to fix. Restating the two halves so a reviewer does not re-derive either wrongly:

- **Half 1 — the oracle. ACCEPTED.** `src/server/mcp/server.ts`'s two `/.well-known/oauth-protected-resource[/mcp]` handlers (registered at `:737-758`, above `app.use(mcpApp)` at `:761`) carry no middleware at all: no `authMiddleware`, no `lanAwareApiMiddleware`, and — because they are above the mount — not the SDK's `hostHeaderValidation` either. They are therefore DNS-rebinding-reachable regardless of CORS, which is a real exception to `CLAUDE.md`'s confident phrasing of the loopback rule. Bryan accepted it: the payload is three fixed strings with a literal `127.0.0.1` and no PII, and the only thing it leaks — *Tandem is running on this port* — is already obtainable from `/health`. **An accepted finding is a live code condition, not a queue entry.** Adding `lanAwareApiMiddleware` here would silently overturn a recorded decision.
- **Half 2 — the wrong ordering comment. FIXED, not accepted.** `46decbd6` corrected it; `server.ts:678-680` now reads "mounted BEFORE the per-route DNS-rebinding check" and goes further than the issue asked. Do not re-fix it and do not cite it as outstanding. **Its guard is split across two describes and only one of them runs everywhere** — see Tests.

## Fix

**None.** Two traps the issue itself refutes, both of which look like hardening and are not:

- **The `Access-Control-Allow-Origin: *` on those two routes is not the mechanism.** The named consumer is Claude Code, a CLI that sends no `Origin` and enforces no CORS; RFC 9728 does not mandate the header; Tandem has no browser-based MCP client. The header is currently unused rather than required, so **removing it closes nothing** — it is a diff that changes behaviour for no security gain.
- **Do not add `lanAwareApiMiddleware`.** Loopback callers pass it unchanged, so the change looks free; the open question the issue actually poses is whether a supported **non-loopback** MCP client probes `/.well-known` by a hostname outside the allowlist, and that is Bryan's to answer. He answered it by accepting the finding.

If a reviewer believes the acceptance is wrong, the place to say so is the PR body — not the code.

## Tests

**None added.** The existing pins already cover both halves and must stay green, which is the whole test obligation here. Round 1 corrected what each one actually is:

- `tests/server/server-security-invariants.test.ts:43-91` — Invariant 6, three `fetch` GETs against both metadata routes including the Host-spoof case. Cross-platform, runs everywhere.
- `tests/server/server-security-invariants.test.ts:286-340` — half 2's guard, `describe('#1488 item 2 — comment above app.use("/mcp", authMiddleware) matches reality')`. Its two specs, `(a)` at `:324` and `(a2)` at `:328`, are **`readFileSync` source-text assertions**, not behavioural ones.
- `tests/server/server-security-invariants.test.ts:379` — the **behavioural** half, `describe.skipIf(process.platform !== "linux")("#1488 item 2 — auth runs before the DNS-rebinding Host check (behavioral; Linux only — needs a bindable 127.0.0.2 source address)")`, whose four specs are the `401`-before-`403` ordering cases. **This is the group's cross-platform statement for #1488** (wave-7 lesson 2): it is skipped in the author's local Windows pre-push run and in `windows-acl-proof`, and executes **only** in CI's ubuntu `check` job. A local green says nothing about it.

**Why #1822 item 3's new error handler cannot reach these routes — the structural argument, not the passing specs.** The two `/.well-known` handlers are registered on the **outer** `app` at `server.ts:737-758`, above `app.use(mcpApp)` at `:761`, so a request to either is answered and the response ended before `mcpApp`'s stack is ever entered; the handler registered inside `mcpApp` is not in their path. The earlier draft claimed "the Invariant 6 specs passing unchanged is the evidence" — that is **not** evidence: those specs are bodiless GETs that raise no error, so they pass identically with or without any error handler in front of those routes and cannot discriminate the claim. Keep them green as a regression check on the routes themselves (still `application/json`, still the RFC 9728 body, still no `error` key), and rest the reach claim on the registration order.

## Done when

The PR body states, in one short paragraph, that #1488 was read, that it is an accepted finding, and that no code changed for it — so the next reader of this branch does not re-open it, and adds the sentence that the ordering guard's behavioural half is Linux-only and therefore ran in CI rather than locally. `docs/security.md`'s accepted-findings entry is **not** edited (it was rewritten hours before this work; re-editing it is how a reconciliation date drifts). Note that #1822 item 3 **does** edit `docs/security.md:166`, which is a different subsection — that is the Privacy body-limit line, not the accepted-findings register, and the two must not be conflated.

## Not in scope

Any change to the two `/.well-known` handlers, their wildcard CORS header, or the "deliberately unguarded" comment above them. Re-fixing half 2. Editing `docs/security.md:495-505`.

## Review corrections (round 1)

**Adopted**

1. **The test citation attributed behavioural coverage to a source-text guard** (two findings). `:286-340` is the `readFileSync` describe whose specs are `(a)` and `(a2)`; the behavioural `401`-before-`403` cases live in a separate `describe.skipIf(process.platform !== "linux")` at `:379`. Both the citation and the "pins it behaviourally … not by string match" phrasing are corrected, and the Linux-only gate is now stated as this spec's cross-platform sentence and carried into the Done-when.
2. **"The Invariant 6 specs passing unchanged is the evidence" was non-evidence.** Those specs are bodiless GETs that never raise an error, so they cannot discriminate whether an error handler sits in front of the two routes. Replaced with the structural argument — registration on the outer `app` at `:737-758`, above the `app.use(mcpApp)` mount at `:761` — and the Invariant 6 specs are now described as a regression check on the routes rather than as proof of the reach claim.
3. **Route registration line range** corrected from `:736-760` to `:737-758`, and a line added noting that #1822 item 3 edits a *different* subsection of `docs/security.md` (`:166`, the Privacy body-limit line) so "do not edit `docs/security.md`" is not read as covering that PR-mate.

**Not adopted**

- Nothing. Both findings raised against this spec were adopted; no claim required refutation.
