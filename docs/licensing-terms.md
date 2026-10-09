# Tandem licence terms — working draft

_Drafted 2026-08-06 · reviewed 2026-08-13 · no counsel is being consulted; the ⚖️ items are the licensor's decisions (2026-10-09)._

> **Status: DRAFT. Not legal advice, and not yet published.** This file exists
> because nothing did: there is still no EULA, terms of sale, refund policy, or
> privacy notice anywhere in the repository or the product. The README states the
> shape of the v1.0 gate but no terms; the only artifact doing the terms job today
> is nine lines of email body in the issuance Worker.
>
> Everything below is a statement of *what the software actually does*, written
> so that terms can be drafted from it without having to reverse-engineer the
> code, and so that nothing is promised that the implementation doesn't deliver.
> **Items marked ⚖️ are legal decisions the licensor must make before the first sale.**

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
| **Transfer** | Not restricted (left out of the terms by decision, 2026-10-09). |
| **Organisational use** | One natural person's use only, as `LICENSE` defines personal use and individual self-hosting. An employee using Tandem for their own work is inside; a deployment one installation serves to several people is not. See §2. |

Nothing above is live yet: the gate ships **dark** — `LICENSE_GATE_ENABLED` is a
`const false` in `tsup.config.ts`, so today's builds neither trial nor gate. It
flips at v1.0 together with `LICENSE_UPDATE_ENDPOINT` (`src-tauri/src/lib.rs`), and
these terms must exist before it does.

## 2. What a key covers, and what it cannot be sold for — checkout copy must say so ⚖️

The BUSL Additional Use Grant covers personal use and individual self-hosting,
and since 2026-10-09 `LICENSE` defines both: "personal use" is use by one natural
person on documents that person works on, including that person's own paid work
for clients, and "individual self-hosting" is one natural person running Tandem
on a device that person controls, for that person's use only. For v1.0 and later
the grant runs for 14 days from first launch, then for as long as the person holds
a key, and without a key for use that leaves out the AI features.

**Employees are inside** (decision A1, 2026-10-09). The definitions say nothing
about who employs the person or whose documents they are, and the
employee-exclusion sentence the 2026-10-01 review drafted (L6) was not adopted.
So an employee using Tandem on documents they work on for their employer is
personal use. On a plain reading, a key an employer buys for an employee also
works: clause (b) needs only "a license key the Licensor issued", with no "to
you", and A2 left transfer out. That is a reading of the text, not a separate
decision. What stays outside is use that is not one natural person's: one installation serving several people,
or Tandem run as a service for others. That needs a **commercial** licence, and
this pipeline cannot issue one.

The failure mode for that case is worse than a loud error. `issue()` hardcodes
`type = grandfathered ? "grandfathered" : "personal"` and `LedgerRecord["type"]`
admits nothing else, so a commercial purchase would be **silently issued a
`personal` licence** — the code says so itself: *"If a `commercial` SKU is ever
sold through this same webhook it would be silently downgraded to `personal` —
wire an SKU→type map at that milestone."* (`isLedgerRecord` also rejects
`commercial`, but that guard is downstream and unreachable, since nothing can
write such a record in the first place.)

So the buyer would receive a licence whose own metadata contradicts what they
paid for.

Until a commercial SKU exists, checkout copy must say that a key covers **one
natural person**, employees included, and that a shared or hosted deployment is
outside it. Selling a company a shared deployment the software's own licence
doesn't grant is the worst version of this problem.

## 3. Refunds

- Refunds are processed by **Polar**, the merchant of record.
- A refund deletes nothing. The issuance Worker overwrites the key's
  `LICENSE_KV` entitlement with a `revoked` tombstone
  (`{updateWindowEnd: null, status: "revoked"}`) and marks the ledger record
  `refunded`, so the update Worker answers `revoked` and offers no new builds.
  **It does not, and cannot, stop the software running** — activation is
  air-gapped by design — and by decision the licence has no revocation clause
  either (A2, 2026-10-09; Bryan: "if they want a refund it is what it is"). The
  `revoked` label names the update entitlement only, never the right to run.
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
- The repository licence matches the clock. Since 2026-10-09,
  [LICENSE](../LICENSE) grants **14 days** of use for v1.0 and later "from the
  first launch of any such version on a given device, counted once across all
  such versions", which is the one `trial.json` the product keeps across
  versions. The licence still says *device* where the product's clock belongs
  to an app-data directory; that is the deliberate soft gate above.
- After the 14 days, `LICENSE` grants keyless use that leaves out the AI
  features (decision A4). That matches ADR-040's 2026-08-18 amendment
  (unlicensed = an editor with no AI), not the gate merged today, which makes
  documents read-only and keeps chat and Claude's MCP read tools open. Until #1521 lands, the dark build's
  restricted mode and its copy disagree with the licence in both directions.
- One asymmetry is deliberate: every pre-1.0 (beta) version stays free
  for personal use and individual self-hosting with no time limit, including
  the releases that shipped under an earlier wording, so someone can keep
  running a beta build indefinitely.
  Say that where a buyer looks, so it reads as a decision rather than a
  loophole. (Decision D on #1827 keeps an older server from sharing the
  desktop's data directory; it does not revoke the beta grant.)

## 5. Data and privacy ⚖️

What exists, so a privacy notice can be accurate rather than aspirational:

| Where | What | Notes |
|---|---|---|
| `license.json` on the buyer's device | name, email (inside the signed blob) | The only identity PII Tandem writes to disk. |
| `LEDGER_KV` (Cloudflare, seller-side) | orderId, licenseId, **email, name**, type, dates, delivery/refund flags | The only PII store the seller operates. |
| `LICENSE_KV` (Cloudflare) | updateWindowEnd, status, version | Keyed by an opaque UUID. **No PII.** |
| Update endpoint logs | `{ result, reason, ts }` | No licence id, no IP recorded by us. Retained by our own Cloudflare `[observability]` configuration, so the operator can detect a missing entitlement without waiting for a report. |
| Resend | delivery of the licence email | Processor. |

Open questions:

- **Retention for `LEDGER_KV` — decided 2026-10-09 (B5).** The buyer's name and
  email are kept for as long as keys are reissued, because a reissue needs them,
  and erased on request. Merchant-of-record status removes the usual
  tax-retention reason: **Polar** carries the statutory invoice obligation, so
  your own books record payouts, not buyers. ⚖️ The lawful basis for the
  privacy notice is still to be stated.
- **Erasure (GDPR Art. 17) is already representable, and is the B5 erasure
  path.** A redaction tombstone
  keeping `orderId/licenseId/type/createdAt/updateWindowEnd/refunded` and
  dropping identity fields passes `isLedgerRecord` (it accepts empty strings),
  and the code already has tombstone precedent. Because `LICENSE_KV` is
  PII-free, **updates survive erasure** — a good outcome worth stating.
- ⚖️ **Processor agreements and transfer mechanism** for Cloudflare and Resend.
- ⚖️ Whether "no telemetry" survives platform-level request logging at
  Cloudflare. `security.md` says the honest version: it's a claim about what
  Tandem records, not about what a CDN sees. Two halves, and only one is
  settled. **Ours:** the retained line is `{ result, reason, ts }` and carries no
  licence id — that is our configuration and it is pinned by tests. **Theirs:**
  what Cloudflare's own invocation record holds has never been read against a
  live deployment, and it matters here because the licence id travels in a
  request header. `docs/licensing-operations.md` §8 carries that as a
  pre-launch verification, with the two responses if it turns out to hold
  headers.

> **Ordering constraint for a future resend-my-licence feature:** an
> `email:<hash>` index entry must be deleted **before** the ledger record's email
> is redacted, or it becomes underivable and therefore undeletable.

## 6. Open legal questions — the full list ⚖️

Roughly in priority order:

1. **Paid-licence terms**: update-window duration, warranty, liability,
   governing law. *Transferability decided 2026-10-09 (A2): not restricted, and
   left out of the terms (Bryan: "im fine with transfers, leave it out").*
2. **`LEDGER_KV` erasure**: lawful basis. *Retention decided 2026-10-09 (B5):
   kept while keys are reissued, erased on request (§5).*
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
   *required mechanisms*, not conveniences. Transfer itself is no longer a
   question: the terms leave it unrestricted (A2), so this item is only about
   whether the remove-licence path (#1943) is required.
7. **BUSL Change Date** ([LICENSE](../LICENSE)) — *decided 2026-10-09 (A6):*
   four years from the date each version is first made publicly available, and
   a version is a release on the repository's Releases page, so that release's
   publication date is the tracking record. (Reading "first made publicly
   available" as the earlier of the release and its tag is the conservative
   reading; the decision does not settle it.) Still open: on that date the
   *code* becomes MIT while the shipped v1.0 binary still hard-gates. Answering that support ticket
   requires shipping something.

## 7. Documents still to write

- [ ] End-user licence agreement / terms of sale
- [ ] Refund policy (customer-facing wording of §3)
- [ ] Privacy notice (customer-facing wording of §5)
- [ ] Checkout copy stating that a key covers one natural person, employees included, and not a shared or hosted deployment (§2)
