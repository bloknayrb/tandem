# Tandem license-issuance Worker

The public seam that turns a paid **Polar** checkout into an Ed25519-signed
license: verify the webhook, mint + sign the license, record it, email it. Part
of the licensing system (#1116, ADR-040).

This **supersedes** the loopback-only server handler `src/server/license/webhook.ts`
(which Polar can never reach, and whose `verifyPolarSignature` used a wrong
`t=,v1=` scheme). Stripping that server handler from the shipped bundle is a
separate follow-up.

- **Source:** `src/worker.ts` (pure `handleIssuance` + default `fetch` export),
  `src/crypto.ts` (canonicalize parity + svix verify + Ed25519 signing).
- **Tests:** `tests/server/license-issuance-worker.test.ts` — mock KV + mock
  mailer + a real generated Ed25519 key; runs under the normal `npm test`, no
  Cloudflare runtime needed. Includes the svix golden vector, canonicalize
  parity with the real on-device verifier, and the sign→verify round-trip.

## How it works

1. Polar `POST`s a **Standard-Webhooks (svix)** signed event. The Worker
   verifies `webhook-signature` (HMAC-SHA256 over `${id}.${timestamp}.${body}`,
   key = base64-decoded `whsec_` secret) and rejects stale timestamps — **before**
   any parse or side effect.
2. On **`order.paid`** it mints a license: `personal` (1-year update window) or,
   for a grandfather-listed email, `grandfathered` (`expiresAt: null`). It signs
   the canonical metadata (byte-compatible with `verifier.ts`), writes the
   issuance **ledger** record, writes the update **entitlement** (`LICENSE_KV`,
   the same namespace the update Worker reads), and emails the blob via Resend.
3. On **`order.refunded`** it revokes the update entitlement (the offline
   run-license is perpetual by design) and marks the ledger record refunded.

**Idempotency (three layers):** per-attempt timestamp freshness, a
`evt:<webhook-id>` completion marker (blocks replays of processed events), and
the durable `order:<mode>:<orderId>` ledger (blocks re-mint; a retry of a
*failed* delivery re-drives — re-asserts the entitlement and resends the email).

**Privacy:** PII (email/name) lives ONLY in `LEDGER_KV`; `LICENSE_KV` is
PII-free. The HTTP response never contains the license blob (it would leak into
Polar's delivery logs) — it reaches the buyer by email alone. Logs carry
`{ result, ts }` only.

## Deploy

```bash
# One entitlement namespace (shared with the update Worker) + one ledger namespace
npx wrangler kv namespace create LICENSE_KV   # or reuse the update Worker's id
npx wrangler kv namespace create LEDGER_KV
# edit wrangler.toml: paste both ids, set RESEND_FROM + TANDEM_ISSUANCE_ENV
npx wrangler secret put TANDEM_PRIVATE_KEY    # Ed25519 PEM PKCS#8
npx wrangler secret put POLAR_WEBHOOK_SECRET  # whsec_...
npx wrangler secret put RESEND_API_KEY        # re_...
npx wrangler secret put GRANDFATHER_EMAILS    # optional, comma/space-separated
npx wrangler deploy
```

Point the Polar webhook endpoint at the deployed URL. Deploy a **separate**
sandbox instance (`TANDEM_ISSUANCE_ENV=sandbox`, sandbox Polar secret) to test
without writing production entitlements.

## Not yet built (follow-ups)

- A rate-limited **"resend my license"** endpoint (needs an email index +
  rate-limit store).
- Stripping the superseded server `webhook.ts` from the shipped bundle.
