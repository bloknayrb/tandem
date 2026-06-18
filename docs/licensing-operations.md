# Licensing Operations Runbook

> Operator guide for issuing Tandem licenses, grandfathering beta testers, and
> running the license-checked update endpoint. Audience: the project owner
> (Bryan). The on-device system is specified in
> [ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license)
> and `docs/superpowers/specs/2026-06-18-licensing-system-design.md`. The gate
> ships **dark** (`LICENSE_GATE_ENABLED = false` in `tsup.config.ts`) until v1.0.

## 0. Key management (do this once)

Licenses are Ed25519-signed offline. The **public** key is embedded in the app
(`src/server/license/public-key.ts`); the **private** key must never reach git.

```bash
npx tsx scripts/generate-keys.ts        # writes keys/tandem-private-key.pem (+ prints the public key)
```

- Paste the printed public key into `src/server/license/public-key.ts` before the first release.
- Store the private key in a password manager. For the webhook server, provide it
  as the `TANDEM_PRIVATE_KEY` env var (PEM contents). For local signing, the
  script reads `keys/tandem-private-key.pem` (gitignored).
- **Rotating the key invalidates every issued license.** Don't, post-launch.

## 1. Grandfathering beta testers (the main flow)

Grandfathered licenses are ordinary signed licenses with `type: "grandfathered"`
and `expiresAt: null` — they run forever **and** never lose the update window.
There is no separate on-device grandfather code path; a tester activates one
exactly like a paid license.

### 1a. Sign and deliver (manual, the reliable path)

For each beta tester:

```bash
npx tsx scripts/sign-license.ts \
  --name "Jane Doe" \
  --email "jane@example.com" \
  --type grandfathered
```

The script prints the metadata and a base64 **license key**. Email that key to
the tester (or save it as a `jane.license` text file and attach it). The tester
activates with either:

```bash
tandem activate <paste-the-license-key>
# or
tandem activate ./jane.license
```

…or, once the GUI ships, **Settings → License → Activate** (paste field). Confirm
with `tandem license` — it prints `Status: licensed`, the licensee, and the
update window even while enforcement still ships dark.

> **Privacy:** the local signing script prints the licensee email to *your*
> console (fine). Any **server/log** record of issuance must log the license
> **id** only, never the email (§12 L1). The webhook already does this.

### 1b. Via the issuance webhook (if you wire payments first)

If a beta tester goes through the checkout flow, add their email to
`GRANDFATHER_EMAILS` in `src/server/license/grandfather-list.ts` **before** they
check out. `handleLicenseWebhook` calls `isGrandfathered(email)` (lowercase +
trim) and issues `type: "grandfathered"`, `expiresAt: null` automatically — no
charge logic, just the type/expiry branch. Redeploy the webhook after editing
the list.

## 2. Issuing a paid license manually (fallback)

Same script, default type, with a one-year update window:

```bash
npx tsx scripts/sign-license.ts --name "Buyer" --email "buyer@example.com" --type personal --expires 365
```

`personal`/`commercial` licenses run the current version forever; `--expires`
sets only the **update window** (`expiresAt`). After it lapses the app keeps
running; it simply stops being offered new updates until renewal.

## 3. The L3 update endpoint (Cloudflare — owner-deployed)

Architecture (PII-free) is in spec §7. The repo ships the Worker source
(`infra/license-update-worker/`), `wrangler.toml`, the webhook KV-write
(`src/server/license/kv-store.ts`), and the Rust updater wiring. **You** own the
Cloudflare account, KV namespace, custom domain, and secrets.

### 3a. Provision

1. Create a Cloudflare KV namespace; note its **namespace id** and your **account id**.
2. Create an API token scoped to *Workers KV Storage: Edit* for that namespace.
3. Set the Worker secret `LATEST_JSON` (or the configured manifest source) and deploy:
   ```bash
   cd infra/license-update-worker && npx wrangler deploy
   ```

### 3b. Wire the webhook → KV

On the webhook server, set:

```
TANDEM_CF_ACCOUNT_ID=<account id>
TANDEM_CF_KV_NAMESPACE_ID=<namespace id>
TANDEM_CF_KV_API_TOKEN=<scoped token>
```

After a **real** purchase (`!isTestPurchase`) the webhook writes
`KV[licenseId] = { updateWindowEnd, status, version }` (fire-and-forget,
non-fatal). If these vars are unset the write is skipped and the updater simply
uses the public GitHub endpoint — no error.

> Grandfathered entitlements store `updateWindowEnd: null` ⇒ the Worker treats
> them as always-current.

> **Monitor the write — it's customer-impacting when it fails.** The write is
> deliberately non-fatal (the signed license blob is the source of truth and is
> always delivered; a blocking KV call in the webhook hot path could trip the
> processor's retry → a duplicate license). But a *configured-but-failing* write
> means a paying customer's `licenseId` never lands in KV, so the Worker returns
> a byte-identical no-update forever and they silently stop receiving updates
> while running fine. The only signal is a webhook-server stderr line:
> `[license] KV entitlement write failed (HTTP <code>) for license <id>` (or
> `... skipped (KV not configured)`). **Alert on `KV entitlement write failed`.**
> To recover, re-derive KV from your issued-license records: for each affected
> `licenseId`, re-`PUT KV[licenseId] = { updateWindowEnd, status, version }`
> (same shape the webhook writes) via the Cloudflare KV REST API or `wrangler kv
> key put`. The id is the join key, so a missed write is always repairable from
> the order/license log without re-issuing the license.

### 3c. Behavior

- Updater asks `GET /api/license/status` (loopback). If `gateActive && licenseId && updateWindowCurrent`, it points at the Worker with an `X-Tandem-License-Id` header; otherwise it uses the public GitHub `latest.json`.
- The Worker returns a **byte-identical no-update** response for unknown ids and expired windows (no existence oracle) and logs only `{ result, ts }` — never the id.

## 4. The v1.0 flag flip (enabling enforcement)

1. Confirm the commercial-readiness exit criterion (ADR-040 / roadmap).
2. Flip `const LICENSE_GATE_ENABLED = false` → `true` in `tsup.config.ts`.
3. Rebuild and release. On first launch of a gate-active build, each user starts
   a clean **14-day trial** (`trial.json` is only written when the gate is on, so
   prior dark installs don't pre-burn the clock).
4. Grandfathered/paid testers who already ran `tandem activate` are `licensed`
   immediately — no trial, no wall.

## 5. Quick reference

| Task | Command |
|---|---|
| Generate keypair | `npx tsx scripts/generate-keys.ts` |
| Sign grandfathered license | `npx tsx scripts/sign-license.ts --name N --email E --type grandfathered` |
| Sign paid license (1y updates) | `npx tsx scripts/sign-license.ts --name N --email E --type personal --expires 365` |
| Activate (tester) | `tandem activate <key-or-path>` |
| Check status (tester) | `tandem license` |
| Deploy update Worker | `cd infra/license-update-worker && npx wrangler deploy` |
