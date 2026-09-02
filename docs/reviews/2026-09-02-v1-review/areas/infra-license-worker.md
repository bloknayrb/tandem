# Area: Cloudflare license workers (`infra/`)

**Raw:** [`../raw/findings-infra-license-worker.txt`](../raw/findings-infra-license-worker.txt) (Opus fresh run,
34 calls; ran the 78 worker tests under `tests/server`, all pass);
[`../raw/gapfill-C.txt`](../raw/gapfill-C.txt) (Sonnet, updater contract facts).
**Manifest:** [`../raw/manifests/infra-license-worker.md`](../raw/manifests/infra-license-worker.md).
**Track:** [H the flip](../tracks/H-the-flip.md); Lows in [K](../tracks/K-tests-and-lows.md).
**Spot-check:** the four Mediums read by the orchestrator (`sed`, `grep`).

The workers are deployed by hand (`wrangler deploy`) and are outside `tsconfig` and `biome`; the
only typecheck they get is through the `tests/server` imports. The operations doc is
`docs/licensing-operations.md`; its §8 is the pre-launch checklist the gate items below refer to.

## Findings

| Sev | Where | Finding | Evidence | Status | Issue |
|---|---|---|---|---|---|
| M | `src-tauri/src/lib.rs:2248-2252`; `tauri.conf.json:107-109` | Refines #1785: the un-entitled branch's `app.updater()` falls back to the **public** `latest.json`, so an out-of-window buyer still updates *after* the endpoint const is filled. Separate fix; no §8 line covers it; ADR-040 §3/§6 contradicted. | [read] | Source-confirmed | [#1785](https://github.com/bloknayrb/tandem/issues/1785) |
| M | `infra/*/wrangler.toml` | No `[observability]` block in either worker; the `reason` enum is `console.log` only, retained nowhere but `wrangler tail`; the update worker has no `ALERT_*` wiring at all. | [read] | Source-confirmed (grep) | [#1786](https://github.com/bloknayrb/tandem/issues/1786) |
| M | `infra/license-issuance-worker/src/worker.ts:752` vs `:992-999`; `wrangler.toml:22` | `RESEND_FROM` placeholder `REPLACE_WITH_VERIFIED_SENDER` is presence-checked only, *after* mint, entitlement and ledger; `SUPPORT_EMAIL` gets a pre-mint guard. Result: license minted, email 422, 500 forever, Polar endpoint auto-disable (the README names this as the dominant sale-loss mode). | [read] | Source-confirmed | [#1793](https://github.com/bloknayrb/tandem/issues/1793) |
| M | `worker.ts:453-488,594-596` | `revoke()` reads the order id from `data.id`; if Polar's `order.refunded` payload `data` is a refund object (id at `data.order_id`), a junk tombstone is written, "revoked" returned and the event marked done, so the live entitlement survives the refund and the re-send short-circuits. Payload shape unverified: needs a sandbox fixture (§8). | [read] | Source-confirmed (Med confidence) | [#1793](https://github.com/bloknayrb/tandem/issues/1793) |
| L | `worker.ts:944`; `biome.json:19-28`; worker dirs | `isAlertable` = dropped or stage "email", so config-stage 503s are silent and drive auto-disable; `infra/` unlinted and untyped; the revoke re-check is two adjacent KV reads; no wiring test pins `X-Tandem-License-Id` across `lib.rs:2241` / `worker.ts:64`; `wrangler deploy` unpinned (compat date 2024-09-23, `./crypto.js` relies on an esbuild rewrite). | [read] | Source-confirmed | [#1825](https://github.com/bloknayrb/tandem/issues/1825) |

## Leads not run

- Ed25519 on real Cloudflare at compat date 2024-09-23: if unsupported, every webhook fails closed
  with 503. A §8 gate item.
- Real Polar payload shapes (the refund question above). A §8 gate item.
- Closed by the Sonnet follow-up: `tauri-plugin-updater` `check()` returns `Ok(None)` on 204 (the
  no-update contract holds); `endpoints()` rejects non-https in release builds unless the dangerous
  flag is set (an `http://` endpoint would error and be swallowed on the auto path; Low in #1825).
  Both from the v2 branch via a web summary, not a pinned tag.

## Doc drift (in [#1821](https://github.com/bloknayrb/tandem/issues/1821))

Update-worker README:26-27 (webhook needs a CF KV API token) vs `kv-store.ts:6-11`; issuance
README:87-88 `wrangler kv key get` missing `--remote` (the ops doc says it is not optional; a
local miss reads as "refund did not revoke"); update README:16 "logs only {result, ts}" vs
`worker.ts:93`; the issuance deploy block omits `SUPPORT_EMAIL`.

## Verified fine (78/78 tests)

Canonicalization parity char-for-char with a round-trip through `crypto.verify`; suites live
under `tests/server` so `check` gates them; the header literal matches; the KV placeholder is
identical in both tomls; no-update byte-identity across all five reasons including a thrown
upstream; the license id is never in a URL or log; the manifest is re-served unchanged (no
downgrade, minisign signatures intact); PII segregation; svix verification correct and before
parse; grandfathered null end to end; refund-before-paid tombstone; the §9 quick reference all
exists; the §7 support runbook is usable.
