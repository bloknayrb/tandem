# Track K — Tests, gates and the Low batches

**Tier:** Sonnet builds, Opus reviews. **Decisions needed:** none. **Can start now.** **Do not
hold the next minor for it.** Two test Highs first (they are what make other tracks' green
trustworthy), then the batches, one PR per batch section so each stays reviewable.

## Issues

| Issue | What |
|---|---|
| [#1783](https://github.com/bloknayrb/tandem/issues/1783) | Give `mcp-tool-integration.test.ts:307-318` its assertions; un-skip or delete the two permanently skipped E2E specs; one E2E that drives `tandem_checkInbox` end to end (user annotates → Claude polls); a Solo HOLD E2E on the pull path; a runner for `tests/hooks/test_workflow_state.sh`. |
| [#1784](https://github.com/bloknayrb/tandem/issues/1784) | `license-gate-coverage.test.ts` derives `registered` from every `server.tool(` call (the `tool-count-drift` derivation), not from the wrappers; `coverage-gate-wiring.test.ts` checks a real import or a symbol, not `includes(stem)`. |
| [#1822](https://github.com/bloknayrb/tandem/issues/1822) | Security Lows: strip control characters from channel-error logs; `maxPayload` on Hocuspocus; a JSON error handler for the SDK app; supervisor cwd confinement and an allowlisted env; `NODE_ENV=production` at sidecar spawn; 404 for dotfile-shaped static paths; `status: "inactive"` while dark. |
| [#1823](https://github.com/bloknayrb/tandem/issues/1823) | Server Lows: the range items go to [track B](B-anchors.md) if it is in flight, otherwise here; one wire code per condition with a table test; `tandem_open` requires an absolute path; the runtime and file-io hygiene items. |
| [#1824](https://github.com/bloknayrb/tandem/issues/1824) | Client Lows: those not taken by [track G](G-client-editor.md); the paste-sanitiser regression test; the browser-reserved shortcut copy. |
| [#1825](https://github.com/bloknayrb/tandem/issues/1825) | CI, Tauri, tests and infra Lows: those not taken by [track I](I-supply-chain.md) or [E](E-desktop-lifecycle.md); the four zero-assertion specs; the orphan fixtures; the remove-seam alias guard; `perf:gate` runner or removal. |

Area ledgers: [tests](../areas/tests.md), [security](../areas/security.md), and the last rows of
every other ledger.

## Scanners

`experiments/scan-zero-assert.mjs`, `scan-subject-mock.mjs`, `scan-stale-mock.mjs` and
`find_no_expect.py` walk `tests/` and print candidates. They found the vacuous tests; they will
also find any a fix adds. Consider promoting `scan-zero-assert.mjs` to `scripts/ci/` with a wiring
test, per ADR-051, once its false-positive list is empty.

## Rules that bite here

- `tests/` is typechecked only by `typecheck:tests`, whose three configs include whole directories;
  never add a `*.test.ts` glob.
- A `v8 ignore` comment shrinks the coverage denominator; the sweep in `coverage-gate.mjs` is what
  catches it. Do not add one to clear a floor.
- Never skip, disable or quarantine a test to get green; a permanently skipped spec is what #1783
  is about.
- Windows-gated specs run only in `windows-acl-proof`; a new real-`icacls` spec must join its list
  or it is green forever.
- E2E on the reserved ports only; `reuseExistingServer: false` stays.
- Adding to `NON_LOOPBACK_ALLOWED` is a security change; #1822's channel-error fix must not.

## Reviewer agents

`security-reviewer` on #1822 and on the `license-gate-coverage` rewrite (#1784 decides what
"gated" means for CI).

## Done when

- `scan-zero-assert.mjs` and `find_no_expect.py` print nothing.
- A bare `server.tool("tandem_zzz", …)` added in a scratch branch turns `license-gate-coverage`
  red.
- An E2E spec calls `tandem_checkInbox` and asserts the user's annotation arrives; another asserts
  it does not arrive in Solo.
- Each batch issue has one linked PR per section and is closed.

## Status

_(empty)_
