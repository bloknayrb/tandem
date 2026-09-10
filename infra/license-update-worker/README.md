# Tandem license-update Worker (L3)

License-checked auto-update endpoint. Gates access to the signed release manifest
on a valid, in-window license id. Part of the licensing system (#1116, ADR-040 §7).

- **Source:** `src/worker.ts` (pure `handleUpdateRequest` + default `fetch` export).
- **Tests:** `tests/server/license-update-worker.test.ts` (mock KV + mock fetch — no Cloudflare runtime needed). Run with the normal `npm test`.
- **Deploy:** owner-only. See [`docs/licensing-operations.md`](../../docs/licensing-operations.md) §3.

## How it works

1. The Tauri updater (loopback) checks `GET /api/license/status`. If `gateActive && licenseId && updateWindowCurrent`, it points `updater_builder` at this Worker with an `X-Tandem-License-Id` header; otherwise it uses the public GitHub manifest.
2. The Worker looks the id up in the `LICENSE_KV` namespace (written by the issuance webhook on a real purchase).
3. Entitled + inside the update window → it proxies `PUBLIC_LATEST_JSON_URL` (the signed manifest; the minisign signature is unchanged and still verified by the Tauri client `pubkey`). Otherwise → **HTTP 204**, byte-identical for unknown ids and expired windows (no existence oracle).

It logs `{ result, reason, ts }` — never the license id.

## Deploy

```bash
npx wrangler kv namespace create LICENSE_KV   # paste the id into wrangler.toml
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
