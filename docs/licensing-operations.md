# Licensing Operations Runbook

> Operator guide for issuing Tandem licenses, grandfathering beta testers, and
> running the license-checked update endpoint. Audience: the project owner
> (Bryan). The on-device system is specified in
> [ADR-040](decisions.md#adr-040-audience-and-monetization-individuals-same-canvas-moat-free-beta-to-one-time-license)
> and `docs/superpowers/specs/2026-06-18-licensing-system-design.md`. The gate
> ships **dark** (`LICENSE_GATE_ENABLED = false` in `tsup.config.ts`) until v1.0.

## Vocabulary (use these words consistently)

Three identifiers get confused constantly. Fix the words and most support
threads get shorter.

| Term | What it is | Who sees it |
|---|---|---|
| **License key** | The base64 signed blob. The credential. | The customer. This is what "paste your license key" means. |
| **Order number** | Polar's order id. | **The only identifier to ask a customer for.** They can find it in their receipt; you can look it up in Polar and in the ledger. |
| **License id** | `metadata.id`, a UUID. The KV join key. | Operator only. Never ask a customer for it — a customer with a broken license often can't read it, and a refunded one has no KV entry to look up. |

## 0. Key management (the ceremony — do this once, and it freezes more than the key)

Licenses are Ed25519-signed offline. The **public** key is embedded in the app
(`src/server/license/public-key.ts`); the **private** key must never reach git.

Three decisions become irreversible the moment the first license is signed,
because changing any of them afterwards means re-issuing every customer or
supporting two schemas in `verifyLicenseSignature` forever. Decide them
explicitly, now:

1. **Key-leak recovery.** There is none today. One const, no `keyId`, so
   rotating drops every existing customer to `restricted` — mid-session,
   clamping their open documents read-only. The cheap fix is to accept an
   **array** of public keys (a few lines; makes rotation routine). Adding a
   `keyId` field instead changes the signed bytes, so it is now-or-never.
   Choosing "no recovery" is allowed, but choose it on purpose.
2. **What PII goes in the signed bytes.** `LicenseMetadata` embeds `name` and
   `email`, so both land on disk and in any support thread where the key is
   pasted. `email` buys the honour-system "bound to its buyer" deterrent;
   **`name` buys display text only, and is the field most likely to be a real
   legal name.** Decide whether `name` belongs there at all.
3. **Missing fields.** `version` is not stored in the ledger (so a future
   `LICENSE_VERSION` change would make a re-signed blob diverge from the one the
   buyer holds), and there is no `orderId`.

Then:

```bash
npx tsx scripts/generate-keys.ts        # writes keys/tandem-private-key.pem (+ prints the public key)
```

- Paste the printed public key into `src/server/license/public-key.ts`, and
  update `EXPECTED_PUBLIC_KEY_SHA256` in `tests/server/license.test.ts` in the
  **same commit** — CI pins the shipped key's fingerprint, so a swap by bad
  merge or stray paste fails the build instead of surfacing when customers'
  licenses stop verifying.
- Give the issuance Worker the private key with
  `npx wrangler secret put TANDEM_PRIVATE_KEY`.
- **`wrangler secret put` is write-only. It is NOT a backup** — you cannot read
  a secret back out. Keep **two independent offline copies in different physical
  locations**. A single password-manager entry is doing 100% of the work, and
  losing it means you can never sign another license against the key every
  shipped binary trusts.
- For out-of-band signing, `scripts/sign-license.ts` reads
  `keys/tandem-private-key.pem` (gitignored).
- **Before the ceremony, confirm nothing was ever issued with the current dev
  key.** `/api/license/activate` works regardless of the gate flag by design, so
  a tester may already hold one. Note the list may be genuinely *unknowable*:
  Tandem has no telemetry, analytics, or signup — which is also why §1c exists.
  Anyone holding a pre-rotation license now sees an explicit "installed but
  could not be verified" message rather than "your trial ended".

## 1. Grandfathering beta testers (the main flow)

Grandfathered licenses are ordinary signed licenses with `type: "grandfathered"`
and `expiresAt: null` — they run forever **and** never lose the update window.
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
> **id** only, never the email (§12 L1). The issuance Worker already does this.

> **Ledger caveat.** A script-issued license has no `LEDGER_KV` record, so it is
> invisible to reconcile (§5) and to any future resend endpoint. Prefer the
> coupon path in §1b for the grandfather cohort — it routes through `issue()`
> and is therefore fully ledgered, entitled and idempotent with zero new code.
> Keep §1a for the cases it uniquely solves: a buyer whose mail provider
> quarantined the automated email (re-sending through the same pipe cannot fix
> that), and any license you need to mint before payments exist.

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

### 1c. The cohort problem (settle this before the flip)

`README.md` publicly promises that "existing beta users are grandfathered with a
free license." **There is no list, and no way to build one** — no telemetry, no
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

1. A **claim path** that works without a list — even "email `<support>` with
   your first-install date" is enough, as long as it exists and is documented.
2. **Banner and wall copy naming the beta offer**, so a grandfathered user
   doesn't read the countdown as a bill.
3. Whether the README promise survives "we cannot identify beta users."
   If not, reword it — a promise you can't honour is worse than a narrower one.

## 2. Issuing a paid license manually (fallback)

Same script, default type. A one-year update window is now the **default**, so
`--expires` is only needed to override it:

```bash
npx tsx scripts/sign-license.ts --name "Buyer" --email "buyer@example.com"
```

`personal`/`commercial` licenses run the current version forever; `--expires`
sets only the **update window** (`expiresAt`). After it lapses the app keeps
running; it simply stops being offered new updates until renewal.

> **`--expires never` is almost always wrong for a paid license.** It's the
> flag's honest spelling of "no update window ever ends", and it is only correct
> for a genuinely perpetual grant (which is what `--type grandfathered` gives
> you by default). Omitting `--expires` used to *silently* mean `never` — that
> was D1, and it made every manually-issued license permanently un-updatable.

Same KV requirement as §1a: the script writes the update entitlement and exits
non-zero if it can't. Don't deliver a key it refused to entitle.

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
   endpoint-disable failure in §5. Total infra is ~$6/mo at any volume in range;
   Polar's cut is roughly 40× that. Do not optimize Cloudflare.

> **The two `wrangler.toml` files must carry the SAME `LICENSE_KV` id.** They
> use an identical placeholder name so a mismatch is visible on inspection —
> because it is invisible in behaviour: issuance succeeds, the buyer gets a
> working license, and the updater silently reports "up to date" forever.

### 3b. Entitlement writers

Two paths write `KV[licenseId] = { updateWindowEnd, status, version }`:

- **The paid path** — the issuance Worker (§3.5), using its own KV binding.
  Failure there is a retryable `500`, so Polar re-delivers.
- **The out-of-band path** — `scripts/sign-license.ts` via
  `src/server/license/kv-store.ts`, over the KV REST API, using the
  `TANDEM_CF_*` env vars (§1a). Failure there exits non-zero.

> Grandfathered entitlements store `updateWindowEnd: null` ⇒ the Worker treats
> them as always-current.

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
> The same dead state is reachable at least five ways: a failed write, a
> refund (`applyRefund` deletes the entitlement while the blob still verifies
> forever), the revocation procedure in §7, KV eviction, and a namespace-id
> mismatch between the two `wrangler.toml` files.
>
> **Detection:** the update Worker logs `{ result: "no-update", reason, ts }`.
> A rising `unknown-id` count is the only evidence any of the above happened.
> **Repair:** re-`PUT KV[licenseId]` from the ledger record — `entitlementValue`
> is fully derivable, so nothing needs re-issuing. If the customer still has
> their key, that works too: the blob carries id/name/email/type/createdAt/
> expiresAt/version, i.e. everything a ledger record holds.

### 3c. Behavior

- Updater asks `GET /api/license/status` (loopback). If `gateActive && licenseId && updateWindowCurrent`, it points at the Worker with an `X-Tandem-License-Id` header; otherwise it uses the public GitHub `latest.json`.
- The Worker returns a **byte-identical no-update** response for unknown ids and expired windows (no existence oracle) and logs `{ result, reason, ts }` — the reason is a coarse enum about the *service's* state, never the license id.

## 3.5. The issuance endpoint (Cloudflare — owner-deployed)

The **issuance Worker** (`infra/license-issuance-worker/`) is the public seam
that turns a paid **Polar** checkout into a signed license. It **replaced** the
loopback-only server handler `src/server/license/webhook.ts`, which Polar could
never reach and which is now deleted — issuance happens here and nowhere else,
apart from the operator's own `scripts/sign-license.ts` (§1a/§2). Like §3 it's
owner-deployed; **you** own the Polar org, the Worker, its KV namespaces, and
its secrets.

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

Also set in `[vars]`: `SUPPORT_EMAIL` (the license email's `reply_to` — without
it a buyer whose activation fails has no inbound channel but the public issue
tracker, where they will paste a key carrying their own name and email), and
`ALERT_WEBHOOK_URL` / `ALERT_EMAIL` (§5c).

`SUPPORT_EMAIL` is **required and enforced**: the Worker rejects every request
with 503 and `stage: "config-support-email"` while the value is unset, still the
`REPLACE_WITH_…` placeholder, not address-shaped, or longer than 70 characters.
That is deliberate — the alternative was emitting a license email with no support
address at all, or with the placeholder printed in it, to a customer who has
already paid. The length bound is not cosmetic: the address prints on its own
line beneath the base64 key, and a line over 72 characters invites an MTA to
re-encode the body as quoted-printable, whose soft line break truncates that key.
A `Name <addr>` display name is allowed but counts toward the 70. A 503 makes
Polar re-deliver, so the event is fulfilled unchanged once the var is fixed.
Note that the check is per-request, not a deploy-time gate: nothing alerts on
it, so a fix is only prompted by Polar's delivery log (§5b).

Point the Polar webhook endpoint (subscribed to `order.paid` + `order.refunded`)
at the deployed URL. Deploy a **separate sandbox instance** (the sandbox Polar
secret, its own namespaces) to test end-to-end — the sandbox needs no Polar KYC,
so this is unblocked before any LLC/payout setup.

> **Which `TANDEM_ISSUANCE_ENV` the sandbox gets depends on what you're testing.**
> `sandbox` writes the ledger but suppresses the entitlement `put`, which is
> right for exercising issuance/dedup/refund logic — but it makes the
> "is this license actually served a manifest?" check (§5a step 4) structurally
> incapable of failing, because there was never going to be an entitlement.
> **For the pre-launch end-to-end gate, deploy the sandbox with
> `TANDEM_ISSUANCE_ENV=production` and its own KV namespaces.** Separate
> namespaces are required because the test/live mode segment lives only in
> *ledger* keys — entitlement keys are a bare `licenseId` and would collide with
> production.

### 3.5c. Recovery & monitoring

- The ledger record persists everything needed to **re-sign an identical blob**
  (no separate blob copy), so a failed email is recoverable: the Worker returns
  a retryable `500` and Polar's retry re-drives (re-asserts the entitlement,
  resends the email). Records with `emailSent: false` are the "who didn't get
  their license" worklist.
- Entitlement-write failure is likewise retryable (`500`) — the issuance Worker
  owns the KV binding directly, so it can afford to block-and-retry.
- Resend needs a **verified sending domain** with SPF, DKIM, and DMARC, or mail
  lands in spam — **and an unverified sender is not merely a spam problem**: it
  returns 422, which becomes a retryable 500, which is how a webhook endpoint
  retries its way to being disabled. See §5b.
- Alerting is covered in §5c. Note that `emailSent: false` is only the worklist
  for orders that produced a ledger record at all; §5b explains why that is not
  the same as "every order that failed".
- **Known gap — concurrent-delivery races.** Workers KV has no
  compare-and-swap; two genuinely concurrent deliveries for the same order
  (e.g. an ordinary Polar retry landing on a different edge PoP, not just an
  attacker) can both mint, or a refund's tombstone can be overwritten by a
  mint that lands just after its recheck. See the Worker's README "Known
  limitation" section. **After refunding a higher-value order**, spot-check
  with `npx wrangler kv key get "order:live:<orderId>" --remote --namespace-id
  <LEDGER_KV id>` that `refunded: true` and that `LICENSE_KV` no longer has a
  live entry for that order's `licenseId`, until the tracked Durable-Object
  fix lands.

## 4. The v1.0 flag flip (enabling enforcement)

1. Confirm the commercial-readiness exit criterion (ADR-040 / roadmap).
2. Flip `const LICENSE_GATE_ENABLED = false` → `true` in `tsup.config.ts`.
3. Rebuild and release. On first launch of a gate-active build, each user starts
   a clean **14-day trial** (`trial.json` is only written when the gate is on, so
   prior dark installs don't pre-burn the clock).
4. Grandfathered/paid testers who already ran `tandem activate` are `licensed`
   immediately — no trial, no wall.

## 5. First-sale verification, and reconciling from Polar

### 5a. Run this for the first ~5 sales

One dashboard check and three commands, end to end. Step 4 is the one that
catches a license that will silently never update — the failure no other check
sees.

> **`--remote` is not optional.** Wrangler v4 flipped the default for `kv key`
> commands to **local** storage. Without it these read an empty local store,
> return "key not found", and send you off re-issuing a license that was fine.

```bash
# 1. Polar dashboard: the order exists AND webhook delivery is 200.

# 2. The ledger has a complete record.
npx wrangler kv key get "order:live:<orderId>" --remote --namespace-id <LEDGER_KV id>
#    expect: emailSent: true, refunded: false. Note the licenseId.

# 3. The entitlement exists.
npx wrangler kv key get "<licenseId>" --remote --namespace-id <LICENSE_KV id>

# 4. The updater is actually served a manifest.
curl -H "X-Tandem-License-Id: <licenseId>" https://<your-update-endpoint>/latest.json -i
#    expect: 200 with a manifest. A 204 means this customer will be told
#    "You're up to date" forever. THIS is the step that catches it.
```

Also ask those first buyers whether the email arrived at all — including in
spam. Nothing in the pipeline can tell you that.

### 5b. Reconcile from Polar, not from the ledger

**Enumerate orders from Polar's order list and diff against the ledger.** The
obvious design — scan the ledger for `emailSent: false` — cannot see the failure
that matters most, because that failure produces **no ledger record at all**:

> **Polar disables a webhook endpoint after repeated consecutive failures**
> (~10; confirm the exact threshold and whether it notifies you). A single
> misconfiguration — an unverified `RESEND_FROM` returning 422 — makes the
> Worker return a retryable 500, which retries its way to a disabled endpoint.
> After that, **every subsequent sale never arrives.** No record, no email, no
> alert from the Worker, because the Worker is never called. Polar's own
> delivery log is the only surface that shows this.

`"dropped"` results are the same shape of blind spot: they return 200 and write
nothing, deliberately, so a manual Polar re-send can reprocess them after a fix.

For any order Polar has and the ledger doesn't, re-send the webhook from Polar's
dashboard once the underlying cause is fixed. For an order that has a ledger
record but no entitlement, re-`PUT` the entitlement (§3b) — no re-issuing.

### 5c. Alerting

The issuance Worker raises operator alerts in-band on the two results worth
waking for: `dropped`, and any `stage: "email"` failure.

- `ALERT_WEBHOOK_URL` — any incoming webhook (Slack/Discord/ntfy).
  **Required to be alerted about email failures**, which cannot be reported
  through Resend, because Resend is what just failed. Without it, an email-stage
  alert is deliberately dropped rather than sent down the broken path.
- `ALERT_EMAIL` — operator inbox for everything else, via Resend.

Alert bodies carry the coarse result/stage only — never an email, license id, or
payload bytes. Alerts are throttled per (result, stage) per isolate so a retry
storm doesn't become an alert storm.

`wrangler tail` is a **debugging tool, not an alert**: no history, no thresholds,
no notification, and it dies with the terminal session. Cloudflare offers nothing
free that emails on a log condition, so don't plan around one.

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
exists.** `metadataFrom` puts id, name, email, type, createdAt, expiresAt and
version into the signed blob — so the blob *is* a complete ledger record. A
customer who emails you their key hands you everything needed to rebuild their
record and re-`PUT` their entitlement.

## 7. Refunds, revocation, and the kill switch

- **A refund does not stop the software running, and that is intentional.**
  `applyRefund` deletes the update entitlement; the signed blob still verifies
  forever (ADR-040 §4 — activation is air-gapped by design). Consumer law
  obliges returning the money, not technical revocability.
- Note the arithmetic before pricing: 14-day trial + a 14-day EU withdrawal
  window + perpetual run ≈ **28 days of legitimate free use ending in a
  permanent license.** That's a deliberate consequence of the design, not a leak
  to plug — but it should be a decision, not a surprise.
- **Revoking updates** = deleting `KV[licenseId]`. Remember that this puts the
  customer into the exact "You're up to date, forever" state described in §3b,
  which is indistinguishable from a bug. Record every deliberate revocation
  somewhere you'll look when they open a ticket.
- **Kill switch: unpublish the Polar product.** If issuance is broken, the
  instinct is to debug while broken sales keep arriving. Stop the sales first.
  Every minute spent debugging a live checkout is another customer to reconcile
  by hand.

### Support template

When a customer reports an activation or update problem, ask for **the order
number** — never the license key (it contains their name and email, and they'll
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
      cheap way to buy off the webhook-auto-disable risk in §5b, and it is
      non-negotiable while `stage: "email"` returns a retryable 500.
- [ ] `SUPPORT_EMAIL` set, the mailbox actually exists, and someone reads it.
      The Worker enforces the first clause (503 on unset/placeholder/malformed);
      the mailbox existing and being read is still only this checklist line.
- [ ] `ALERT_WEBHOOK_URL` set (see §5c — without it you cannot be alerted about
      the email failures that disable the endpoint).
- [ ] A sandbox purchase completed end-to-end: email → activate →
      `tandem license` reports `licensed` → §5a step 4 returns a manifest.
      Deploy the sandbox with **`TANDEM_ISSUANCE_ENV=production` and its own KV
      namespaces** — `sandbox` suppresses the entitlement write, so the manifest
      check would be structurally incapable of distinguishing pass from fail.
      Use separate namespaces because the mode segment lives only in *ledger*
      keys; entitlement keys are a bare `licenseId` and would collide.
- [ ] Real Polar payloads captured as fixtures, settling: whether a $0/100%-off
      order fires `order.paid` (governs §1b), the exact `refunded` field shape,
      and that the Worker's Ed25519 import works on real Cloudflare — it never
      has, and a key-import failure fails closed to 503 on *every* webhook.
- [ ] `LEDGER_KV` backup scheduled (§6).
- [ ] Terms, refund policy and privacy notice published (see
      `docs/licensing-terms.md`).
- [ ] Beta-cohort claim path and copy settled (§1c).

## 9. Quick reference

| Task | Command |
|---|---|
| Generate keypair | `npx tsx scripts/generate-keys.ts` |
| Sign grandfathered license | `npx tsx scripts/sign-license.ts --name N --email E --type grandfathered` |
| Sign paid license (1y updates) | `npx tsx scripts/sign-license.ts --name N --email E --type personal --expires 365` |
| Activate (tester) | `tandem activate <key-or-path>` |
| Check status (tester) | `tandem license` |
| Deploy update Worker | `cd infra/license-update-worker && npx wrangler deploy` |
| Deploy issuance Worker | `cd infra/license-issuance-worker && npx wrangler deploy` |
| Read an order's ledger record | `npx wrangler kv key get "order:live:<orderId>" --remote --namespace-id <LEDGER_KV>` |
| Read an entitlement | `npx wrangler kv key get "<licenseId>" --remote --namespace-id <LICENSE_KV>` |
| **Prove a license gets updates** | `curl -H "X-Tandem-License-Id: <licenseId>" https://<endpoint>/latest.json -i` (expect 200, not 204) |
| Revoke updates | `npx wrangler kv key delete "<licenseId>" --remote --namespace-id <LICENSE_KV>` |
| Stop the bleeding | Unpublish the Polar product |
