# Licensing Operations Runbook

> Operator guide for issuing Tandem licenses, grandfathering beta testers, and
> running the license-checked update endpoint. Audience: the project owner
> (Bryan). The decision is
> [ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license);
> the current on-device system is described in
> [licensing-explained.md](licensing-explained.md).
> `docs/superpowers/specs/2026-06-18-licensing-system-design.md` is the historical
> design: its §4 still describes the per-tool and per-route gates (Surface A and
> Surface B) that #1521 deleted, so read it for rationale, not for what ships. The gate
> ships **dark** (`LICENSE_GATE_ENABLED = false` in `tsup.config.ts`) until v1.0.

## Vocabulary (use these words consistently)

Three identifiers get confused constantly. Fix the words and most support
threads get shorter.

| Term | What it is | Who sees it |
|---|---|---|
| **License key** | The base64 signed blob. The credential. | The customer. This is what "paste your license key" means. |
| **Order number** | Paddle's transaction id, `txn_…`. The ledger key is `order:<mode>:<txn_id>`. | **The only identifier to ask a customer for.** You can look it up in Paddle and in the ledger. Which id Paddle's receipt email actually shows the buyer (the `txn_…` id or an invoice number) is **unverified (U6, §8)**; if it is the invoice number, find the transaction from it in the Paddle dashboard. |
| **License id** | `metadata.id`, a UUID. The KV join key. | Operator only. Never ask a customer for it — a customer with a broken license often can't read it, and a refunded one has no KV entry to look up. |

Other Paddle ids you will meet, none of which a customer should be asked for:
`ctm_…` (a customer, which the Worker looks up for the buyer's email and name),
`adj_…` (an adjustment: a refund, credit or chargeback), `pri_…` (a price; the
Worker mints only for the ones in `PADDLE_PRICE_IDS`) and `evt_…` (a webhook
event, the Worker's dedupe key; each delivery attempt also has its own
`notification_id`, which the Worker ignores).

## 0. Key management (the ceremony — do this once, and it freezes more than the key)

Licenses are Ed25519-signed offline. The **public** key is embedded in the app
(`src/server/license/public-key.ts`); the **private** key must never reach git.

Three decisions become irreversible the moment the first license is signed,
because changing any of them afterwards means re-issuing every customer or
supporting two schemas in `verifyLicenseSignature` forever. Decide them
explicitly, now:

1. **Key-leak recovery.** *Decided 2026-10-15: built.* Every license now
   carries a `keyId`, and the app trusts a list of public keys
   (`TRUSTED_PUBLIC_KEYS`), so the signing key can be replaced without dropping
   anyone whose key is still trusted. The id is the key's own fingerprint,
   derived by the signer, so it cannot disagree with the key that signed. A
   license with no `keyId` is checked against `LEGACY_KEY_ID`, today's original
   key. See "Rotating the signing key" below.
2. **What PII goes in the signed bytes.** `LicenseMetadata` embeds `name` and
   `email`, so both land on disk and in any support thread where the key is
   pasted. `email` identifies whose key it is if one turns up in a support
   thread or is posted publicly; there is no per-buyer rule (decided
   2026-10-15);
   **`name` buys display text only, and is the field most likely to be a real
   legal name.** Decide whether `name` belongs there at all.
3. **Missing fields.** `version` is not stored in the ledger (so a future
   `LICENSE_VERSION` change would make a re-signed blob diverge from the one the
   buyer holds), and the signed metadata carries no `orderId` — the ledger
   record has one, the blob the buyer holds does not.

Then:

```bash
npx tsx scripts/generate-keys.ts        # writes keys/tandem-<keyId>.pem + .pub.pem (+ prints the public key and its id)
```

It never overwrites: each run is a new key beside the old one.

- Add the printed public key to `TRUSTED_PUBLIC_KEYS` in
  `src/server/license/public-key.ts`, its id to `TRUSTED_KEY_IDS` in
  `infra/license-issuance-worker/src/worker.ts`, and its id and fingerprint to
  `EXPECTED_KEYS` in `tests/server/license.test.ts`, all in the **same commit**.
  CI pins the shipped keys, so a swap by bad merge or stray paste fails the build
  instead of surfacing when customers' licenses stop verifying, and a parity test
  fails if the Worker's list and the app's list differ. If the ceremony replaces
  the original key outright (nothing was ever issued with it), remove that key
  and point `LEGACY_KEY_ID` at the new one in the same commit.
- Give the issuance Worker the private key with
  `npx wrangler@4.130.0 secret put TANDEM_PRIVATE_KEY`.
- **`wrangler secret put` is write-only. It is NOT a backup** — you cannot read
  a secret back out. Keep **two independent offline copies in different physical
  locations**. A single password-manager entry is doing 100% of the work, and
  losing it means you can never sign another license against the key every
  shipped binary trusts.
- For out-of-band signing, `scripts/sign-license.ts --key <path>` reads the
  private key (default `keys/tandem-private-key.pem`, the original key's path;
  `keys/` is gitignored). It stamps the key's id and refuses a key that is not
  in `TRUSTED_PUBLIC_KEYS`.
- **The issuance Worker refuses to sign with a key not in `TRUSTED_KEY_IDS`**:
  every webhook answers 503 at stage `config` until the secret matches a listed
  key. After setting or changing the secret, issue one sandbox order
  (`TANDEM_ISSUANCE_ENV=sandbox`, `wrangler dev` or a sandbox deploy) and check
  that the emailed key's `keyId` is the one you expect and that it activates.
  That run is also the only check that the Workers runtime derives the same id
  as the app; CI checks Node only.

- **Before the ceremony, confirm nothing was ever issued with the current dev
  key.** `/api/license/activate` works regardless of the gate flag by design, so
  a tester may already hold one. Note the list may be genuinely *unknowable*:
  Tandem has no telemetry, analytics, or signup — which is also why §1c exists.
  Anyone holding a pre-rotation license now sees an explicit "installed but
  could not be verified" message rather than "your trial ended".

### Rotating the signing key

The order matters, because a license from a key a build does not trust fails
verification on that build.

1. Generate the new key (above) and, in **one commit**, add it to
   `TRUSTED_PUBLIC_KEYS`, `TRUSTED_KEY_IDS` and `EXPECTED_KEYS`. Listing it
   early is harmless: the Worker signs only with whatever its secret holds.
2. Release that build and deploy the Worker. Wait until most installs have
   updated: a buyer on an older build who receives a new-key license is told it
   "may need to be reissued", and the real fix for them is to update.
3. Switch the **production** Worker's secret to the new key. To check it
   before a buyer does, put the same key on a sandbox Worker for the length of
   one sandbox order (`--env sandbox`, with `SANDBOX_SIGNING_UNTIL` and your own
   address in `SANDBOX_BUYER_EMAILS`), run the check above, then delete that
   Worker again (§3.5b). Production itself shows a bad key only as 503
   `config`, alerted, on the next webhook.
4. **After a leak, also retire the old key**: remove it from all three lists in
   one release. Every license it signed (and any keyless license, if it is the
   `LEGACY_KEY_ID` key) stops verifying, which is the point: those can no longer
   be told apart from forgeries. Reissue them under the new key; a resend from
   the Worker re-signs under the current key automatically.

## 1. Grandfathering beta testers (the main flow)

Grandfathered licenses are ordinary signed licenses with `type: "grandfathered"`
and `expiresAt: null` — they run forever **and** never lose the update window.
Since 2026-10-09 paid keys carry the same null window (every key includes all
future updates, ADR-040 decision A5), so the two types differ only in `type`.
There is no separate on-device grandfather code path; a tester activates one
exactly like a paid license.

### 1a. Sign and deliver (manual, the reliable path)

> **The script writes a Cloudflare KV entitlement, and needs credentials to do
> it.** Export `TANDEM_CF_ACCOUNT_ID`, `TANDEM_CF_KV_NAMESPACE_ID` (the update
> Worker's `LICENSE_KV`) and `TANDEM_CF_KV_API_TOKEN` first. Without them the
> script prints the key and then **exits non-zero** — deliberately. A license
> with no entitlement is served `204` by the update Worker, which the app
> reports to the user as "You're up to date", forever, while starved. Do not
> deliver a key the script refused to entitle; re-run it once KV is configured.
> (`--skip-entitlement` exists for offline testing and nothing else.)

For each beta tester:

```bash
npx tsx scripts/sign-license.ts \
  --name "Jane Doe" \
  --email "jane@example.com" \
  --type grandfathered
```

The script prints the metadata and a base64 **license key**. Email that key to
the tester (or save it as a `jane.license` text file and attach it). The tester
activates in **Settings → License** (paste the key) — on the desktop app that is
the only route. On an npm install they can instead run:

```bash
tandem activate <paste-the-license-key>
# or
tandem activate ./jane.license
```

A separately installed CLI writes its own app-data directory, so running
`tandem activate` to license a desktop app succeeds and changes nothing the
desktop can see (see [licensing-explained.md](licensing-explained.md)). On an npm
install, confirm with `tandem license` — it prints `Status: licensed`, the licensee, and
`Updates: all future updates included` (a hand-signed `--expires` key shows its
window instead) even while enforcement still ships dark.

> **Privacy:** the local signing script prints the licensee email to *your*
> console (fine). Any **server/log** record of issuance must log the license
> **id** only, never the email (spec §12 L1, `docs/superpowers/specs/2026-06-18-licensing-system-design.md`). The issuance Worker already does this.

> **Ledger caveat.** A script-issued license has no `LEDGER_KV` record, so it is
> invisible to reconcile (§5) and to any future resend endpoint. **It is still
> THE grandfather path today:** the coupon route in §1b depends on whether a $0
> Paddle checkout fires `transaction.completed` at all, which is unverified
> (U2, §8). Once U2 is settled in the sandbox, the coupon route is preferable for
> the cohort because it goes through `issue()` and is ledgered, entitled and
> idempotent. Keep §1a regardless for the cases it uniquely solves: a buyer
> whose mail provider quarantined the automated email (re-sending through the
> same pipe cannot fix that), a buyer whose reversed chargeback or adjustment
> was tombstoned before their license was ever issued (§7), and any license you
> need to mint before payments exist.

### 1b. Via the issuance Worker (if you wire payments first)

If a beta tester goes through the checkout flow, add their email to the
issuance Worker's `GRANDFATHER_EMAILS` secret (comma/space-separated) **before**
they check out — see §3.5. The Worker lowercases + trims and issues
`type: "grandfathered"`, `expiresAt: null` automatically — no charge logic, just
the type/expiry branch. Re-`wrangler secret put GRANDFATHER_EMAILS` after
editing the list.

> A 100%-off discount code is the intended zero-cost path for listed testers.
> The Worker deliberately **ignores** a `$0` transaction from a *non*-listed
> email (a leaked code would otherwise mint unbounded free licenses), and when
> `GRANDFATHER_EMAILS` is empty it ignores every `$0` transaction before calling
> the Paddle API at all, so a leaked code cannot drive API traffic either.
> "Free" means both `details.totals.grand_total` and `details.totals.total` parse
> as integers ≤ 0; if either fails to parse the event is `dropped`, never
> treated as paid. Whether a `$0` checkout fires `transaction.completed` at all
> is **still unverified (U2, §8)** — confirm it in the Paddle sandbox before
> creating the 100% code, and keep §1a (manual signing) as the grandfather path
> until then.

**Discount codes in Paddle (the student code, and any 100% code).** Two
properties of Paddle discounts matter here:

- **`usage_limit` is an overall cap across all customers, not a per-customer
  one**, and concurrent checkouts can exceed it. Never rely on it to make a code
  single-use; for a 100% code, `GRANDFATHER_EMAILS` is the actual control.
- **The student discount** is $25 off the $45 price, as a code restricted
  (`restrict_to`) to the Tandem price. Students email the support inbox from a
  school address and are sent the code: honour system plus a school email, and
  nothing more. The Worker needs no logic for it: a $20 transaction is a paid
  transaction. Whether the transaction carries a `discount_id` is unverified
  (U10), so the ledger does not record which code was used.

### 1c. The cohort problem (settle this before the flip)

`README.md` publicly promises beta users a free grandfathered license that skips
the trial once they activate it. **There is no list, and no way to build one** — no telemetry, no
analytics, no signup. Both grandfather mechanisms (§1a and §1b) need the email
*in advance*, so every beta user has to contact you first.

The flip choreography also actively misleads them if left alone:

- **Pre-flip**, Settings → License shows the license status pill. It now reads
  "Not enforced in this version" with an explicit prompt to activate anyway —
  it previously read "No license required", which tells someone holding a free
  beta license that it's unnecessary, so they archive it and lose it.
- **Post-flip**, the trial banner says "N of 14 days left… Buy a license" — which
  reads as "you need to pay" to someone who was promised otherwise.

Before flipping, decide and do:

1. ~~A **claim path** that works without a list.~~ **Done:** README.md's
   "Claiming the beta license" paragraph asks beta users to email support with
   roughly when they first installed, then activate in Settings → License as soon
   as the key arrives.
2. **Banner and wall copy naming the beta offer**, so a grandfathered user
   doesn't read the countdown as a bill. Still open: `LicenseBanner.svelte` names
   no beta offer.
3. Whether the README promise survives "we cannot identify beta users." Largely
   answered by the same README paragraph, which says plainly that only people who
   get in touch can be grandfathered.

## 2. Issuing a paid license manually (fallback)

Same script, default type. No update window is the **default** for every type,
because every key includes all future updates (ADR-040, decision A5, 2026-10-09);
it was one year until then:

```bash
npx tsx scripts/sign-license.ts --name "Buyer" --email "buyer@example.com"
```

Every license runs forever. `--expires <days>` sets an **update window**
(`expiresAt`) and is now only for a test or a deliberate exception: nothing sells
a windowed key, and there is no renewal product (decision B6), so a buyer whose
window lapsed would have no way to extend it. After a window lapses the app
keeps running; it simply stops being offered new updates.

> **Omitting `--expires` now means `null` on purpose.** It used to *silently*
> mean `never` while the intended default was a year — that was D1. What made D1
> leave a license permanently un-updatable was the missing KV entitlement, not
> the null window, and the script now writes the entitlement and exits non-zero
> if it can't.

Same KV requirement as §1a: the script writes the update entitlement and exits
non-zero if it can't. Don't deliver a key it refused to entitle.

## 3. The L3 update endpoint (Cloudflare — owner-deployed)

Architecture (PII-free) is in spec §7. The repo ships the Worker source
(`infra/license-update-worker/`), `wrangler.toml`, the out-of-band KV entitlement writer used by
`scripts/sign-license.ts` (`src/server/license/kv-store.ts`; the paid path writes
KV inside the issuance Worker, §3.5), and the Rust updater wiring. **You** own the
Cloudflare account, KV namespace, custom domain, and secrets.

### 3a. Provision

1. Create a Cloudflare KV namespace; note its **namespace id** and your **account id**.
2. Create an API token scoped to *Workers KV Storage: Edit* for that namespace.
3. Set the manifest source `PUBLIC_LATEST_JSON_URL` — a plaintext `[vars]` entry in
   `wrangler.toml` (NOT a Worker *secret*; it's a public URL the Worker reads via
   `env.PUBLIC_LATEST_JSON_URL`) — then deploy:
   ```bash
   cd infra/license-update-worker && npx wrangler@4.130.0 deploy
   ```

   The wrangler version is pinned deliberately: `./crypto.js` resolving to
   `crypto.ts` is the bundler rewriting the extension, and the bundle shape is
   wrangler's too, so two deploys of identical source can differ across wrangler
   versions. To advance it, re-run `npm view wrangler version` and update **all
   six** deploy sites together — §3 and §3.5b here, both §9 quick-reference rows,
   and the two Worker READMEs.
4. **Put a custom domain in front of it, and use that in `lib.rs`.** The
   endpoint URL is compiled into every shipped desktop binary
   (`LICENSE_UPDATE_ENDPOINT`, `src-tauri/src/lib.rs`). Ship `*.workers.dev` and
   every install is permanently pinned to one Cloudflare account name; if that
   host ever dies, those installs report "You're up to date" forever and the
   only fix is an update they can no longer be offered. It's one DNS record now
   versus a bootstrap deadlock later.
5. **Workers Paid ($5/mo) is a prerequisite, not an optimization.** Logpush and
   Workers Logs both require it, and the free KV tier caps writes at
   **1,000/day** (~5 writes per order) — a breach cascades straight into the
   failed-delivery path in §5. Total infra is ~$6/mo at any volume in range;
   Paddle's cut (5% + 50¢ per transaction, about $2.75 on a $45 sale) is far
   larger at any real volume. Do not optimize Cloudflare.

> **The two `wrangler.toml` files must carry the SAME `LICENSE_KV` id.** They
> use an identical placeholder name so a mismatch is visible on inspection —
> because it is invisible in behaviour: issuance succeeds, the buyer gets a
> working license, and the updater silently reports "up to date" forever.

### 3b. Entitlement writers

Two paths write `KV[licenseId] = { updateWindowEnd, status, version }`:

- **The paid path** — the issuance Worker (§3.5), using its own KV binding.
  Failure there is a retryable `500`, so Paddle re-delivers (live: up to 60
  retries over about 3 days; sandbox: 3 retries in 15 minutes; then the
  notification is marked `failed` and can be replayed by hand, §5b).
- **The out-of-band path** — `scripts/sign-license.ts` via
  `src/server/license/kv-store.ts`, over the KV REST API, using the
  `TANDEM_CF_*` env vars (§1a). Failure there exits non-zero.

> Every issued entitlement, paid or grandfathered, stores `updateWindowEnd: null`
> (decision A5) ⇒ the Worker treats it as always-current. A refund is told apart
> by `status: "revoked"`, which the Worker checks before the window.

> **A missing entitlement is the worst failure mode in this system, because it
> looks exactly like health.** An earlier version of this runbook said a skipped
> write meant "the updater simply uses the public GitHub endpoint — no error."
> **That is false, and it is the mental model that produced the bug.**
> `build_updater()` calls `.endpoints(vec![endpoint])`, which **replaces** the
> endpoint list — the public manifest is not a fallback. So the sequence is:
> no KV entry → Worker returns `204` → `tauri-plugin-updater` early-returns
> `Ok(None)` → `check_for_update` shows the user **"You're up to date."**
> Permanently. While starved.
>
> **That last step is conditional since #1819, and the condition deliberately
> does NOT rescue this case.** The `Ok(None)` arm now splits on
> `local_window_ended` — `UpdateRoute::Licensed` AND the sidecar probe not
> reporting `update_window_current` — and the ended arm shows an "Update Window
> Ended" warning instead. That is **this device's own copy of the license
> talking, not the Worker's verdict**, so it fires exactly when the local
> `expiresAt` has passed. A device whose local window is still open takes the
> up-to-date arm no matter what KV holds, which is precisely the scenario above:
> a missing entitlement against a still-current local license is still told
> "You're up to date." The new dialog covers the opposite mismatch (local
> window ended, entitlement possibly extended KV-side by hand, since no renewal
> product exists), and the Worker's `reason`
> remains the only detector for this one.
>
> The same dead state is reachable at least five ways: a failed write, a
> refund, the revocation procedure in §7, KV eviction, and a namespace-id
> mismatch between the two `wrangler.toml` files. **The first of those five is
> now distinguishable from the rest**: a refund and a §7 revocation write a
> `{"updateWindowEnd": null, "status": "revoked"}` TOMBSTONE rather than
> deleting the key, so the Worker answers `revoked` — deliberately not alerted
> on, because it is your own action. A key that is simply *gone* is the one
> that means something broke.
>
> **Detection.** The update Worker logs `{ result: "no-update", reason, ts }`,
> `[observability]` retains those lines, and `unknown-id` / `unparseable` POST
> an alert to `ALERT_WEBHOOK_URL` (throttled per reason, gated on a UUID-shaped
> id because the endpoint is unauthenticated). A log line nobody retains and
> nobody is notified about was never a detector — that is what #1786 fixed.
> Both halves are merged but **inert until both Workers are redeployed** with
> `[observability]` and `ALERT_WEBHOOK_URL` set (§8).
> **Repair:** re-`PUT KV[licenseId]` from the ledger record — `entitlementValue`
> is fully derivable, so nothing needs re-issuing. If the customer still has
> their key, that works too: the blob carries id/name/email/type/createdAt/
> expiresAt/version/keyId, i.e. everything a ledger record holds (and the
> signing key's id, which the ledger does not).

### 3c. Behavior

- The desktop app picks a route (`update_route` in `src-tauri/src/lib.rs`), in this order: (1) an empty `LICENSE_UPDATE_ENDPOINT` → the public GitHub `latest.json`, with no probe — the shipped state until the flip (#1785); (2) the loopback `GET /api/license/status` probe unreachable or non-2xx → no manifest at all (`status-unavailable`); (3) the sidecar reports the gate dark → public; (4) a license id present → the Worker with an `X-Tandem-License-Id` header, **whatever the local update window says** — an ended local window still routes to the Worker, which refuses it there, because KV is the authority; (5) `restricted` → no manifest (`no-entitlement`); (6) anything else, i.e. a trial device → public. §8 has the dialogs each arm produces.
- The Worker returns a **byte-identical no-update** response (HTTP 204) for all six refusal reasons — `no-header`, `unknown-id`, `unparseable`, `expired`, `revoked` (the refund/revocation tombstone) and `upstream` — so it is no existence oracle, and logs `{ result, reason, ts }` — the reason is a coarse enum about the *service's* state, never the license id.
- **The automatic detector is the alert on `unknown-id`/`unparseable`**; `[observability]` on both Workers is what retains the lines behind it; and the `revoked` tombstone is what keeps your own refunds and revocations out of the alert. Both halves are merged but **inert until the Workers are redeployed** with `[observability]` and `ALERT_WEBHOOK_URL` set (§8).

## 3.5. The issuance endpoint (Cloudflare — owner-deployed)

The **issuance Worker** (`infra/license-issuance-worker/`) is the public seam
that turns a completed **Paddle Billing** transaction into a signed license.
Paddle is the merchant of record (chosen 2026-10-17, replacing Polar; ADR-040
§6). The Worker **replaced** the loopback-only server handler
`src/server/license/webhook.ts`, which no merchant could reach and which is now
deleted — issuance happens here and nowhere else, apart from the operator's own
`scripts/sign-license.ts` (§1a/§2). Like §3 it's owner-deployed; **you** own the
Paddle accounts (live and sandbox are separate accounts), the Worker, its KV
namespaces, and its secrets.

> **Nothing below has run against a real Paddle account yet.** The Worker is
> built from Paddle's documentation and tested against hand-built payloads; twelve
> facts are unverified until a sandbox run (U1–U12, §8), and U1 is a hard gate
> before any live deploy.

### 3.5a. What it does

1. **Verifies `Paddle-Signature`** before any parse or side effect. The header
   is `ts=<unix seconds>;h1=<hex>`; the Worker computes HMAC-SHA256 over
   `${ts}:${rawBody}` keyed with the destination's secret string (`pdl_ntfset_…`,
   used as-is, not base64-decoded: inferred from Paddle's SDK, and settled only
   by the first real sandbox delivery), and accepts if any `h1` matches (Paddle may
   send several during a secret rotation; more than 8 is refused). Exactly one
   integer `ts` is required, and it must be within 300 s of the Worker's clock in
   either direction. A missing header is a `400`; a bad or stale signature is a
   `401` and **never alerts**, because anyone can send one (§5c).
2. **Routes by `event_type`:**

   | Event | What the Worker does |
   |---|---|
   | `transaction.completed` | `issue()`: mint, or re-drive an existing order (below) |
   | `adjustment.created`, `adjustment.updated` | `revoke()`: the first-match table below |
   | `api_key.expiring`, `api_key.expired` | `noticed` (`api-key-expiry`): replace the API key (§8) |
   | anything else | `ignored`, marked done |

3. **On `transaction.completed`**, in this order:
   1. The transaction id (`data.id`) must be `txn_…` and `data.status` must be
      `completed`; otherwise `dropped`.
   2. **Ledger read.** If `order:<mode>:<txn_id>` already exists, the event is a
      redelivery: re-assert the entitlement and resend a stuck email from the
      stored record, with no price check and no Paddle API call (so a resend
      still works for a price later removed by the kill switch, §7). A
      refunded record is never resurrected.
   3. **Totals.** `details.totals.grand_total` and `.total` must parse as integer
      minor-unit strings, or the event is `dropped` (never treated as paid).
      `balance` is never read: it is 0 on every completed transaction.
   4. **Price scope.** `data.items` must be non-empty and every
      `items[].price.id` must be in `PADDLE_PRICE_IDS`. A Paddle.js checkout
      accepts the public client token plus *any* active price id, so without
      this a leftover test price would mint perpetual licenses. An out-of-scope
      **paid** transaction is `dropped` (record and alert); an out-of-scope
      **free** one is `ignored`, with no record and no alert, because nobody
      paid and a record plus alert per free checkout would let anyone holding
      the client token drain the Resend quota that delivers licenses.
      **One transaction mints one license, whatever the quantity**, so set the
      checkout quantity to 1 in Paddle.
   5. `customer_id` must be `ctm_…` (a null one is `dropped`).
   6. A free transaction (§1b) with `GRANDFATHER_EMAILS` empty is `ignored` here,
      before any API call.
   7. **Buyer lookup.** Paddle's webhook carries no email, so the Worker calls
      `GET /customers/{customer_id}` with `PADDLE_API_KEY` (host from the key
      prefix: `pdl_live_` → `api.paddle.com`, `pdl_sdbx_` →
      `sandbox-api.paddle.com`) and reads `data.email` / `data.name`. A null name
      becomes "Valued Customer"; whether checkout fills the name at all is
      unverified (U4). Outcomes:

      | Paddle API answer | Result |
      |---|---|
      | 200, usable email | continue |
      | 200, unusable email | `dropped` |
      | 404, or any other 4xx except 401/403/408/429 | `dropped` |
      | 401 / 403 | `500` stage `paddle-api-auth` (key expired or lacks `customer.read`; every sale fails until it is replaced) |
      | 408, 429, 5xx, 1xx/3xx, network error, unparseable 200 | `500` stage `paddle-api` (Paddle retries) |

   8. On a sandbox Worker (a `pdl_sdbx_` key), a buyer whose email is not in
      `SANDBOX_BUYER_EMAILS` is `ignored` (§3.5b).
   9. A free transaction from an email not in `GRANDFATHER_EMAILS` is `ignored`.
   10. Mint and sign (`personal`, or `grandfathered` for a listed email; both
      `expiresAt: null`, all future updates included), re-check the ledger, write
      the `txnlic:<mode>:<txn_id>:<licenseId>` index entry, write the **ledger**
      (`LEDGER_KV`), write the update **entitlement** (`LICENSE_KV`, the same
      namespace §3's update Worker reads), and email the blob via Resend.

4. **On `adjustment.created` / `adjustment.updated`** (refunds, credits,
   chargebacks), evaluated in this order, first match wins:
   1. `action`, `status` or `type` missing or outside Paddle's documented values
      → `dropped`. Then the transaction id (`data.transaction_id`) must be
      `txn_…`, else `dropped`.
   2. `status` `pending_approval` or `rejected` → `settled` (nothing to do).
   3. `status` `reversed` → `noticed` `adjustment-reversed`, whatever the
      action. A won dispute never re-revokes; you restore by hand (§7).
   4. Any status other than `approved` → `dropped`.
   5. With `status: approved`:

      | `action` | `type` | Outcome |
      |---|---|---|
      | `refund` | `full` | revoke → `revoked` |
      | `refund` | `partial` | `noticed` `refund-partial`: the buyer **keeps** the license. If partials add up to a full refund, revoke by hand (§7). (Bryan, 2026-10-18.) |
      | `credit` | `full` | revoke (a full credit is a refund in effect) |
      | `credit` | `partial` | `noticed` `credit-partial` |
      | `chargeback` | `full` or `partial` | revoke |
      | `chargeback_warning`, `chargeback_warning_reverse` | any | `settled` |
      | `chargeback_reverse` | any | `noticed` `chargeback-reverse`: restore by hand (§7) |
      | `credit_reverse` | any | `noticed` `credit-reverse`: restore by hand if it was revoked (§7) |

   **Revoke** first sets the ledger record's `refunded: true`, then overwrites
   the update entitlement of the ledger's license **and of every license in the
   transaction's `txnlic:` index** with the `revoked` tombstone,
   `{updateWindowEnd: null, status: "revoked"}`. The flag goes first so that a
   redelivered purchase racing the refund sees it and declines to re-drive, and
   so that a retry after a failed entitlement write revokes again. **A refund
   does not revoke the key itself**: the offline run-license keeps working by
   design (ADR-040 §4, and the Terms draft says so); what stops is the updater
   offering that key new versions. A full refund that arrives before the
   purchase writes a tombstone ledger record, so the late purchase cannot mint.
   A notice writes only its `notice:` record, never an `order:` record. Whether Paddle
   sends an auto-created chargeback as `approved` is unverified (U3); if it sends
   anything undocumented, step 4 drops it and alerts, which is the safe side.

**Result kinds.** `issued`, `duplicate` (a redelivery, or an event already
marked done), `revoked`, `settled` and `noticed` reply `200` and mark the event
done (`evt:<mode>:<event_id>`, 4-day TTL; an `event_id` outside Paddle's
documented shape is keyed by the `body_…` digest instead). `ignored` replies `200`; it is marked
done for an unknown event type but **not** for a transaction `issue()` ignores
(a free one, or a sandbox buyer not on the list). `dropped`
replies `200` and is deliberately **not** marked, so a replay after you fix the
cause is processed again. `error` replies `500` (Paddle retries) with a
non-PII `stage`; `rejected` is a `400`/`401`/`405`.

**Every `noticed` and every `dropped` leaves a durable record** before the 200
reply: `notice:<mode>:<stage>:<ref>` in `LEDGER_KV`, holding
`{stage, txnId?, eventType, at}` and no PII, with no TTL. The ref is the
adjustment, transaction, event or API-key id (`adj_…`, `txn_…`, `evt_…`,
`apikey_…`); for an unparseable body with no usable `event_id` it is
`body_<16 hex>`, a digest a replay reproduces. If that write fails the Worker
replies `500` (stage `notice-write`, alerted) and Paddle retries; the write is
idempotent. Paddle will not retry a 200, and the alert is best-effort, so **the
record is the guarantee**: §5b says how to list, act on and clear them.

Idempotent across Paddle retries in three layers: per-attempt timestamp
freshness, the `evt:<mode>:<event_id>` completion marker (keyed on `event_id`,
or its body digest when the id is malformed, never on the per-attempt
`notification_id`), and the durable
`order:<mode>:<txn_id>` ledger. PII lives only in `LEDGER_KV`; `LICENSE_KV` is
PII-free; the HTTP response never carries the blob; logs are `{ result, ts }`
plus a non-PII `stage`/`status` or `notice`/`ref`, never an email or license id.

### 3.5b. Provision

```bash
cd infra/license-issuance-worker
npx wrangler@4.130.0 kv namespace create LEDGER_KV        # new, issuance-only (PII)
# reuse the update Worker's LICENSE_KV id, or create one and use it for both
# edit wrangler.toml: paste both ids, set RESEND_FROM, SUPPORT_EMAIL,
#   PADDLE_PRICE_IDS and TANDEM_ISSUANCE_ENV
npx wrangler@4.130.0 secret put TANDEM_PRIVATE_KEY        # Ed25519 PEM PKCS#8 (§0)
npx wrangler@4.130.0 secret put PADDLE_WEBHOOK_SECRET     # pdl_ntfset_... from the Paddle notification destination
npx wrangler@4.130.0 secret put PADDLE_API_KEY            # pdl_live_apikey_... (scopes below)
npx wrangler@4.130.0 secret put RESEND_API_KEY            # re_... from Resend
npx wrangler@4.130.0 secret put GRANDFATHER_EMAILS        # optional (§1b)
npx wrangler@4.130.0 deploy
```

**Delete any leftover `POLAR_WEBHOOK_SECRET`** from a Worker deployed before the
switch: `npx wrangler@4.130.0 secret delete POLAR_WEBHOOK_SECRET` (with
`--env sandbox` for the sandbox instance). Nothing reads it now.

**Secrets and vars this Worker needs from Paddle:**

| Name | Kind | What, and what happens when it is wrong |
|---|---|---|
| `PADDLE_WEBHOOK_SECRET` | secret | The notification destination's secret key (`pdl_ntfset_…`). Missing → `503` stage `config`. Wrong → every delivery `401`s, **silently** (no alert, by design); Paddle retries into `failed` and the daily delivery check (below) is what tells you. |
| `PADDLE_API_KEY` | secret | `pdl_live_apikey_…` (live) or `pdl_sdbx_apikey_…` (sandbox). Give it **`customer.read` plus read access to notifications and notification settings, and nothing else** (the exact scope names for the last two are to confirm in Paddle's API-key screen; the Worker calls `GET /notifications` and `GET /notification-settings`). Missing, legacy-format or unrecognised → `503` stage `config-paddle-api-key`. Expired or lacking `customer.read` → each sale `500`s at stage `paddle-api-auth` (alerted). **Paddle API keys expire** (90 days by default, one year at most, and cannot be renewed): create it with the one-year maximum and put a reminder in your calendar two weeks before it expires. Paddle also sends `api_key.expiring` seven days before, which the Worker turns into a notice and an alert, if you subscribed to it. |
| `PADDLE_PRICE_IDS` | var | **Required.** Comma-separated `pri_…` ids this Worker may mint for (empty entries from a stray comma are ignored). Empty or any malformed entry → `503` stage `config-price-ids`. |
| `SANDBOX_SIGNING_UNTIL` | var | **Required on any Worker holding a `pdl_sdbx_` key**, ignored otherwise. A full ISO timestamp with a zone, e.g. `2026-10-24T00:00:00Z`, no more than 7 days ahead. A date-only value is refused. Missing, unparseable, past or too far ahead → `503` stage `config-sandbox-until`. |
| `SANDBOX_BUYER_EMAILS` | var | **Required on any Worker holding a `pdl_sdbx_` key**, ignored otherwise. Comma/space-separated buyer emails (your own test addresses). The sandbox Worker mints only for these buyers; any other buyer's transaction is `ignored`, with no record and no alert. Empty → `503` stage `config-sandbox-buyers`. |

**The environment guard.** `TANDEM_ISSUANCE_ENV` defaults to `production`. A
`pdl_live_` key in a Worker whose env is anything else is refused (`503`
`config-env-mismatch`): a live key never runs in a test-mode Worker. A
`pdl_sdbx_` key is allowed with either env, but only because it must also carry
`SANDBOX_SIGNING_UNTIL` and `SANDBOX_BUYER_EMAILS`. The reason: a sandbox Worker
signs with the production key (below), and a Paddle sandbox checkout needs only
a public client token, an active price id and the 4242 test card, so without
the buyer list anyone reaching the sandbox checkout would get a real, permanent
run-license. The list limits minting to your own test buyers; the date makes a
forgotten sandbox Worker stop minting on its own within a week.

All config guards run in this order before any webhook processing: signing key
(`config`), `SUPPORT_EMAIL`, `RESEND_FROM`, `PADDLE_API_KEY`,
`PADDLE_PRICE_IDS`, env mismatch, `SANDBOX_SIGNING_UNTIL`,
`SANDBOX_BUYER_EMAILS`. A `503` means nothing
was written and Paddle re-delivers, so the event is fulfilled unchanged once the
value is fixed.

**The daily delivery check.** `wrangler.toml` declares a cron trigger
(`0 13 * * *`, once a day at 13:00 UTC). It calls
`GET /notifications?status=failed,needs_retry` and `GET /notification-settings`
with the Worker's own API key, and raises an operator alert (stage
`delivery-check`) if any notification is failed or waiting to retry, if Paddle
reports no destination at all or any destination is inactive, or if the check
itself could not run (no usable key, or an API error). This is what notices a webhook secret that no longer matches,
since bad signatures never alert. The comma-separated `status` filter follows
Paddle's reference but has not been exercised against a real account (§8).

**Set up the notification destination in Paddle** (Developer tools →
Notifications), one per account:

- URL: the deployed Worker.
- Events: **`transaction.completed`, `adjustment.created`, `adjustment.updated`,
  `api_key.expiring`, `api_key.expired`.** Nothing else is needed; anything else
  is `ignored`.
- Traffic source (`traffic_source`): `platform` on the live destination, so
  simulator traffic never reaches it; `all` on the sandbox destination, so you
  can use the simulator there.
- Copy the destination's secret key into `PADDLE_WEBHOOK_SECRET`.

Paddle expects a `200` within 5 seconds. Live, it retries a failed delivery up
to 60 times over about 3 days; sandbox, 3 times in 15 minutes. After that the
notification is marked `failed` and can be replayed from the dashboard or the
API. Event order is not guaranteed.

**Before a live Worker sends its first license email**, the Terms
(`https://tandem.ink/terms`) and the Refund Policy (`https://tandem.ink/refunds`)
must be live: the license email links both, plus Paddle's buyer-support site
(`https://paddle.net`), because Paddle's seller handbook asks for them. Neither
page is live yet.

The wrangler version is pinned deliberately: `./crypto.js` resolving to `crypto.ts`
is the bundler rewriting the extension, and the bundle shape is wrangler's too, so
two deploys of identical source can differ across wrangler versions. To advance it,
re-run `npm view wrangler version` and update **all six** deploy sites together —
§3 and §3.5b here, both §9 quick-reference rows, and the two Worker READMEs.

Also set in `[vars]`: `SUPPORT_EMAIL` (the license email's `reply_to` — without
it a buyer whose activation fails has no inbound channel but the public issue
tracker, where they will paste a key carrying their own name and email), and
`ALERT_WEBHOOK_URL` / `ALERT_EMAIL` (§5c).

`SUPPORT_EMAIL` is **required and enforced**: the Worker rejects every request
with 503 and `stage: "config-support-email"` while the value is unset, still the
`REPLACE_WITH_…` placeholder, not address-shaped, or longer than 70 characters.
`RESEND_FROM` is enforced the same way and for the same reason, under its own
`stage: "config-resend-from"`: the shipped `REPLACE_WITH_VERIFIED_SENDER` is
*present*, so a point-of-use presence check passed it and the Worker minted the
license, wrote the entitlement, then got a Resend 422 — buyer charged, license
issued, email never sent. Both guards now run before any webhook processing.

That is deliberate — the alternative was emitting a license email with no support
address at all, or with the placeholder printed in it, to a customer who has
already paid. The length bound is not cosmetic: the address prints on its own
line beneath the base64 key, and a line over 72 characters invites an MTA to
re-encode the body as quoted-printable, whose soft line break truncates that key.
A `Name <addr>` display name is allowed but counts toward the 70. A 503 makes
Paddle re-deliver, so the event is fulfilled unchanged once the var is fixed.
Note that the check is per-request, not a deploy-time gate: it alerts only when
a webhook arrives (§5c), and Paddle's notification log (§5b) shows the
retries.

Deploy a **separate sandbox instance** to test end-to-end. Paddle's sandbox is a
**separate Paddle account** with its own host, notification destination, webhook
secret and API key, and it needs no business verification, so this is unblocked
before any payout setup. The sandbox Worker is the **`[env.sandbox]` block** at
the end of `wrangler.toml`; it deploys as `tandem-license-issuance-sandbox`. The
block re-declares its own vars (`TANDEM_ISSUANCE_ENV = "sandbox"`,
`RESEND_FROM`, `SUPPORT_EMAIL`, the sandbox price ids in `PADDLE_PRICE_IDS`,
`SANDBOX_BUYER_EMAILS`, `SANDBOX_SIGNING_UNTIL`) and its **own KV namespaces**,
because Wrangler does not inherit vars or namespaces into an environment, so a
sandbox deploy can never fall back to production's. Fill in its placeholders,
then create its namespaces and run **every** sandbox command (`deploy`,
`secret put`, `secret delete`, `kv namespace create`) with `--env sandbox`. **A
bare command targets production**: run without the flag from
`infra/license-issuance-worker/`, each one acts on the production Worker.

```bash
npx wrangler@4.130.0 kv namespace create LEDGER_KV --env sandbox     # and LICENSE_KV
npx wrangler@4.130.0 deploy --env sandbox
npx wrangler@4.130.0 secret put PADDLE_WEBHOOK_SECRET --env sandbox
npx wrangler@4.130.0 secret put PADDLE_API_KEY --env sandbox          # pdl_sdbx_apikey_...
npx wrangler@4.130.0 secret put RESEND_API_KEY --env sandbox
npx wrangler@4.130.0 secret put TANDEM_PRIVATE_KEY --env sandbox
```

`SANDBOX_SIGNING_UNTIL` is at most 7 days ahead, so a sandbox session longer
than that means editing the date and redeploying. That is the point.

> **The sandbox instance signs with the production key.** Its
> `TANDEM_PRIVATE_KEY` must be a key in `TRUSTED_KEY_IDS`, so in practice the
> real one: a throwaway key answers every webhook 503 at stage `config`, and a
> key no build trusts could not pass the "it activates" check anyway.
> `TANDEM_ISSUANCE_ENV` does not change the signing, and the key is emailed as
> usual, so every sandbox order **from a buyer in `SANDBOX_BUYER_EMAILS`** sends
> that address a key that activates Tandem from a test-card payment. Orders from
> anyone else are ignored and mint nothing. (A minted one gets no updates: no
> entitlement reaches the live `LICENSE_KV`, because `sandbox` skips the write
> and `production` on the sandbox writes to its own namespaces.) Keep the
> buyer list to your own test addresses. `SANDBOX_SIGNING_UNTIL` makes a
> forgotten sandbox Worker stop minting within a week, but that is a backstop:
> once the end-to-end check passes, **delete the sandbox Worker**
> (`npx wrangler@4.130.0 delete --env sandbox`). Taking only the key off
> (`npx wrangler@4.130.0 secret delete TANDEM_PRIVATE_KEY --env sandbox`) stops
> the minting but leaves its daily delivery-check cron running, which alerts
> every day once its API key expires. **Target that Worker explicitly.** Run bare from `infra/license-issuance-worker/`,
> without `--env sandbox`, the command targets the production Worker and
> deletes the production key. If you ran the check with `wrangler dev`
> instead, the key sits in `.dev.vars` (gitignored); delete that file afterwards.

> **Which `TANDEM_ISSUANCE_ENV` the sandbox gets depends on what you're testing.**
> `sandbox` writes the ledger but suppresses the entitlement `put`, which is
> right for exercising issuance/dedup/refund logic — but it makes the
> "does the entitlement exist?" check (§5a step 3) structurally incapable of
> failing, because there was never going to be an entitlement. (The manifest
> check, step 4, never works from the sandbox: see §8.)
> **For the pre-launch end-to-end gate, set `TANDEM_ISSUANCE_ENV = "production"`
> in the `[env.sandbox.vars]` block** (it ships as `"sandbox"`) and keep its own
> KV namespaces, then put it back afterwards. Separate
> namespaces are required because the test/live mode segment lives only in
> *ledger* keys — entitlement keys are a bare `licenseId` and would collide with
> production. (With `production` the ledger keys also read `live`, so the
> namespaces are the only separation.) This configuration needs a `pdl_sdbx_`
> key, which is why `SANDBOX_SIGNING_UNTIL` and `SANDBOX_BUYER_EMAILS` are
> required with it.

### 3.5c. Recovery & monitoring

- The ledger record persists everything needed to **re-sign an identical blob**
  (no separate blob copy; after a signing-key rotation the re-signed blob uses
  the current key, so it differs but is equally valid), so a failed email is recoverable: the Worker returns
  a retryable `500` and Paddle's retry re-drives (re-asserts the entitlement,
  resends the email). Records with `emailSent: false` are the "who didn't get
  their license" worklist.
- Entitlement-write failure is likewise retryable (`500`) — the issuance Worker
  owns the KV binding directly, so it can afford to block-and-retry.
- Resend needs a **verified sending domain** with SPF, DKIM, and DMARC, or mail
  lands in spam — **and an unverified sender is not merely a spam problem**: it
  returns 422, which becomes a retryable 500, which is how every sale retries
  its way into Paddle's `failed` list. See §5b.
- Alerting is covered in §5c. Note that `emailSent: false` is only the worklist
  for orders that produced a ledger record at all; §5b explains why that is not
  the same as "every order that failed".
- **Known gap — concurrent-delivery races.** Workers KV has no
  compare-and-swap; two genuinely concurrent deliveries for the same
  transaction (e.g. a slow first request plus an ordinary Paddle retry 5 s
  later, not just an attacker) can both mint, or a refund's tombstone can be
  overwritten by a mint that lands just after its recheck. Every mint writes a
  `txnlic:<mode>:<txn_id>:<licenseId>` index entry before the ledger, so a later
  refund revokes **every** license a transaction minted, not only the one left
  in the ledger. Two residuals remain: KV `list()` is eventually consistent
  (about 60 s), so a full refund within a minute of a double mint can miss the
  second license, and a double mint sends the buyer two emails. See the Worker's
  README "Known limitation" section. **After refunding**, spot-check with
  `npx wrangler@4.130.0 kv key get "order:live:<txn_id>" --remote --namespace-id
  <LEDGER_KV id>` that `refunded: true`, list the transaction's licenses (§5b),
  and read each one's `LICENSE_KV` entry, until the tracked Durable-Object fix
  lands.

## 4. The v1.0 flag flip (enabling enforcement)

**Two consts flip, in two languages, and they must land in the SAME commit.**
`tests/docs/license-flip-consts.test.ts` asserts the biconditional — gate dark
⇔ endpoint empty — in both directions, and `check` is a required status check,
so a half-flip turns `master` red rather than shipping an armed run gate with an
inert update window (#1785).

1. Confirm the commercial-readiness exit criterion (ADR-040 / roadmap).
2. Flip `const LICENSE_GATE_ENABLED = false` → `true` in `tsup.config.ts`.
3. Set `const LICENSE_UPDATE_ENDPOINT: &str = ""` in `src-tauri/src/lib.rs` to
   the deployed Worker URL, **in that same commit**. While it is empty,
   `resolve_update_route` returns `Public` on its first line without probing, so
   the update window gates nobody however the run gate is set.
4. **Verify** `tauri.conf.json`'s public endpoint is now reachable only from the
   trial and dark-gate arms of `update_route`. This is a check, **not a
   deletion**: `Public` is what still serves every trialing device, and removing
   the endpoint would cut off every evaluator on flip day.
5. Rebuild and release. On first launch of a gate-active build, each user starts
   a clean **14-day trial** (`trial.json` is only written when the gate is on, so
   prior dark installs don't pre-burn the clock).
6. Grandfathered/paid testers who already activated (Settings → License, or
   `tandem activate` on an npm install) are `licensed` immediately — no trial,
   no wall.

## 5. First-sale verification, and reconciling from Paddle

### 5a. Run this for the first ~5 sales

One dashboard check and three commands, end to end. Step 4 is the one that
catches a license that will silently never update — the failure no other check
sees.

> **`--remote` is not optional.** Wrangler v4 flipped the default for `kv key`
> commands to **local** storage. Without it these read an empty local store,
> return "key not found", and send you off re-issuing a license that was fine.

```bash
# 1. Paddle dashboard: the transaction is completed AND its transaction.completed
#    notification was delivered (Developer tools > Notifications).

# 2. The ledger has a complete record.
npx wrangler@4.130.0 kv key get "order:live:<txn_id>" --remote --namespace-id <LEDGER_KV id>
#    expect: emailSent: true, refunded: false. Note the licenseId.

# 3. The entitlement exists.
npx wrangler@4.130.0 kv key get "<licenseId>" --remote --namespace-id <LICENSE_KV id>

# 4. The updater is actually served a manifest.
curl -H "X-Tandem-License-Id: <licenseId>" https://<your-update-endpoint>/latest.json -i
#    expect: 200 with a manifest. A 204 means this customer will be told
#    "You're up to date" forever. THIS is the step that catches it.
```

Also ask those first buyers whether the email arrived at all — including in
spam. Nothing in the pipeline can tell you that.

### 5b. Reconcile from Paddle, not from the ledger

**Enumerate completed transactions from Paddle and diff against the ledger.**
The obvious design — scan the ledger for `emailSent: false` — cannot see the
failures that matter most, because they produce **no ledger record at all**:

> **A failing delivery retries into Paddle's `failed` list.** A single
> misconfiguration — an unverified `RESEND_FROM` returning 422, a webhook secret
> regenerated in Paddle without a matching `wrangler secret put`, an expired API
> key — makes every sale return a non-2xx. Paddle retries each one (live: 60
> times over about 3 days), then marks the notification `failed`. Whether Paddle
> also deactivates a destination that keeps failing is unverified (U5). Either
> way the Worker has no record of those sales, and a bad signature never alerts.
> The **daily delivery check** (§3.5b) is the in-band signal: it alerts once a
> day while any notification is `failed` or `needs_retry`, a destination is
> inactive, or Paddle reports no destination at all. Paddle's notification log is the surface that shows the detail.

**The steps:**

1. In Paddle, list completed transactions for the period (the dashboard; the
   API's list-transactions call should do the same, but it is not exercised
   here), and for each one read
   `order:live:<txn_id>` from `LEDGER_KV`.
2. In Paddle's notification log (Developer tools → Notifications), look for
   `failed` notifications. Once the cause is fixed, **replay** each one from the
   dashboard or the API. A replay is safe: an already-processed event answers
   `duplicate`, and the ledger blocks a re-mint. The one exception: replaying a
   full refund for an order you have since restored by hand (§7) revokes it
   again, once its 4-day `evt:` marker has lapsed. Whether a replay carries a
   fresh `ts` (so that it passes the 300 s freshness window) is unverified and a
   deploy gate (U1, §8).
3. **List and act on the notices.** Every `dropped` and `noticed` event left a
   record:

   ```bash
   npx wrangler@4.130.0 kv key list --prefix "notice:live:" --remote --namespace-id <LEDGER_KV id>
   npx wrangler@4.130.0 kv key get "notice:live:<stage>:<ref>" --remote --namespace-id <LEDGER_KV id>
   ```

   The value names the stage, the transaction (`txnId`, when known) and the
   event type. Act on it: for `dropped`, fix the cause and replay the event
   (drops are not marked done, so a replay is processed again); for
   `refund-partial`, decide whether the partials now add up to a full refund
   and revoke by hand if so (§7); for the reversal notices, restore by hand
   (§7); for `api-key-expiry`, replace the key. Then delete the record:

   ```bash
   npx wrangler@4.130.0 kv key delete "notice:live:<stage>:<ref>" --remote --namespace-id <LEDGER_KV id>
   ```

4. **Check for double mints.** List every license a transaction minted:

   ```bash
   npx wrangler@4.130.0 kv key list --prefix "txnlic:live:<txn_id>:" --remote --namespace-id <LEDGER_KV id>
   ```

   **More than one key under one transaction is a double mint**: the buyer got
   two emails and holds two working licenses. Both are harmless to them. A
   later refund revokes every one listed; a refund that landed within about a
   minute of the double mint may have missed the second (KV `list()` is
   eventually consistent), so tombstone any listed license that is still live on
   a refunded order (§7).

For a transaction Paddle has and the ledger doesn't, replay its notification
once the cause is fixed. For an order that has a ledger record but no
entitlement, re-`PUT` the entitlement (§3b) — no re-issuing.

### 5c. Alerting

The issuance Worker raises operator alerts in-band on the results worth waking
for:

| Alerted | Means | Reply |
|---|---|---|
| `dropped` | A signed event could not be fulfilled; a paid sale may be behind it | 200 + `notice:` record |
| `noticed` | An adjustment or API-key event a human must act on | 200 + `notice:` record |
| stage `email` | A license was minted but not emailed | 500 |
| stage `paddle-api` | The Paddle API could not be reached to look up a buyer | 500 |
| stage `paddle-api-auth` | The Paddle API key is expired or lacks `customer.read`; every sale fails until it is replaced | 500 |
| stage `notice-write` | A notice or drop record could not be written to `LEDGER_KV` | 500 |
| stage `ledger` | A ledger record exists but cannot be parsed; that order cannot be issued or refunded until it is repaired by hand (never re-minted) | 500 |
| the **config stages**: `config`, `config-support-email`, `config-resend-from`, `config-paddle-api-key`, `config-price-ids`, `config-env-mismatch`, `config-sandbox-until`, `config-sandbox-buyers` | The Worker is refusing every webhook | 503 |
| stage `delivery-check` | Raised by the daily cron, not a webhook (§3.5b) | — |

Not alerted, deliberately: `rejected` (a missing or bad signature, a stale
timestamp, an oversized body, a non-POST: anyone on the internet can produce
these, and an alert per request would drain the Resend quota that delivers
licenses), `unexpected` / `blob-size` (transient, retried), and the quiet 200s
(`issued`, `duplicate`, `revoked`, `settled`, `ignored`). `ignored` includes a
free transaction for a price outside `PADDLE_PRICE_IDS` and, on a sandbox
Worker, a buyer outside `SANDBOX_BUYER_EMAILS`: both leave no record.

The config stages are enumerated rather than prefix-matched, and they are the
only alerts raised before signature verification, so their volume is bounded by
inbound requests against the per-isolate throttle rather than by authenticated
ones. An alert about a broken `RESEND_FROM` never goes through Resend, for the
same reason an email-stage one does not: the fallback would send *from* the
broken address.

A 200-reply alert (`dropped`, `noticed`) says "Paddle will not retry this" and
points at the `notice:` keys (§5b); a 500-reply alert says Paddle retries for up
to 3 days (60 attempts) and then marks the notification failed.

- `ALERT_WEBHOOK_URL` — any incoming webhook (Slack/Discord/ntfy).
  **Required to be alerted about email failures**, which cannot be reported
  through Resend, because Resend is what just failed. Without it, an email-stage
  alert is deliberately dropped rather than sent down the broken path.
- `ALERT_EMAIL` — operator inbox for everything else, via Resend.

Alert bodies carry the coarse result/stage only — never an email, license id,
Paddle id, or payload bytes; the ids are in the `notice:` record and the log
line. Alerts are throttled per isolate for five minutes, by (result, stage), so
a retry storm doesn't become an alert storm; `noticed` and `dropped` are
throttled by (result, stage, ref) instead, so two different transactions never
share a slot.

`wrangler tail` is a **debugging tool, not an alert**: no history, no thresholds,
no notification, and it dies with the terminal session. Cloudflare offers nothing
free that emails on a log condition, so don't plan around one.

**The update Worker (#1786).** It alerts too, on `unknown-id` and `unparseable`
— an entitlement *nobody removed* is gone, which is the "You're up to date
forever" state. One channel only: `ALERT_WEBHOOK_URL`. There is deliberately no
`ALERT_EMAIL` here, because this Worker has no Resend binding and the one
surface that must answer every anonymous updater should not hold a mail secret.
Three properties worth knowing before you read a quiet channel as health:

- `expired` and `revoked` never alert. Both are expected — the second is your
  own refund or §7 revocation, and paging you for it on every check for the life
  of the blob is how a channel gets muted.
- The alert fires only for a **UUID-shaped** id. The endpoint is
  unauthenticated, so without that gate a scanner pages you on a healthy system.
  A non-UUID id is still logged; it just never pages.
- **Residual, stated rather than fixed:** a UUID-shaped flood still reaches the
  channel and consumes the per-isolate throttle slot, which can suppress a
  genuine event for five minutes. Bounding that needs a KV counter, i.e. a write
  per request, and is not worth it.

Both halves are merged but **inert until the Workers are redeployed** with `[observability]` and `ALERT_WEBHOOK_URL` set (§8).

## 6. Back up `LEDGER_KV`

`LEDGER_KV` is the only copy of the only non-derivable data in the system. A
`licenseId` exists nowhere else except inside the customer's own blob, and
Workers KV has **no point-in-time restore, no snapshots, and no single export
command**.

- `LICENSE_KV` needs no backup — every value is derivable from a ledger record
  via `entitlementValue(rec)`. Said explicitly so the habit sticks on the
  namespace that actually matters.
- Make it **scheduled, not remembered**: a Worker Cron Trigger (free) or a
  scheduled GitHub Action running `wrangler` with a scoped read token, writing
  NDJSON to a **private** destination. At ~2,000 records a daily export is
  inside the free read tier.

> **No backup job is checked into this repository, deliberately.** The export
> contains every customer's name and email in plaintext, and the obvious
> zero-infra destination for a scheduled GitHub Action — a workflow artifact —
> is readable by anyone who can read a **public** repository. This one is
> checked in as a decision rather than a script: pick a genuinely private
> destination (an R2 bucket, a private repo, encrypted object storage) and wire
> the job there. A convenient backup that publishes your customer list is worse
> than no backup.
- The export contains plaintext `email` and `name`. Whatever destination you
  choose becomes a PII store, so `docs/security.md` and `docs/data-locations.md`
  must stay true about where PII lives.

**Customers are a distributed backup, and this is why the copy-key button
exists.** `metadataFrom` puts id, name, email, type, createdAt, expiresAt,
version and `keyId` into the signed blob — so the blob *is* a complete ledger record.
`keyId` is not a ledger field, though: rebuilding the signed blob from a ledger
record also needs the id of the key that signed it (§0). A
customer who emails you their key hands you everything needed to rebuild their
record and re-`PUT` their entitlement.

## 7. Refunds, revocation, and the kill switch

- **A refund does not stop the software running, and that is intentional.**
  Paddle, as merchant of record, processes the refund itself; the Worker only
  hears about it. `applyRefund` writes a revocation **tombstone** over the
  update entitlement of every license the transaction minted; the signed blob
  still verifies forever (ADR-040 §4 — activation is air-gapped by design), so
  what a refund stops is new versions being offered to that key. Consumer law
  obliges returning the money, not technical revocability. Which adjustments
  revoke, and which only leave you a notice, is the table in §3.5a.
- Note the arithmetic before pricing: 14-day trial + a 14-day EU withdrawal
  window + perpetual run ≈ **28 days of legitimate free use ending in a
  permanent license.** That's a deliberate consequence of the design, not a leak
  to plug — but it should be a decision, not a surprise.
- **Revoking updates** = writing a TOMBSTONE over `KV[licenseId]`, never
  deleting it:

  ```bash
  npx wrangler@4.130.0 kv key put "<licenseId>" '{"updateWindowEnd":null,"status":"revoked"}' \
    --remote --namespace-id <LICENSE_KV id>
  ```

  **Do not `kv key delete`.** A deleted key is indistinguishable from a key that
  was lost (a failed write, an eviction, a namespace-id mismatch), and the
  update Worker alerts on that absence — so deleting would page you for your own
  deliberate action on every check that customer's install makes, forever, until
  you mute the channel and stop detecting the real thing. The tombstone answers
  `revoked` instead: retained and readable, never alerted on. It still puts the
  customer into the "You're up to date, forever" state described in §3b, so
  record every deliberate revocation somewhere you'll look when they open a
  ticket.
- **Kill switch: stop the sales first.** If issuance is broken, the instinct is
  to debug while broken sales keep arriving. Every minute spent debugging a live
  checkout is another customer to reconcile by hand. Three steps, in this order:
  1. **Archive the price** in Paddle (Catalog → Products → Tandem), so no new
     checkout can use it. Whether archiving blocks a checkout that is already
     open is unverified (U9).
  2. **Remove the price from `PADDLE_PRICE_IDS`** and redeploy, so a
     transaction that still gets through is `dropped` (and alerted, and
     recorded) instead of minted, while redeliveries of orders already in the
     ledger still re-drive (the ledger read comes before the price check). If
     it was the only listed price, an empty list is a config error: the Worker
     answers every webhook `503` (`config-price-ids`), refunds included, and
     Paddle holds everything for retry until the list is non-empty again.
  3. If the Worker itself is the problem, **deactivate the notification
     destination** in Paddle, so events stop hitting a broken Worker. Whether
     Paddle still records them for replay is unverified (U11): once it is
     fixed, replay what Paddle has (§5b), and reconcile the rest from the
     transaction list (§5b step 1).

### Revoke by hand

For a notice that calls for it (partial refunds that now add up to a full
refund, or any revocation you decide on). All three steps, because the ledger
flag is what stops a replayed `transaction.completed` from re-driving the order
and writing the live entitlement back (`reDrive` re-asserts it for any record
not marked refunded):

1. In the ledger record `order:live:<txn_id>`, set `"refunded": true` and put it
   back (read it, edit that one field, write the whole JSON):

   ```bash
   npx wrangler@4.130.0 kv key get "order:live:<txn_id>" --remote --namespace-id <LEDGER_KV id>
   npx wrangler@4.130.0 kv key put "order:live:<txn_id>" '<the record, with "refunded":true>' \
     --remote --namespace-id <LEDGER_KV id>
   ```

2. Tombstone **the ledger's `licenseId` and every `licenseId` listed under
   `txnlic:live:<txn_id>:`** (§5b step 4):

   ```bash
   npx wrangler@4.130.0 kv key put "<licenseId>" '{"updateWindowEnd":null,"status":"revoked"}' \
     --remote --namespace-id <LICENSE_KV id>
   ```

3. Delete the `notice:` key that prompted it, if there was one.

### Restore by hand

For a reversed chargeback, credit or adjustment (`chargeback-reverse`,
`credit-reverse`, `adjustment-reversed`):

1. Set `"refunded": false` in `order:live:<txn_id>`, as above.
2. Re-`PUT` the live entitlement for the ledger's `licenseId` and every
   `licenseId` under `txnlic:live:<txn_id>:`. The value is fully derivable from
   the record (`entitlementValue`): `status` is the record's `type`,
   `personal` or `grandfathered`:

   ```bash
   npx wrangler@4.130.0 kv key put "<licenseId>" '{"updateWindowEnd":null,"status":"personal","version":"1.0"}' \
     --remote --namespace-id <LICENSE_KV id>
   ```

3. Delete the `notice:` key.

If the record is a **tombstone** (empty `licenseId` and `email`: a full refund
or chargeback arrived before the purchase, so nothing was ever issued), there is
nothing to restore; hand-sign the buyer a license instead (§1a/§2). A late
approved full refund that arrives after you restore will revoke again; watch
for it after any reversal.

### Erase by hand

For a buyer who asks support@ to have their details erased (the promise in
[data-locations.md](data-locations.md#if-you-buy-a-license-what-the-seller-keeps)).
Their license and its updates keep working, because the entitlement is keyed by
the license id alone:

1. In `order:live:<txn_id>`, set `"email": ""` and `"name": ""`, and set
   `"emailSent": true` so no retry ever tries to send to the blank address. Put
   the whole record back, as in "Revoke by hand" step 1. Keep every other field:
   the ids and the `refunded` flag are what stop a replay from re-minting or
   un-revoking.
2. `notice:` and `txnlic:` keys hold ids only, so leave them.
3. Your `LEDGER_KV` backups (§6) still hold the old record. Delete or rewrite
   any backup that contains it.
4. Tell the buyer what this does not reach: Paddle's customer record (they ask
   Paddle, at `https://paddle.net`, or you forward the request), Resend's
   delivery log of the license email (kept under Resend's retention), and the
   license file on their own machine, which carries their name and email inside
   its signature and cannot be changed without re-issuing it.

### Support template

When a customer reports an activation or update problem, ask for **the order
number** (see Vocabulary; payment questions go to Paddle's buyer support at
`https://paddle.net`, which the license email links) — never the license key (it contains their name and email, and they'll
paste it into a public issue if you let them) and never the license id (a
customer with a broken license often can't read it).

Then walk §5a steps 2–4 with that order number.

## 8. Pre-launch gate (all of these, before a stranger can pay)

- [ ] Key ceremony done (§0), including the three now-or-never decisions, two
      offline private-key copies, and the CI fingerprint updated in the same commit.
- [ ] Custom domain in front of the update Worker, and that URL — not
      `*.workers.dev` — compiled into `LICENSE_UPDATE_ENDPOINT`.
- [ ] Both `wrangler.toml` files carry the **same** `LICENSE_KV` id.
- [ ] Workers Paid enabled.
- [ ] Resend sending domain verified with SPF, DKIM and DMARC.
- [ ] **Resend proven end-to-end through the deployed Worker** — this is the
      cheap way to buy off the failed-delivery risk in §5b, and it is
      non-negotiable while `stage: "email"` returns a retryable 500.
- [ ] `SUPPORT_EMAIL` set, the mailbox actually exists, and someone reads it.
      The Worker enforces the first clause (503 on unset/placeholder/malformed);
      the mailbox existing and being read is still only this checklist line.
- [ ] `RESEND_FROM` set to the **verified** sender, not the shipped
      `REPLACE_WITH_VERIFIED_SENDER`. Enforced like `SUPPORT_EMAIL` (503,
      `stage: "config-resend-from"`, before anything is minted); that the domain
      is actually verified in Resend is still only this checklist line, and it is
      what the end-to-end send test above proves.
- [ ] `ALERT_WEBHOOK_URL` set on the **issuance** Worker and reachable. One box,
      two reasons: the config-stage 503s are now alertable and a broken
      `RESEND_FROM` cannot be reported through Resend (its own arm skips the
      Resend fallback), and without the webhook you cannot be alerted about the
      email failures that send every sale into Paddle's `failed` list (§5c).
- [ ] `ALERT_WEBHOOK_URL` set on the **update** Worker too, and
      `[observability]` deployed on **both**. Until then the #1786 detector is
      merged and inert: nothing retains the `reason` lines and nothing reaches
      you when an entitlement goes missing.
- [ ] **Verify what Cloudflare's retained invocation record actually holds**,
      against a real deployment. Tandem's own log line carries `{result, reason,
      ts}` and no license id — that is pinned by tests. The platform's
      invocation record is not ours and has never been read: if it carries
      request headers it holds `X-Tandem-License-Id`, i.e. exactly the
      per-customer update history the no-id invariant exists to prevent. If it
      does, the response is to drop `[observability]` on the update Worker or to
      stop sending the id in a header. Do not assume either way from the docs.
- [ ] A sandbox purchase completed end-to-end: email → activate →
      `tandem license` reports `licensed` → §5a steps 2–3 pass **against the
      sandbox's own namespaces** (`--env sandbox --binding LEDGER_KV` /
      `--binding LICENSE_KV` in place of `--namespace-id`).
      Deploy the sandbox (`--env sandbox`) with **`TANDEM_ISSUANCE_ENV =
      "production"` in `[env.sandbox.vars]`, its own KV namespaces, and the
      test buyer's address in `SANDBOX_BUYER_EMAILS`** — `sandbox` suppresses
      the entitlement write, so step 3 would be structurally incapable of
      failing. Use separate namespaces because the mode segment lives only in
      *ledger* keys; entitlement keys are a bare `licenseId` and would collide.
      **§5a step 4 (the manifest) cannot pass here, by design:** the update
      Worker reads production's `LICENSE_KV`, and the sandbox writes its own.
      Never point the sandbox at production's `LICENSE_KV` to make it pass:
      that would give a test-card license, signed with the real key, permanent
      production updates. Step 4 is first proven on the first real sale (§5a).
- [ ] **U1 — the hard deploy gate. Do not deploy a live Worker until it
      passes.** Does a Paddle retry, and a dashboard or API replay, carry a
      *fresh* `ts` in `Paddle-Signature`? The Worker refuses a `ts` more than
      300 s old, so if either keeps the original, every retry after five
      minutes and every replay in §5b is a `401`, and a sale that failed once
      can never be recovered through Paddle. Test: in the sandbox, break
      `RESEND_FROM`, let a retry land more than five minutes after the first
      attempt, then run a dashboard replay; both must succeed once
      `RESEND_FROM` is fixed. If either fails, the tolerance has to widen
      (to about 4 days, leaning on the `evt:` marker and the ledger for replay
      defence) before launch.
- [ ] **The other unverified facts (U2–U12), settled in the sandbox** and
      captured as fixtures (email and name scrubbed):
      - **U2** — does a $0 (100%-code) checkout fire `transaction.completed` at
        all? Governs §1b; until it is settled, §1a is the grandfather path.
      - **U3** — what `status` does an auto-created chargeback adjustment carry?
        Anything but `approved` is dropped and alerted rather than revoked.
      - **U4** — does checkout fill the customer's `name`? (If not, every email
        says "Valued Customer".)
      - **U5** — does Paddle deactivate a destination that keeps failing?
      - **U6** — which id does Paddle's receipt show the buyer (Vocabulary)?
      - **U7** — are simulator deliveries signed?
      - **U8** — how large is a real `transaction.completed`? The Worker
        refuses bodies over 256 KiB before verifying them.
      - **U9** — does archiving a price block a checkout that is already open
        (§7 kill switch)?
      - **U10** — does the transaction carry `discount_id`?
      - **U11** — does Paddle create notifications for a destination that is
        deactivated (§7 kill switch step 3)? If not, there is nothing to replay
        afterwards, and sales made meanwhile are recovered from the transaction
        list (§5b step 1) instead.
      - **U12** — does a replay create a new notification and leave the
        original `failed`? If so, the daily delivery check alerts every day
        after any past failure, and needs a time bound (`from`) before launch,
        or the alert channel learns to be ignored. The `status=failed,needs_retry`
        filter syntax is confirmed on the same run.

      Also confirm, on the same run, that the Worker's Ed25519 import works on
      real Cloudflare (it never has, and a key-import failure fails closed to
      503 on *every* webhook), and that the daily delivery check's
      `GET /notifications?status=failed,needs_retry` and
      `GET /notification-settings` calls work with the key's scopes (break the
      webhook secret on the sandbox and wait for the alert).
- [ ] **`PADDLE_API_KEY` expiry is in your calendar**, two weeks before the
      date Paddle shows (one year at most from creation), and the live
      destination is subscribed to `api_key.expiring` / `api_key.expired`. An
      expired key turns every sale into a `paddle-api-auth` 500.
- [ ] **`PADDLE_PRICE_IDS` on the live Worker lists only the live $45 price**,
      and no sandbox Worker is left holding the production signing key (§3.5b).
- [ ] Any `POLAR_WEBHOOK_SECRET` left on a deployed Worker is deleted (§3.5b).
- [ ] **The Terms (`https://tandem.ink/terms`) and the Refund Policy
      (`https://tandem.ink/refunds`) are live** before the live Worker sends a
      license email: the email links both. Paddle's domain review also wants
      them reachable from the site menu, naming the seller and Paddle as
      merchant of record.
- [ ] **The refund race is fixed or accepted.** A refund overlapping a
      redelivered `transaction.completed` can leave a live entitlement behind, through
      `issue()`'s recheck window or `reDrive()`, which has no recheck at all
      (`infra/license-issuance-worker/README.md`). Since keys carry no update
      window (decision A5), that entitlement never runs out. Either serialise
      per order (the Durable Object fix the README names) or record an
      acceptance in `docs/security.md`'s register. It is neither yet.
- [ ] `LEDGER_KV` backup scheduled (§6).
- [ ] Terms, refund policy and privacy notice published (see
      `docs/licensing-terms.md`).
- [ ] Beta-cohort claim path and copy settled (§1c).
- [ ] **A license whose update window has ENDED reaches the Worker and is
      refused there** — not served public builds. Only a key hand-signed with
      `--expires` can carry a window now (decision A5); sign one for this check. `update_route` classifies it
      `Licensed`, so the check carries `X-Tandem-License-Id` and the Worker's KV
      is what decides; expect the 204 and an `expired` reason in the Worker log
      (#1785). Serving that device a public manifest is the defect the route
      exists to prevent, so this is the one §8 line a passing §5a cannot cover.
- [ ] **A restricted install receives no in-app update at all** — `update_route`
      answers `NoUpdates("no-entitlement")`, `build_updater` returns
      `Ok(UpdateOutcome::Withheld(reason))`, and no request is issued. Grep for
      `UpdateOutcome::Withheld`, not `Ok(None)`: the bare `None` threw the reason
      away and is the shape this arm was rewritten out of, so finding it would
      mean the fix is absent. A manual check shows `show_update_withheld_dialog`
      — a native dialog whose copy differs per `WithheldReason`, so a paying
      customer with a dead sidecar reads "Update Check Unavailable" rather than
      being told to buy a license — never "You're up to date" (#1786 owns the
      final surfacing, #1819 the wording).

## 9. Quick reference

| Task | Command |
|---|---|
| Generate keypair | `npx tsx scripts/generate-keys.ts` |
| Sign grandfathered license | `npx tsx scripts/sign-license.ts --name N --email E --type grandfathered` |
| Sign paid license (all future updates) | `npx tsx scripts/sign-license.ts --name N --email E --type personal` |
| Activate (tester) | Settings → License (paste the key) — the only route on the desktop app; on an npm install, `tandem activate <key-or-path>` |
| Check status (tester) | Settings → License; on an npm install, `tandem license` |
| Deploy update Worker | `cd infra/license-update-worker && npx wrangler@4.130.0 deploy` |
| Deploy issuance Worker | `cd infra/license-issuance-worker && npx wrangler@4.130.0 deploy` |
| Read an order's ledger record | `npx wrangler@4.130.0 kv key get "order:live:<txn_id>" --remote --namespace-id <LEDGER_KV>` |
| List open notices (§5b) | `npx wrangler@4.130.0 kv key list --prefix "notice:live:" --remote --namespace-id <LEDGER_KV>` |
| List a transaction's licenses (>1 = double mint) | `npx wrangler@4.130.0 kv key list --prefix "txnlic:live:<txn_id>:" --remote --namespace-id <LEDGER_KV>` |
| Read an entitlement | `npx wrangler@4.130.0 kv key get "<licenseId>" --remote --namespace-id <LICENSE_KV>` |
| **Prove a license gets updates** | `curl -H "X-Tandem-License-Id: <licenseId>" https://<endpoint>/latest.json -i` (expect 200, not 204) |
| Revoke updates (tombstone, never delete — §7) | `npx wrangler@4.130.0 kv key put "<licenseId>" '{"updateWindowEnd":null,"status":"revoked"}' --remote --namespace-id <LICENSE_KV>` |
| Stop the bleeding (§7) | Archive the Paddle price; remove it from `PADDLE_PRICE_IDS`; deactivate the destination if the Worker is broken |
