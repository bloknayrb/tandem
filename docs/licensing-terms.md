# Tandem licence terms — working draft

> **Status: DRAFT. Not legal advice, and not yet published.** This file exists
> because nothing did: there is currently no EULA, terms of sale, refund policy,
> or privacy notice anywhere in the repository, the README, or the product. The
> only artifact doing that job today is nine lines of email body in the issuance
> Worker.
>
> Everything below is a statement of *what the software actually does*, written
> so that a lawyer can turn it into terms without having to reverse-engineer the
> code, and so that nothing is promised that the implementation doesn't deliver.
> **Items marked ⚖️ need professional review before the first sale.**

Related: [ADR-040](decisions.md), [licensing-operations.md](licensing-operations.md),
[security.md](security.md), [data-locations.md](data-locations.md), and the
repository [LICENSE](../LICENSE) (BUSL-1.1).

---

## 1. What a purchase actually grants

Stated as the code behaves, not as marketing:

| | Behaviour |
|---|---|
| **Right to run** | Perpetual. The run gate checks the Ed25519 signature only (`verifyLicenseSignature`, never `verifyLicense`), so a paid licence runs **forever** — including after the update window ends, and including after a refund. |
| **Updates** | One year from issuance (`expiresAt` / `updateWindowEnd`). After that the app keeps running; it is simply no longer offered new releases. |
| **Activation** | Fully offline. No server contact, no activation call, no device count, no seat check. |
| **Devices** | Technically unlimited — nothing enforces a device count. The email says "any device you personally use", which is an **honour-system** limit, not a technical one. Terms should say the same thing, or say something different and be honest that it isn't enforced. |
| **Transfer** | Undefined today. ⚖️ See §6. |
| **Organisational use** | **Not available.** See §2. |

## 2. Organisational use is currently unsellable — checkout copy must say so ⚖️

The BUSL Additional Use Grant covers "Personal use and individual
self-hosting". An organisation is outside that grant entirely, so it needs a
commercial licence — and this pipeline **cannot mint one**:
`isLedgerRecord` accepts only `personal | grandfathered`, so a `commercial`
record would read back as `LedgerCorruptError` and produce a retryable 500
forever.

Until a commercial SKU exists, checkout copy must **exclude organisational use
explicitly**. Selling to a company something the software's own licence doesn't
grant them is the worst version of this problem.

## 3. Refunds

- Refunds are processed by **Polar**, the merchant of record.
- A refund deletes the update entitlement. **It does not, and cannot, stop the
  software running** — activation is air-gapped by design.
- Arithmetic worth stating plainly: a 14-day trial, plus a 14-day EU withdrawal
  window, plus perpetual run, is **~28 days of legitimate free use ending in a
  permanent licence**. That follows from the design; price accordingly. ⚖️
- ⚖️ **Withdrawal-right waiver** (Consumer Rights Directive Art. 16(m) / UK CCR
  reg. 37): is it even available given a 14-day trial is *also* offered, and
  does Polar's checkout actually present both the express consent and the
  acknowledgement of losing the right? Verify in the live checkout, not the docs.

## 4. Trial

- **14 days**, from first launch of a gate-active build.
- The clock is a local timestamp with **no anti-rollback**, deliberately
  (ADR-040 §3). Deleting `trial.json` restarts it. This is a soft gate; the
  signed licence is the only hard one.
- Note the gap with the repository licence: [LICENSE](../LICENSE) grants a
  30-day evaluation *and*, separately, unlimited untimed non-production use —
  both broader than the 14-day gate. The reconciliation is that the right to
  **build from source** stays exercisable regardless. Say that where a buyer
  looks, or the difference reads as a bait-and-switch rather than a decision.

## 5. Data and privacy ⚖️

What exists, so a privacy notice can be accurate rather than aspirational:

| Where | What | Notes |
|---|---|---|
| `license.json` on the buyer's device | name, email (inside the signed blob) | The only identity PII Tandem writes to disk. |
| `LEDGER_KV` (Cloudflare, seller-side) | orderId, licenseId, **email, name**, type, dates, delivery/refund flags | The only PII store the seller operates. |
| `LICENSE_KV` (Cloudflare) | updateWindowEnd, status, version | Keyed by an opaque UUID. **No PII.** |
| Update endpoint logs | `{ result, reason, ts }` | No licence id, no IP recorded by us. |
| Resend | delivery of the licence email | Processor. |

Open questions:

- ⚖️ **Lawful basis and retention for `LEDGER_KV`.** Merchant-of-record status
  likely *removes* the usual tax-retention defence: **Polar** carries the
  statutory invoice obligation, so your own books record payouts, not buyers.
- ⚖️ **Erasure (GDPR Art. 17) is already representable.** A redaction tombstone
  keeping `orderId/licenseId/type/createdAt/updateWindowEnd/refunded` and
  dropping identity fields passes `isLedgerRecord` (it accepts empty strings),
  and the code already has tombstone precedent. Because `LICENSE_KV` is
  PII-free, **updates survive erasure** — a good outcome worth stating.
- ⚖️ **Processor agreements and transfer mechanism** for Cloudflare and Resend.
- ⚖️ Whether "no telemetry" survives platform-level request logging at
  Cloudflare. `security.md` now says the honest version: it's a claim about what
  Tandem records, not about what a CDN sees.

> **Ordering constraint for a future resend-my-licence feature:** an
> `email:<hash>` index entry must be deleted **before** the ledger record's email
> is redacted, or it becomes underivable and therefore undeletable.

## 6. Needs counsel — the full list ⚖️

Roughly in priority order:

1. **Paid-licence terms**: transferability, update-window duration, warranty,
   liability, governing law.
2. **`LEDGER_KV` erasure**: lawful basis and retention (§5).
3. **Withdrawal-right waiver** availability alongside a trial (§3).
4. **Pre-contractual disclosure** (CRD Art. 6) of the one-year update window and
   of the licence gate as a technical protection measure. Nothing
   customer-facing states either today.
5. **DCD 2019/770 Art. 8(2)** — are security updates owed past the paid window?
   **Ask early.** The update Worker proxies a *single* manifest and is
   architecturally incapable of serving security-only builds to a
   lapsed-window buyer. That door closes when v1.0 ships.
6. **EU exhaustion / resale** (*UsedSoft*) versus the email's "any device you
   personally use". If a lawful resale requires the buyer to be able to make
   their own copy unusable, that makes copy-key and a remove-licence path
   *required mechanisms*, not conveniences.
7. **BUSL Change Date** ([LICENSE](../LICENSE)) — per-version conversion needs a
   tracking artifact, and on that date the *code* becomes MIT while the shipped
   v1.0 binary still hard-gates. Answering that support ticket requires shipping
   something.

## 7. Documents still to write

- [ ] End-user licence agreement / terms of sale
- [ ] Refund policy (customer-facing wording of §3)
- [ ] Privacy notice (customer-facing wording of §5)
- [ ] Checkout copy excluding organisational use (§2)
