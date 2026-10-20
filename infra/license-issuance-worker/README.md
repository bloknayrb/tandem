# Tandem license-issuance Worker

The public seam that turns a completed **Paddle Billing** transaction into an
Ed25519-signed license: verify the webhook, look the buyer up, mint + sign the
license, record it, email it. Part of the licensing system (#1116, ADR-040).
Paddle replaced Polar as merchant of record on 2026-10-17 (ADR-040 §6).

This **replaced** the loopback-only server handler `src/server/license/webhook.ts`
(which no merchant could ever reach). That handler and its `/webhooks/license`
route are now deleted — issuance lives here and nowhere else. Do not re-add a
payment-processor endpoint to a server that binds to loopback.

- **Source:** `src/worker.ts` (pure `handleIssuance` + default `fetch` and
  `scheduled` exports), `src/crypto.ts` (canonicalize parity + `Paddle-Signature`
  verify + Ed25519 signing).
- **Tests:** `tests/server/license-issuance-worker.test.ts` — mock KV + mock
  mailer + mock Paddle API + a real generated Ed25519 key; runs under the normal
  `npm test`, no Cloudflare runtime needed. Includes a signature vector built the
  way `@paddle/paddle-node-sdk` 3.10.0 computes it, canonicalize parity with the
  real on-device verifier, and the sign→verify round-trip. **Nothing here has
  run against a real Paddle account yet**: every payload is hand-built from
  Paddle's documentation (no captured sandbox fixtures yet), and the twelve unverified facts (U1–U12) are listed in
  `docs/licensing-operations.md` §8.

## How it works

1. Paddle `POST`s a signed event. The Worker verifies `Paddle-Signature`
   (`ts=<unix>;h1=<hex>`, HMAC-SHA256 over `${ts}:${rawBody}` keyed with the
   destination's `pdl_ntfset_…` secret, any matching `h1` accepted, at most 8)
   and rejects a `ts` more than 300 s off — **before** any parse or side effect.
   A bad signature is a `401` and is never alerted (anyone can send one).
2. On **`transaction.completed`** it checks the transaction (`txn_…`, status
   `completed`), re-drives an order already in the ledger, parses the totals,
   requires every item's price to be in `PADDLE_PRICE_IDS` (an out-of-scope paid
   transaction is dropped; an out-of-scope free one is ignored, with no record
   or alert), looks the buyer up with
   `GET /customers/{customer_id}` (the webhook carries no email), and mints a
   license: `personal`, or, for a grandfather-listed email, `grandfathered`.
   Both carry `expiresAt: null`: every key includes all future updates (ADR-040,
   decision A5, 2026-10-09). It signs the canonical metadata (byte-compatible
   with `verifier.ts`), writes a `txnlic:` index entry and the issuance
   **ledger** record, writes the update **entitlement** (`LICENSE_KV`, the same
   namespace the update Worker reads), and emails the blob via Resend. One
   transaction mints one license, whatever the quantity.
3. On **`adjustment.created` / `adjustment.updated`** it applies a first-match
   table (`docs/licensing-operations.md` §3.5a): an approved full refund, full
   credit or chargeback first marks the ledger record refunded (so a racing
   redelivery declines to re-drive), then revokes the update entitlement of
   every license the transaction minted (the offline run-license is perpetual
   by design); pending, rejected and warning adjustments are
   `settled`; partial refunds and credits, and every reversal, are `noticed`
   for a human.
4. On **`api_key.expiring` / `api_key.expired`** it leaves a notice: replace
   the API key.
5. Once a day (`[triggers] crons`) it asks the Paddle API for failed or
   retrying notifications and inactive destinations, and alerts on any, or when
   Paddle reports no destination at all.

**Idempotency (three layers):** per-attempt timestamp freshness, an
`evt:<mode>:<event_id>` completion marker (blocks replays of processed events;
never the per-attempt `notification_id`), and the durable
`order:<mode>:<txn_id>` ledger (blocks re-mint; a retry of a *failed* delivery
re-drives — re-asserts the entitlement and resends the email). A full refund
that outraces its purchase writes a **tombstone** so the late purchase can't mint
a live entitlement for a refunded order.

**Durable notices:** every `dropped` event (signed, but unusable: schema drift,
a foreign price, a missing customer, …) and every `noticed` one writes a
`notice:<mode>:<stage>:<ref>` record to `LEDGER_KV` (ids only, no PII) before
answering 200. A `dropped` event is deliberately NOT marked done, so replaying it
from Paddle after a fix reprocesses it. The alert is best-effort; the record is
what the operator lists and clears (`docs/licensing-operations.md` §5b).
`issue()` and `revoke()` each re-read the ledger a second time immediately
before their first commit, narrowing (not eliminating) the window for a
same-transaction race against a concurrent delivery — see "Known limitation"
below.

**Privacy:** PII (email/name) lives ONLY in `LEDGER_KV`; `LICENSE_KV` is
PII-free. The HTTP response never contains the license blob (it would leak into
Paddle's notification logs) — it reaches the buyer by email alone. Logs carry
`{ result, ts }` plus a non-PII failure `stage` (and upstream HTTP status) or a
`notice`/`ref` id, never an email or license id; alerts carry no ids at all. The
`PADDLE_API_KEY` can read **every** Paddle customer's email and name, not only
the ones the ledger holds, so keep its scopes to `customer.read` plus
notification read (`docs/security.md`).

## Deploy

```bash
# One entitlement namespace (shared with the update Worker) + one ledger namespace
npx wrangler@4.130.0 kv namespace create LICENSE_KV   # or reuse the update Worker's id
npx wrangler@4.130.0 kv namespace create LEDGER_KV
# edit wrangler.toml: paste both ids, set RESEND_FROM, SUPPORT_EMAIL,
#   PADDLE_PRICE_IDS and TANDEM_ISSUANCE_ENV. All four guarded vars are ENFORCED:
#   the Worker 503s every webhook while one is unset, a placeholder or malformed.
npx wrangler@4.130.0 secret put TANDEM_PRIVATE_KEY     # Ed25519 PEM PKCS#8
npx wrangler@4.130.0 secret put PADDLE_WEBHOOK_SECRET  # pdl_ntfset_... from the notification destination
npx wrangler@4.130.0 secret put PADDLE_API_KEY         # pdl_live_apikey_..., customer.read + notification read ONLY
npx wrangler@4.130.0 secret put RESEND_API_KEY         # re_...
npx wrangler@4.130.0 secret put GRANDFATHER_EMAILS     # optional, comma/space-separated
npx wrangler@4.130.0 deploy
```

`wrangler.toml` also declares the daily cron (`[triggers] crons`) for the
delivery check; deploying it is what schedules it. Delete any leftover
`POLAR_WEBHOOK_SECRET` from a Worker deployed before the switch
(`npx wrangler@4.130.0 secret delete POLAR_WEBHOOK_SECRET`).

**`PADDLE_API_KEY` expires** (one year at most, no renewal): put a reminder in
your calendar two weeks before, and subscribe the destination to
`api_key.expiring` / `api_key.expired`. An expired key makes every sale fail at
stage `paddle-api-auth`.

**Deploy preconditions for the live Worker:** the U1 sandbox test in
`docs/licensing-operations.md` §8 has passed (retries and replays must carry a
fresh `ts`, or a failed sale can never be recovered), and the Terms
(`https://tandem.ink/terms`) and Refund Policy (`https://tandem.ink/refunds`)
are live, because the license email links both. Neither page is live yet.

The version is pinned deliberately: `./crypto.js` resolving to `crypto.ts` is the
bundler rewriting the extension, and the bundle shape is wrangler's too, so two
deploys of identical source can differ across wrangler versions. To advance it,
re-run `npm view wrangler version` and update **all six** deploy sites together —
`docs/licensing-operations.md` §3, §3.5b and both §9 quick-reference rows, plus the
two Worker READMEs.

Point the Paddle notification destination (events `transaction.completed`,
`adjustment.created`, `adjustment.updated`, `api_key.expiring`,
`api_key.expired`; traffic source `platform` on live) at the deployed URL.

**Sandbox.** Paddle's sandbox is a separate account with its own destination,
secret and `pdl_sdbx_` API key. Its Worker is the `[env.sandbox]` block at the
end of `wrangler.toml` (deployed as `tandem-license-issuance-sandbox`), which
re-declares its own vars and its own KV namespaces, since Wrangler does not
inherit those into an environment. Two vars are required there with a
`pdl_sdbx_` key: `SANDBOX_BUYER_EMAILS` (it mints only for these buyers and
ignores everyone else; empty → 503 `config-sandbox-buyers`) and
`SANDBOX_SIGNING_UNTIL` (a full ISO timestamp with a zone, at most 7 days ahead;
503 `config-sandbox-until` otherwise). It signs with the production key, so each
listed buyer's sandbox checkout mints a real license until that date. **Every**
sandbox command takes `--env sandbox`; a bare command targets production:

```bash
npx wrangler@4.130.0 kv namespace create LEDGER_KV --env sandbox   # and LICENSE_KV
npx wrangler@4.130.0 deploy --env sandbox
npx wrangler@4.130.0 secret put PADDLE_WEBHOOK_SECRET --env sandbox
npx wrangler@4.130.0 secret put PADDLE_API_KEY --env sandbox
npx wrangler@4.130.0 secret put TANDEM_PRIVATE_KEY --env sandbox
npx wrangler@4.130.0 secret put RESEND_API_KEY --env sandbox
```

A `pdl_live_` key in a Worker whose `TANDEM_ISSUANCE_ENV` is not `production` is
refused. Once the end-to-end check is done, delete the sandbox Worker:
`npx wrangler@4.130.0 delete --env sandbox`. Deleting only its signing key
stops the minting but leaves its daily cron alerting once its API key expires
(`docs/licensing-operations.md` §3.5b).

## Known limitation: concurrent-delivery races (tracked, not yet closed)

Workers KV has no compare-and-swap. `issue()` and `revoke()` each re-read the
`order:<mode>:<txn_id>` ledger record immediately before their first commit,
so a same-transaction write from a genuinely concurrent request (another
`transaction.completed` delivery, or an `adjustment.*` racing it) is detected
and deferred to instead of blindly overwritten — this narrows the window from
the whole request (including the Paddle API lookup and the async Ed25519 sign)
down to one KV round trip. It does **not** make the pair atomic: two requests
that are truly simultaneous through both reads can still both commit — a
double-mint (two valid licenses for one transaction), or a refund that fails to
revoke an entitlement minted just after its recheck. Cloudflare KV's eventual
consistency (propagation lag across edge locations) means this isn't only a
contrived race: a slow first request plus Paddle's retry 5 s later can trigger
it, and the buyer lookup makes a slow first request likelier.

**A double mint is now revocable.** Every mint writes
`txnlic:<mode>:<txn_id>:<licenseId>` before the ledger, and a refund tombstones
every licenseId it lists plus the ledger's own. Two residuals, accepted:

- KV `list()` is eventually consistent (about 60 s), so a full refund landing
  within a minute of a double mint can miss the second licenseId. The
  reconcile in `docs/licensing-operations.md` §5b lists the index later and
  catches it.
- A double mint sends the buyer two emails. Harmless to them.

A second route has no recheck at all: `reDrive()` re-asserts the live
entitlement from a ledger record read at the start of the request, so a
redelivered `transaction.completed` that overlaps a refund can write the live
entitlement back over the refund's tombstone, and when the order's `emailSent`
is still false it also rewrites the ledger with `refunded: false`.

**Since every key includes all future updates (2026-10-09, ADR-040 decision
A5), a live entitlement that survives a refund this way never runs out.**
Before, it carried a one-year window and expired with it. The check below is now
the only backstop, so it matters more than it did.

**Operational mitigation until this is closed:** after a refund, verify with
`npx wrangler@4.130.0 kv key get "order:live:<txn_id>" --remote --namespace-id
<LEDGER_KV id>` that `refunded: true`, list the transaction's licenses with
`npx wrangler@4.130.0 kv key list --prefix "txnlic:live:<txn_id>:" --remote
--namespace-id <LEDGER_KV id>`, then read each entitlement with
`npx wrangler@4.130.0 kv key get "<licenseId>" --remote --namespace-id <LICENSE_KV id>`.

**Read the value, not its presence.** Revocation writes a TOMBSTONE rather than
deleting the key (a deletion is indistinguishable from an eviction or a failed
write, and the update Worker pages on that), so a successful revocation and the
failure this check exists to catch both return a value:

- pass — the tombstone, exactly `{"updateWindowEnd":null,"status":"revoked"}`.
  Both shapes carry a null window, so read `status`, never the window;
- fail — a live entitlement, `{"updateWindowEnd":null,"status":"personal",…}`,
  i.e. a mint that landed after the refund's recheck. Re-run the §7
  revoke-by-hand procedure.

`expectRevoked()` / `expectLive()` in `tests/server/license-issuance-worker.test.ts`
assert the same two shapes.

**Proper fix (follow-up, not built here):** a Cloudflare Durable Object keyed
on the transaction id, using `blockConcurrencyWhile` (or a single serialized
queue) to make the read-then-write in `issue()`/`revoke()` atomic per
transaction. Out of scope for this PR — it's a new binding + wrangler config +
migration, not a same-shape change to the existing pure-handler design. It would
also retire the `txnlic:` listing residual above.

## Not yet built (follow-ups)

- The Durable-Object-based fix for the concurrent-delivery race above, which
  also closes the KV-list residual.
- A rate-limited **"resend my license"** endpoint (needs an email index +
  rate-limit store).
- A sandbox run against a real Paddle account, settling U1–U12
  (`docs/licensing-operations.md` §8). U1 is a hard gate before a live deploy.
- Recording which discount code a transaction used, if Paddle's transaction
  turns out to carry `discount_id` (U10).
