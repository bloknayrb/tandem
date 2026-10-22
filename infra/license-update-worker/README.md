# Tandem license-update Worker (L3)

License-checked auto-update endpoint. Gates access to the signed release manifest
on a valid, in-window license id. Part of the licensing system (#1116; licensing design spec §7, `docs/superpowers/specs/2026-06-18-licensing-system-design.md`).

- **Source:** `src/worker.ts` (pure `handleUpdateRequest` + default `fetch` export).
- **Tests:** `tests/server/license-update-worker.test.ts` (mock KV + mock fetch — no Cloudflare runtime needed). Run with the normal `npm test`.
- **Deploy:** owner-only. See [`docs/licensing-operations.md`](../../docs/licensing-operations.md) §3.

## How it works

1. The desktop app picks a route (`update_route` in `src-tauri/src/lib.rs`), in this order:
   1. `LICENSE_UPDATE_ENDPOINT` is empty → the public GitHub manifest, with no probe. **This is the shipped state: the licensed path is not armed yet (#1785).**
   2. Its probe of the sidecar's `GET /api/license/status` is unreachable or non-2xx → no manifest at all (`status-unavailable`).
   3. The sidecar reports the gate dark → the public manifest.
   4. A license id is present → this Worker, with an `X-Tandem-License-Id` header — whatever the device's own copy of the update window says. The Worker's KV is the authority, so an ended window is refused here, not on the device.
   5. The status is `restricted` → no manifest (`no-entitlement`).
   6. Anything else (a trial device) → the public manifest.

   [`docs/licensing-operations.md`](../../docs/licensing-operations.md) §3c and §8 describe the same routing.
2. The Worker looks the id up in the `LICENSE_KV` namespace (written by the issuance Worker on a real purchase, or out of band by `scripts/sign-license.ts`).
3. Entitled + inside the update window → it proxies `PUBLIC_LATEST_JSON_URL` (the signed manifest; the minisign signature is unchanged and still verified by the Tauri client `pubkey`). Otherwise → **HTTP 204**, byte-identical for every refusal reason — `no-header`, `unknown-id`, `unparseable`, `expired`, `revoked` and `upstream` — so the response is no existence oracle.

It logs `{ result, reason, ts }` — never the license id. `[observability]` in `wrangler.toml` retains those lines, and `sendOperatorAlert` POSTs to `ALERT_WEBHOOK_URL` on `unknown-id` and `unparseable` (#1786). Both are inert until the Worker is redeployed with the webhook set. Alerting is described in [`docs/licensing-operations.md`](../../docs/licensing-operations.md) §5c and §8.

## Deploy

```bash
npx wrangler@4.130.0 kv namespace create LICENSE_KV   # paste the id into wrangler.toml
# edit wrangler.toml: PUBLIC_LATEST_JSON_URL → your release manifest
npx wrangler@4.130.0 deploy
```

The version is pinned deliberately, and **the reason here is not the issuance
Worker's**: this Worker is a single `src/worker.ts` with no multi-file import
graph, so it does not carry that Worker's `./crypto.js` → `crypto.ts` extension
rewrite. What applies here is the other half — the bundle shape is wrangler's,
so two deploys of identical source can differ across wrangler versions, and the
two Workers are pinned together so a deploy pair is reproducible. Do not read
the absence of a `crypto.ts` here as evidence the pin was copy-pasted in error.
To advance it,
re-run `npm view wrangler version` and update **all six** deploy sites together —
`docs/licensing-operations.md` §3, §3.5b and both §9 quick-reference rows, plus the
two Worker READMEs.

The OUT-OF-BAND writer — `scripts/sign-license.ts`, via
`src/server/license/kv-store.ts` — needs `TANDEM_CF_ACCOUNT_ID`,
`TANDEM_CF_KV_NAMESPACE_ID`, and a `TANDEM_CF_KV_API_TOKEN` (scoped *Workers KV
Storage: Edit*) to populate the namespace. The issuance Worker does not: it holds
its own `LICENSE_KV` binding and never touches those vars.

## Related

- [Security and licensing map](../../docs/maps/security-and-licensing.md) — where this Worker sits among the licence and security docs.
- [Licensing operations](../../docs/licensing-operations.md) — the owner's runbook for provisioning, deploying and monitoring it ([§3](../../docs/licensing-operations.md#3-the-l3-update-endpoint-cloudflare--owner-deployed)).
- [How Tandem licensing works](../../docs/licensing-explained.md#updates-and-the-endpoint-that-must-not-lie) — why this endpoint must never answer wrongly, and what the app does with a 204.
- [The issuance Worker](../license-issuance-worker/README.md) — the sibling Worker that writes the entitlements this one reads.
