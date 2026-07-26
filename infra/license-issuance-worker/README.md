# Tandem license-issuance Worker

The public seam that turns a paid **Polar** checkout into an Ed25519-signed
license: verify the webhook, mint + sign the license, record it, email it. Part
of the licensing system (#1116, ADR-040).

This **replaced** the loopback-only server handler `src/server/license/webhook.ts`
(which Polar could never reach, and whose `verifyPolarSignature` used a wrong
`t=,v1=` scheme). That handler and its `/webhooks/license` route are now deleted
— issuance lives here and nowhere else. Do not re-add a payment-processor
endpoint to a server that binds to loopback.

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
`evt:<mode>:<webhook-id>` completion marker (blocks replays of processed
events), and the durable `order:<mode>:<orderId>` ledger (blocks re-mint; a
retry of a *failed* delivery re-drives — re-asserts the entitlement and resends
the email). A refund that outraces its paid event writes a **tombstone** so the
late paid retry can't mint a live entitlement for a refunded order. An order
event with no usable email/orderId is logged as `dropped` (the alert-worthy
result) and deliberately NOT marked done, so a manual Polar re-send after a fix
reprocesses it. `issue()` and `revoke()` each re-read the ledger a second time
immediately before their first commit, narrowing (not eliminating) the window
for a same-orderId race against a concurrent delivery — see "Known limitation"
below.

**Privacy:** PII (email/name) lives ONLY in `LEDGER_KV`; `LICENSE_KV` is
PII-free. The HTTP response never contains the license blob (it would leak into
Polar's delivery logs) — it reaches the buyer by email alone. Logs carry
`{ result, ts }` plus a non-PII failure `stage` (and upstream email HTTP status)
on errors — never an email or license id.

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

## Known limitation: concurrent-delivery races (tracked, not yet closed)

Workers KV has no compare-and-swap. `issue()` and `revoke()` each re-read the
`order:<mode>:<orderId>` ledger record immediately before their first commit,
so a same-orderId write from a genuinely concurrent request (another
`order.paid` delivery, or an `order.refunded` racing it) is detected and
deferred to instead of blindly overwritten — this narrows the window from the
whole request (including the async Ed25519 sign) down to one KV round trip.
It does **not** make the pair atomic: two requests that are truly simultaneous
through both reads can still both commit — a double-mint (two valid licenses
for one order), or a refund that fails to revoke an entitlement minted just
after its recheck. Cloudflare KV's eventual consistency (propagation lag
across edge locations) means this isn't only a contrived race — an ordinary
Polar retry landing on a different PoP can trigger it.

**Operational mitigation until this is closed:** after refunding a
higher-value order, verify with `npx wrangler kv key get "order:live:<orderId>"
--namespace-id <LEDGER_KV id>` that `refunded: true` and that `LICENSE_KV` no
longer has a live entry for that order's `licenseId`.

**Proper fix (follow-up, not built here):** a Cloudflare Durable Object keyed
on `orderId`, using `blockConcurrencyWhile` (or a single serialized queue) to
make the read-then-write in `issue()`/`revoke()` atomic per order. Out of
scope for this PR — it's a new binding + wrangler config + migration, not a
same-shape change to the existing pure-handler design.

## Not yet built (follow-ups)

- The Durable-Object-based fix for the concurrent-delivery race above.
- A rate-limited **"resend my license"** endpoint (needs an email index +
  rate-limit store).
- Confirming Polar's exact webhook-endpoint auto-disable threshold (~10
  consecutive failures) and whether it notifies the account on disable. This is
  the dominant sale-loss mode: `sendEmail` failing returns a retryable 500, so a
  single misconfiguration (e.g. an unverified `RESEND_FROM` → 422) can retry its
  way to a disabled endpoint, after which **every subsequent sale never
  arrives** and produces no ledger record at all. See
  `docs/licensing-operations.md` §5 for the reconcile that detects it.
