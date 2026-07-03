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

### 1b. Via the issuance Worker (if you wire payments first)

If a beta tester goes through the checkout flow, add their email to the
issuance Worker's `GRANDFATHER_EMAILS` secret (comma/space-separated) **before**
they check out — see §3.5. The Worker lowercases + trims and issues
`type: "grandfathered"`, `expiresAt: null` automatically — no charge logic, just
the type/expiry branch. Re-`wrangler secret put GRANDFATHER_EMAILS` after
editing the list.

> A 100%-off coupon is the intended zero-cost path for listed testers. The
> Worker deliberately **ignores** a `$0` order from a *non*-listed email (a
> leaked coupon would otherwise mint unbounded free licenses), and whether a
> `$0` checkout fires `order.paid` at all is **still unverified** — confirm it
> in the Polar sandbox before relying on it, and keep §1a (manual signing) as
> the reliable fallback.

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
3. Set the manifest source `PUBLIC_LATEST_JSON_URL` — a plaintext `[vars]` entry in
   `wrangler.toml` (NOT a Worker *secret*; it's a public URL the Worker reads via
   `env.PUBLIC_LATEST_JSON_URL`) — then deploy:
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

## 3.5. The issuance endpoint (Cloudflare — owner-deployed)

The **issuance Worker** (`infra/license-issuance-worker/`) is the public seam
that turns a paid **Polar** checkout into a signed license. It supersedes the
loopback-only server handler `src/server/license/webhook.ts` (which Polar can
never reach). Like §3 it's owner-deployed; **you** own the Polar org, the
Worker, its KV namespaces, and its secrets.

### 3.5a. What it does

1. Verifies the **Standard-Webhooks (svix)** signature Polar sends
   (`webhook-signature` = HMAC-SHA256 over `${id}.${timestamp}.${body}`, key =
   base64-decoded `whsec_` secret) and rejects stale timestamps — before any
   side effect.
2. On **`order.paid`**: mints + signs a license (`personal` with a 1-year update
   window, or `grandfathered`/`expiresAt: null` for a listed email), writes the
   **ledger** (`LEDGER_KV`), writes the update **entitlement** (`LICENSE_KV` —
   the same namespace §3's update Worker reads), and emails the blob via Resend.
3. On **`order.refunded`**: deletes the update entitlement (the offline
   run-license stays perpetual by design) and marks the ledger refunded — gated
   on the payload's `refunded` field being **exactly** `true`; an explicit
   `false` is ignored, and a missing/non-boolean field is treated as
   `"dropped"` (see below), never as a silent revoke or a silent no-op.

> Polar's exact field name/shape for a refunded order is **still unverified**
> against a real sandbox payload (the same category of uncertainty as the
> `$0`-order amount fields in §1b) — confirm it before relying on refund
> revocation, and watch for `"dropped"` events during that window.

Idempotent across Polar retries (per-attempt freshness + a
`evt:<mode>:<webhook-id>` completion marker + the durable
`order:<mode>:<orderId>` ledger; a refund that outraces its paid event writes a
tombstone so the late paid retry can't resurrect a refunded order). PII lives
only in `LEDGER_KV`; `LICENSE_KV` is PII-free; the HTTP response never carries
the blob; logs are `{ result, ts }` plus a non-PII failure `stage` on errors.
**Alert on `"result":"dropped"`** — it means an event arrived whose payload
couldn't be fulfilled: either an `order.paid` with no usable email/order id
(possibly a paid sale with nothing issued), or an `order.refunded` whose
`refunded` field didn't read as a confirmed `true`/`false` (possibly a real
refund left live). The event is deliberately not marked done, so fixing the
cause and using Polar's manual re-send recovers it.

### 3.5b. Provision

```bash
cd infra/license-issuance-worker
npx wrangler kv namespace create LEDGER_KV        # new, issuance-only (PII)
# reuse the update Worker's LICENSE_KV id, or create one and use it for both
# edit wrangler.toml: paste both ids, set RESEND_FROM + TANDEM_ISSUANCE_ENV
npx wrangler secret put TANDEM_PRIVATE_KEY        # Ed25519 PEM PKCS#8 (§0)
npx wrangler secret put POLAR_WEBHOOK_SECRET      # whsec_... from Polar
npx wrangler secret put RESEND_API_KEY            # re_... from Resend
npx wrangler secret put GRANDFATHER_EMAILS        # optional (§1b)
npx wrangler deploy
```

Point the Polar webhook endpoint (subscribed to `order.paid` + `order.refunded`)
at the deployed URL. Deploy a **separate sandbox instance**
(`TANDEM_ISSUANCE_ENV=sandbox`, the sandbox Polar secret) to test end-to-end
without writing production entitlements — the sandbox needs no Polar KYC, so
this is unblocked before any LLC/payout setup.

### 3.5c. Recovery & monitoring

- The ledger record persists everything needed to **re-sign an identical blob**
  (no separate blob copy), so a failed email is recoverable: the Worker returns
  a retryable `500` and Polar's retry re-drives (re-asserts the entitlement,
  resends the email). Records with `emailSent: false` are the "who didn't get
  their license" worklist.
- Entitlement-write failure is likewise retryable (`500`), unlike §3b's
  fire-and-forget server write — the issuance Worker owns the KV binding
  directly, so it can afford to block-and-retry.
- Resend needs a **verified sending domain** with SPF, DKIM, and DMARC, or mail
  lands in spam.

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
| Deploy issuance Worker | `cd infra/license-issuance-worker && npx wrangler deploy` |
