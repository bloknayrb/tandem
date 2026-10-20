/**
 * Tandem license ISSUANCE endpoint (Cloudflare Worker) — the public seam that
 * turns a completed Paddle Billing transaction into an Ed25519-signed license
 * (#1116, ADR-040; Paddle replaced Polar as merchant of record on 2026-10-17).
 *
 * This replaced the loopback-only server handler `src/server/license/webhook.ts`,
 * which no merchant could reach. That handler is now deleted; issuance happens
 * here and nowhere else. The one remaining out-of-band minting path is the
 * operator's own `scripts/sign-license.ts`.
 *
 * Design mirrors the sibling `infra/license-update-worker/`: a pure
 * `handleIssuance(request, deps)` with ALL I/O injected, so the whole flow runs
 * under vitest with a mock KV, a mock mailer, and a real generated Ed25519 key —
 * no Cloudflare runtime needed — plus a thin `default { fetch }` that wires the
 * real bindings.
 *
 * Security posture (see the design review folded into this file):
 *  - `Paddle-Signature` (HMAC-SHA256 over `ts:body`) verified BEFORE any parse
 *    or side effect.
 *  - Fail-closed status mapping, in gate order: non-POST → 405; missing
 *    secret/key → 503; oversized body or missing header → 400; bad signature /
 *    stale timestamp → 401, never alerted (anyone can send one). A validly
 *    signed but unusable payload is `dropped`: Paddle signed it, so it is
 *    schema drift, not an attacker.
 *  - Three idempotency layers: per-attempt timestamp freshness, an `event_id`
 *    completion set (blocks replays of fully-processed events), and the durable
 *    transaction ledger (blocks re-mint; drives retry-based recovery). `issue()`
 *    and `revoke()` each re-read the ledger immediately before their first
 *    commit (see the "pre-commit recheck" comments below) so a same-transaction
 *    write from a concurrent request — another `transaction.completed`
 *    delivery, or an `adjustment.*` racing it — is deferred to instead of
 *    blindly overwritten. This SHRINKS the window (from the whole request, including
 *    async Ed25519 signing, down to one KV round trip) but Workers KV has no
 *    compare-and-swap, so it does not make the pair atomic: two requests that
 *    are truly simultaneous through both reads can still both commit (a
 *    double-mint, or a mint that lands after a refund's tombstone recheck).
 *    Closing that residual gap needs a Durable Object per transaction — accepted
 *    as a follow-up (see README). Every license minted is indexed under
 *    `txnlic:` so a refund revokes a double mint too.
 *  - PII (the buyer's email) lives ONLY in the issuance-owned ledger KV, never in the
 *    entitlement KV the update Worker reads. Logs carry `{ result, ts }` plus a
 *    non-PII failure `stage` on errors — never an email or license id. The HTTP
 *    response NEVER contains the blob (that would leak it into Paddle's
 *    notification logs); it reaches the buyer by email alone. Paddle's webhook
 *    carries no buyer email, so it is fetched from `GET /customers/{id}` with a
 *    `customer.read` API key.
 */

import {
  importPkcs8Ed25519,
  keyIdOfPkcs8Ed25519,
  type SignBytes,
  signLicense,
  verifyPaddleSignature,
  webCryptoSigner,
} from "./crypto.js";

/** License schema version baked into signed metadata. Drift changes the signed
 * bytes, so keep it in lockstep with the server (`webhook.ts` used "1.0"). */
export const LICENSE_VERSION = "1.0";

/** Ids of the signing keys shipped builds trust: a copy of the ids of
 * `TRUSTED_PUBLIC_KEYS` in src/server/license/public-key.ts (this Worker cannot
 * import from `src/`). A parity test keeps the two equal, so a new key is added
 * to both in one commit. The Worker refuses to sign with a key not listed here.
 * Rotation order: docs/licensing-operations.md §0. */
export const TRUSTED_KEY_IDS: readonly string[] = ["c24dd9f66f449a56"];

// What the fetch handler checks against. Tests sign with throwaway keys (the
// production private key is never in CI), so they swap the list through
// `_setTrustedKeyIdsForTests`; production never touches it.
let trustedKeyIds: readonly string[] = TRUSTED_KEY_IDS;

/** Test-only: replace the trusted list; call with no argument to restore it. */
export function _setTrustedKeyIdsForTests(ids: readonly string[] = TRUSTED_KEY_IDS): void {
  trustedKeyIds = ids;
  signerCache = null;
}

/** `Paddle-Signature` freshness tolerance. Paddle's SDK uses 5 s; 300 s allows
 * for clock skew. Whether a retry or a dashboard replay carries a FRESH `ts` is
 * unverified (U1, docs/licensing-operations.md §8) and is a deploy gate: if it
 * keeps the original, widen this to 4 days and lean on the `evt:` marker and
 * the ledger for replay defence. */
export const TIMESTAMP_TOLERANCE_S = 300;
/** TTL for the `event_id` completion marker: Paddle's live retry span is 60
 * attempts over 3 days, plus a day. A late marker miss is harmless — the
 * transaction ledger still answers `duplicate` without re-minting or
 * re-emailing. */
export const EVENT_TTL_S = 4 * 24 * 60 * 60;

/** Linked from the license email; paths agreed with the tandem-website pages. */
const TERMS_URL = "https://tandem.ink/terms";
const REFUND_POLICY_URL = "https://tandem.ink/refunds";
const PADDLE_BUYER_SUPPORT_URL = "https://paddle.net";

const MAX_EMAIL_LEN = 254; // RFC 5321
/** Paddle's documented `transaction.completed` example is large (U8: measure a
 * real one); 256 KiB leaves headroom. This is defense-in-depth
 * against forcing an unauthenticated caller's oversized body through HMAC +
 * JSON.parse before the signature check can reject it (the secret is not
 * needed to reach the body-read line). */
const MAX_BODY_BYTES = 262_144;
/** The on-device verifier rejects a decoded blob whose length exceeds 4096
 * (`verifier.ts`, measured on the decoded string). Our `>=`-on-bytes check is
 * deliberately stricter (UTF-8 bytes ≥ UTF-16 units), so no blob that passes
 * here can fail on-device. We must never email a blob the buyer's own client
 * can't verify. */
const MAX_BLOB_DECODED_BYTES = 4096;

/** Minimal structural view of the Workers execution context. Declared locally
 *  (same convention as `KvNamespace` below) so this file needs no ambient
 *  Cloudflare types to typecheck alongside the rest of the repo. */
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Minimal structural view of a Cloudflare KV namespace (read + write). */
export interface KvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: {
    prefix: string;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

/** Coarse, closed result enum for logging. `settled` = an authenticated
 * adjustment that needs no action; `noticed` = an authenticated event a human
 * must act on (a durable `notice:` record is written first). */
export type ResultKind =
  | "issued"
  | "duplicate"
  | "revoked"
  | "ignored"
  | "settled"
  | "noticed"
  | "dropped"
  | "rejected"
  | "error";

export type FailStage =
  | "config"
  | "config-support-email"
  | "config-resend-from"
  | "config-paddle-api-key"
  | "config-price-ids"
  | "config-env-mismatch"
  | "config-sandbox-until"
  | "config-sandbox-buyers"
  | "email"
  | "paddle-api"
  | "paddle-api-auth"
  | "delivery-check"
  | "notice-write"
  | "blob-size"
  | "ledger"
  | "unexpected";

export type NoticeStage =
  | "api-key-expiry"
  | "refund-partial"
  | "credit-partial"
  | "credit-reverse"
  | "chargeback-reverse"
  | "adjustment-reversed"
  | "dropped";

interface Failure {
  stage: FailStage;
  status?: number;
}

export interface Notice {
  notice: NoticeStage;
  ref: string;
  txnId?: string;
}

export interface LogEntry {
  result: ResultKind;
  ts: number;
  stage?: FailStage;
  /** Upstream HTTP status (email stage only). */
  status?: number;
  notice?: NoticeStage;
  ref?: string;
}

/** What issue()/revoke() produce. */
type EventOutcome = Exclude<ResultKind, "rejected" | "error" | "noticed"> | Failure | Notice;

export type CustomerLookup = { ok: true; email: unknown } | { ok: false; status?: number };

export interface IssuanceDeps {
  webhookSecret: string;
  signBytes: SignBytes;
  /** The id of the key behind `signBytes`, stamped into every license. Derived
   * from the key (`keyIdOfPkcs8Ed25519`), never configured, so the two cannot
   * disagree. */
  keyId: string;
  /** licenseId → LicenseEntitlement; read by the update Worker. NO PII. */
  entitlementKv: KvNamespace;
  /** issuance-owned store: `order:`, `evt:`, `notice:`, `txnlic:` keys. */
  ledgerKv: KvNamespace;
  sendEmail: (to: string, blob: string) => Promise<{ ok: boolean; status?: number }>;
  isGrandfathered: (email: string) => boolean;
  /** Whether `GRANDFATHER_EMAILS` has any entry. When it has none, a free
   * order is ignored before the customer lookup, so a leaked 100% code cannot
   * drive Paddle API traffic. */
  hasGrandfathers: boolean;
  /** Set only on a Worker holding a `pdl_sdbx_` key: the lower-cased buyer
   * emails it may mint for (`SANDBOX_BUYER_EMAILS`). Anyone else is ignored. */
  sandboxBuyers?: ReadonlySet<string>;
  /** Paddle `GET /customers/{id}`. */
  lookupCustomer: (customerId: string) => Promise<CustomerLookup>;
  /** Parsed `PADDLE_PRICE_IDS`. */
  priceIds: readonly string[];
  isTest: boolean;
  now: () => number;
  newLicenseId: () => string;
  toleranceS?: number;
  log?: (entry: LogEntry) => void;
}

/** Durable ledger record. Carries the fields needed to re-sign an identical
 * blob on a retry/resend (Ed25519 is deterministic per RFC 8032 — a randomized
 * scheme would break the resend story; across a signing-key rotation a resend
 * is re-signed under the CURRENT key, so it differs from the original but is
 * equally valid — after a leak, deliberately so) plus dedup/refund bookkeeping — no
 * separate copy of the signature. A refund that arrives before the paid event
 * writes a TOMBSTONE: `refunded: true` with empty licenseId/email. No `name`
 * (docs/licensing-operations.md §0, decision 2): a record written before that
 * change still carries one, and parses, because extra fields are tolerated. */
interface LedgerRecord {
  orderId: string;
  licenseId: string;
  email: string;
  type: "personal" | "grandfathered";
  createdAt: string;
  updateWindowEnd: string | null;
  emailSent: boolean;
  refunded: boolean;
}

// ---------------------------------------------------------------------------
// Mode-scoped ledger keys. EVERY ledger key carries the test/live mode segment
// so a sandbox and a production event can never cross-suppress if they share a
// KV namespace — new key kinds must go through these builders.
// ---------------------------------------------------------------------------

const modeOf = (isTest: boolean): string => (isTest ? "test" : "live");
const orderKeyOf = (isTest: boolean, orderId: string): string =>
  `order:${modeOf(isTest)}:${orderId}`;
const evtKeyOf = (isTest: boolean, eventId: string): string => `evt:${modeOf(isTest)}:${eventId}`;
const noticeKeyOf = (isTest: boolean, stage: NoticeStage, ref: string): string =>
  `notice:${modeOf(isTest)}:${stage}:${ref}`;
const txnLicPrefixOf = (isTest: boolean, txnId: string): string =>
  `txnlic:${modeOf(isTest)}:${txnId}:`;

/** A ledger record that exists but can't be parsed/validated. Surfaces as a
 * retryable 500 with `stage: "ledger"` — NEVER as a silent re-mint (a corrupt
 * record must not look like "no record", or a refunded order could re-issue and
 * a duplicate could double-mint). */
class LedgerCorruptError extends Error {}

function isLedgerRecord(v: unknown): v is LedgerRecord {
  const r = v as LedgerRecord | null;
  return (
    typeof r?.orderId === "string" &&
    typeof r.licenseId === "string" &&
    typeof r.email === "string" &&
    (r.type === "personal" || r.type === "grandfathered") &&
    typeof r.createdAt === "string" &&
    (r.updateWindowEnd === null || typeof r.updateWindowEnd === "string") &&
    typeof r.emailSent === "boolean" &&
    typeof r.refunded === "boolean"
  );
}

/** Read an order's ledger record; null when absent; LedgerCorruptError when
 * present but unparsable/shape-invalid (→ retryable 500, never a re-mint). */
async function readOrder(deps: IssuanceDeps, orderId: string): Promise<LedgerRecord | null> {
  const raw = await deps.ledgerKv.get(orderKeyOf(deps.isTest, orderId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LedgerCorruptError();
  }
  if (!isLedgerRecord(parsed)) throw new LedgerCorruptError();
  return parsed;
}

function writeOrder(deps: IssuanceDeps, rec: LedgerRecord): Promise<void> {
  // A record written before 2026-10-20 may still carry the buyer's `name`.
  // Re-saving it (re-drive, refund) drops the field, so the ledger only ever
  // shrinks toward holding no name (docs/data-locations.md).
  const { name: _legacyName, ...clean } = rec as LedgerRecord & { name?: unknown };
  return deps.ledgerKv.put(orderKeyOf(deps.isTest, rec.orderId), JSON.stringify(clean));
}

// ---------------------------------------------------------------------------
// Input hygiene. Emails are identity → rejected (not silently truncated) when
// implausible.
// ---------------------------------------------------------------------------

/** C0 controls + DEL, as \u escapes so the source carries no control bytes. */

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

// Minimal structural check (one "@", a non-empty local + domain part, a dot
// somewhere in the domain not at either end) — not full RFC 5322. Paddle is the
// identity authority here; this only guards against schema drift producing an
// obviously-unusable string, not against a legitimate-but-unusual address.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(raw: unknown): string | null {
  const e = (typeof raw === "string" ? raw : "").replace(CONTROL_CHARS, "").replace(/\s+/g, "");
  if (!e || e.length > MAX_EMAIL_LEN || !EMAIL_SHAPE.test(e)) return null;
  return e;
}

function entitlementValue(rec: LedgerRecord): string {
  return JSON.stringify({
    updateWindowEnd: rec.updateWindowEnd,
    status: rec.type,
    version: LICENSE_VERSION,
  });
}

function metadataFrom(rec: LedgerRecord, keyId: string) {
  return {
    id: rec.licenseId,
    email: rec.email,
    type: rec.type,
    createdAt: rec.createdAt,
    expiresAt: rec.updateWindowEnd,
    version: LICENSE_VERSION,
    keyId,
  };
}

// ---------------------------------------------------------------------------
// transaction.completed → mint (or idempotently re-drive) a license.
// ---------------------------------------------------------------------------

/** Re-assert entitlement / resend a stuck email for an order that ALREADY has
 * a ledger record — used both for a genuine redelivery and for a fresh-mint
 * attempt that lost a race (see the pre-commit recheck in `issue()` below). If
 * a refund already revoked the order, this is the tiebreaker: never resurrect
 * or re-email. */
async function reDrive(existing: LedgerRecord, deps: IssuanceDeps): Promise<EventOutcome> {
  if (existing.refunded) return "duplicate";
  if (!deps.isTest) {
    await deps.entitlementKv.put(existing.licenseId, entitlementValue(existing)); // idempotent re-assert
  }
  if (!existing.emailSent) {
    const blob = await signLicense(metadataFrom(existing, deps.keyId), deps.signBytes);
    const sent = await deps.sendEmail(existing.email, blob);
    if (!sent.ok) return { stage: "email", status: sent.status };
    existing.emailSent = true;
    // NOTE: if this write itself fails, the exception below collapses to a
    // retryable 500 with `emailSent` still false on disk — a retry re-sends
    // the same (deterministic) blob rather than losing it. Accepted:
    // duplicate delivery of a customer's own license is harmless, unlike a
    // silently-dropped one.
    await writeOrder(deps, existing);
  }
  return "duplicate";
}

// Paddle ids are a prefix plus 26 lower-case characters. The 64 bound keeps
// every KV key built from them far below KV's 512-byte limit, so a drifted id
// can never loop as a 500 on an over-long key.
const TXN_ID = /^txn_[a-z0-9]{1,64}$/;
const CTM_ID = /^ctm_[a-z0-9]{1,64}$/;
const ADJ_ID = /^adj_[a-z0-9]{1,64}$/;
const EVT_ID = /^evt_[a-z0-9]{1,64}$/;
const APIKEY_ID = /^apikey_[a-z0-9]{1,64}$/;

/** The transaction a payload is about — the ledger key both `issue()` and
 * `revoke()` derive everything else from. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function txnIdOf(eventType: string, data: any): string | null {
  const raw =
    eventType === "transaction.completed"
      ? data?.id
      : eventType.startsWith("adjustment.")
        ? data?.transaction_id
        : undefined;
  return typeof raw === "string" && TXN_ID.test(raw) ? raw : null;
}

/** Paddle `details.totals.*` are strings of integer minor units. */
function parseMinor(v: unknown): number | null {
  return typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function issue(data: any, deps: IssuanceDeps, nowMs: number): Promise<EventOutcome> {
  // 1.
  const txnId = txnIdOf("transaction.completed", data);
  if (!txnId) return "dropped";
  // 2.
  if (data?.status !== "completed") return "dropped";
  // 3. Ledger read before anything only the FIRST delivery needs: a redelivery
  // must re-drive even if its price was since removed from PADDLE_PRICE_IDS
  // (the kill switch) or the customer lookup would now fail.
  const existing = await readOrder(deps, txnId);
  if (existing) return reDrive(existing, deps);
  // 4. Totals. Never `balance` (reads 0 on a completed transaction). Unparseable
  // is dropped, not "paid": failing open would let a leaked 100% code mint.
  const grand = parseMinor(data?.details?.totals?.grand_total);
  const total = parseMinor(data?.details?.totals?.total);
  if (grand === null || total === null) return "dropped";
  const free = grand <= 0 && total <= 0;
  // 5. Price scope. A Paddle.js checkout takes a public client token plus ANY
  // active price id, so without this a leftover test price would mint
  // perpetual licenses. One transaction mints one license whatever the quantity.
  // A FREE out-of-scope order is ignored rather than dropped: nobody paid, and
  // a drop's record and alert per free checkout would let anyone holding the
  // client token drain the Resend quota that delivers licenses.
  const items = data?.items;
  if (
    !Array.isArray(items) ||
    items.length === 0 ||
    !items.every(
      (it: any) => typeof it?.price?.id === "string" && deps.priceIds.includes(it.price.id),
    )
  ) {
    return free ? "ignored" : "dropped";
  }
  // 6.
  const customerId = data?.customer_id;
  if (typeof customerId !== "string" || !CTM_ID.test(customerId)) return "dropped";
  // 7. A leaked 100% code cannot drive Paddle API traffic.
  if (free && !deps.hasGrandfathers) return "ignored";
  // 8. Buyer lookup.
  const found = await deps.lookupCustomer(customerId);
  if (!found.ok) {
    // A missing customer or a request Paddle calls malformed won't fix itself
    // on retry → dropped. Auth, rate limiting, outages, network errors and any
    // other status (1xx/3xx, an unparseable 200) are retried via a 500.
    const s = found.status;
    if (s === undefined) return { stage: "paddle-api" };
    if (s === 401 || s === 403) return { stage: "paddle-api-auth", status: s };
    if (s >= 400 && s < 500 && s !== 408 && s !== 429) return "dropped";
    return { stage: "paddle-api", status: s };
  }
  const email = cleanEmail(found.email);
  if (!email) return "dropped";
  // A sandbox Worker signs with the PRODUCTION key, so anyone holding the
  // sandbox client token and the 4242 test card would otherwise get a real,
  // permanent run license while SANDBOX_SIGNING_UNTIL is open.
  if (deps.sandboxBuyers && !deps.sandboxBuyers.has(email.toLowerCase())) return "ignored";
  // 9. Free-order gate, now that the email is known.
  const grandfathered = deps.isGrandfathered(email);
  if (free && !grandfathered) return "ignored";

  // 10. Fresh issuance.
  const licenseId = deps.newLicenseId();
  const type: LedgerRecord["type"] = grandfathered ? "grandfathered" : "personal";
  const rec: LedgerRecord = {
    orderId: txnId,
    licenseId,
    email,
    type,
    createdAt: new Date(nowMs).toISOString(),
    updateWindowEnd: null,
    emailSent: false,
    refunded: false,
  };

  const blob = await signLicense(metadataFrom(rec, deps.keyId), deps.signBytes);
  const padding = blob.endsWith("==") ? 2 : blob.endsWith("=") ? 1 : 0;
  if ((blob.length / 4) * 3 - padding >= MAX_BLOB_DECODED_BYTES) return { stage: "blob-size" };

  const recheck = await readOrder(deps, txnId);
  if (recheck) return reDrive(recheck, deps);

  // Index BEFORE the ledger, so the index is always a superset of it. A slow
  // first request plus a retry can both pass the recheck and both mint; the
  // index is what lets a later refund revoke both.
  await deps.ledgerKv.put(`${txnLicPrefixOf(deps.isTest, txnId)}${licenseId}`, "");
  await writeOrder(deps, rec);
  if (!deps.isTest) await deps.entitlementKv.put(licenseId, entitlementValue(rec));

  const sent = await deps.sendEmail(email, blob);
  if (!sent.ok) return { stage: "email", status: sent.status };
  rec.emailSent = true;
  await writeOrder(deps, rec);
  return "issued";
}

const REVOKED_VALUE = JSON.stringify({ updateWindowEnd: null, status: "revoked" });

/** Every licenseId minted for a transaction: the `txnlic:` index, listed to
 * completion. */
async function indexedLicenseIds(deps: IssuanceDeps, txnId: string): Promise<string[]> {
  const prefix = txnLicPrefixOf(deps.isTest, txnId);
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.ledgerKv.list(cursor === undefined ? { prefix } : { prefix, cursor });
    for (const k of page.keys) ids.push(k.name.slice(prefix.length));
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return ids;
}

async function applyRefund(rec: LedgerRecord, deps: IssuanceDeps): Promise<EventOutcome> {
  // Ledger flag FIRST: a concurrent redelivery that reads the record between
  // the two writes then sees `refunded` and declines to re-drive, instead of
  // writing the live entitlement back over the tombstone. If an entitlement
  // write below fails, the retry finds the flag and revokes again.
  rec.refunded = true;
  await writeOrder(deps, rec);
  if (!deps.isTest) {
    const ids = new Set(await indexedLicenseIds(deps, rec.orderId));
    if (rec.licenseId) ids.add(rec.licenseId);
    for (const id of ids) {
      if (id) await deps.entitlementKv.put(id, REVOKED_VALUE);
    }
  }
  return "revoked";
}

const ADJ_ACTIONS = new Set([
  "refund",
  "credit",
  "chargeback",
  "chargeback_warning",
  "chargeback_reverse",
  "chargeback_warning_reverse",
  "credit_reverse",
]);
const ADJ_STATUSES = new Set(["pending_approval", "approved", "rejected", "reversed"]);
const ADJ_TYPES = new Set(["full", "partial"]);

async function revoke(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any,
  deps: IssuanceDeps,
  nowMs: number,
  fallbackRef: string,
): Promise<EventOutcome> {
  const data = payload?.data;
  const { action, status, type } = data ?? {};
  // First match wins, in this order. An undocumented enum value is schema
  // drift, never a decision.
  if (!ADJ_ACTIONS.has(action) || !ADJ_STATUSES.has(status) || !ADJ_TYPES.has(type)) {
    return "dropped";
  }
  const txnId = txnIdOf(payload.event_type, data);
  if (!txnId) return "dropped";
  const ref = typeof data?.id === "string" && ADJ_ID.test(data.id) ? data.id : fallbackRef;
  const notice = (n: NoticeStage): Notice => ({ notice: n, ref, txnId });

  if (status === "pending_approval" || status === "rejected") return "settled";
  // A reversal never re-revokes, whatever the action: a won dispute is
  // restored by hand (ops §7).
  if (status === "reversed") return notice("adjustment-reversed");
  if (status !== "approved") return "dropped";
  // Approved. Partials keep the license and leave a notice (Bryan, 2026-10-18):
  // an automatic revoke-at-full needs an accumulator KV cannot keep safely.
  // Revoking here tombstones the UPDATE entitlement only; the run license the
  // buyer holds keeps working, as the Terms say.
  let full = false;
  switch (action) {
    case "refund":
      if (type === "partial") return notice("refund-partial");
      full = true;
      break;
    case "credit":
      if (type === "partial") return notice("credit-partial");
      full = true;
      break;
    case "chargeback":
      full = true;
      break;
    case "chargeback_warning":
    case "chargeback_warning_reverse":
      return "settled";
    case "chargeback_reverse":
      return notice("chargeback-reverse");
    case "credit_reverse":
      return notice("credit-reverse");
  }
  if (!full) return "dropped";

  const rec = await readOrder(deps, txnId);
  if (rec) return applyRefund(rec, deps);
  const recheck = await readOrder(deps, txnId);
  if (recheck) return applyRefund(recheck, deps);

  const tombstone: LedgerRecord = {
    orderId: txnId,
    licenseId: "",
    email: "",
    type: "personal",
    createdAt: new Date(nowMs).toISOString(),
    updateWindowEnd: null,
    emailSent: true,
    refunded: true,
  };
  await writeOrder(deps, tombstone);
  return "revoked";
}

// ---------------------------------------------------------------------------
// Pure request handler.
// ---------------------------------------------------------------------------

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ ok: status < 400 }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A `dropped` record's ref is normally the `event_id`, but a non-JSON or
 * `event_id`-less payload has none. Fall back to a digest of the signed body,
 * which a replay reproduces, so the record stays idempotent. */
async function bodyRef(rawBody: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody));
  return `body_${[...new Uint8Array(d).subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function handleIssuance(request: Request, deps: IssuanceDeps): Promise<Response> {
  const nowMs = deps.now();
  const ts = Math.floor(nowMs / 1000);
  const reply = (status: number, result: ResultKind, extra?: Failure | Notice): Response => {
    const entry: LogEntry = { result, ts };
    if (extra && "stage" in extra) {
      entry.stage = extra.stage;
      if (extra.status !== undefined) entry.status = extra.status;
    }
    if (extra && "notice" in extra) {
      entry.notice = extra.notice;
      entry.ref = extra.ref;
    }
    deps.log?.(entry);
    return jsonResponse(status);
  };
  try {
    if (request.method !== "POST") return reply(405, "rejected");
    if (!deps.webhookSecret) return reply(503, "error", { stage: "config" });

    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return reply(400, "rejected");
    }
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) return reply(400, "rejected");

    const sigHeader = request.headers.get("paddle-signature");
    if (!sigHeader) return reply(400, "rejected");
    const ok = await verifyPaddleSignature(
      sigHeader,
      rawBody,
      deps.webhookSecret,
      nowMs,
      deps.toleranceS ?? TIMESTAMP_TOLERANCE_S,
    );
    if (!ok) return reply(401, "rejected");

    // Every notice and every drop leaves a durable record BEFORE the 200 reply,
    // because Paddle will not retry a 200 and the alert is best-effort. A
    // failed write is a 500 (alertable), so Paddle retries; the put is
    // idempotent. Ids only, no PII.
    const writeNotice = (n: Notice, eventType: unknown) =>
      deps.ledgerKv.put(
        noticeKeyOf(deps.isTest, n.notice, n.ref),
        JSON.stringify({
          stage: n.notice,
          ...(n.txnId ? { txnId: n.txnId } : {}),
          eventType: typeof eventType === "string" ? eventType : null,
          at: new Date(nowMs).toISOString(),
        }),
      );
    // A drop stays unmarked so a replay after the operator fixes the cause
    // still works.
    const drop = async (
      ref: string,
      eventType: unknown,
      txnId?: string | null,
    ): Promise<Response> => {
      const n: Notice = { notice: "dropped", ref, ...(txnId ? { txnId } : {}) };
      try {
        await writeNotice(n, eventType);
      } catch {
        return reply(500, "error", { stage: "notice-write" });
      }
      return reply(200, "dropped", n);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return drop(await bodyRef(rawBody), null);
    }
    const eventType = payload?.event_type;
    const eventId = payload?.event_id;
    if (typeof eventId !== "string" || eventId === "") {
      return drop(await bodyRef(rawBody), eventType);
    }
    const eventRef = EVT_ID.test(eventId) ? eventId : await bodyRef(rawBody);
    if (typeof eventType !== "string") return drop(eventRef, eventType);

    // eventRef, not the raw id: an id outside the documented shape could be
    // long enough to exceed KV's key limit and 500 on every retry.
    const evtKey = evtKeyOf(deps.isTest, eventRef);
    if ((await deps.ledgerKv.get(evtKey)) === "done") return reply(200, "duplicate");

    let outcome: EventOutcome;
    if (eventType === "transaction.completed") {
      outcome = await issue(payload.data, deps, nowMs);
    } else if (eventType === "adjustment.created" || eventType === "adjustment.updated") {
      outcome = await revoke(payload, deps, nowMs, eventRef);
    } else if (eventType === "api_key.expiring" || eventType === "api_key.expired") {
      const id = payload?.data?.id;
      outcome = {
        notice: "api-key-expiry",
        ref: typeof id === "string" && APIKEY_ID.test(id) ? id : eventRef,
      };
    } else {
      await deps.ledgerKv.put(evtKey, "done", { expirationTtl: EVENT_TTL_S });
      return reply(200, "ignored");
    }

    // Notice before Failure: both are objects, and a Notice routed to the
    // Failure arm would reply 500 to an event that needs no retry.
    if (typeof outcome !== "string" && "notice" in outcome) {
      try {
        await writeNotice(outcome, eventType);
      } catch {
        return reply(500, "error", { stage: "notice-write" });
      }
      await deps.ledgerKv.put(evtKey, "done", { expirationTtl: EVENT_TTL_S });
      return reply(200, "noticed", outcome);
    }
    if (typeof outcome !== "string") return reply(500, "error", outcome);
    if (outcome === "dropped") return drop(eventRef, eventType, txnIdOf(eventType, payload.data));

    if (
      outcome === "issued" ||
      outcome === "duplicate" ||
      outcome === "revoked" ||
      outcome === "settled"
    ) {
      await deps.ledgerKv.put(evtKey, "done", { expirationTtl: EVENT_TTL_S });
    }
    return reply(200, outcome);
  } catch (err) {
    return reply(500, "error", {
      stage: err instanceof LedgerCorruptError ? "ledger" : "unexpected",
    });
  }
}

// ---------------------------------------------------------------------------
// Cloudflare entry point — wires real bindings. Config failures fail closed.
// ---------------------------------------------------------------------------

interface WorkerEnv {
  PADDLE_WEBHOOK_SECRET: string;
  /** `pdl_live_apikey_…` / `pdl_sdbx_apikey_…`, scope `customer.read` (+ the
   *  notification read scopes for the scheduled delivery check). */
  PADDLE_API_KEY?: string;
  /** Comma-separated `pri_…` ids this Worker may mint for. REQUIRED. */
  PADDLE_PRICE_IDS?: string;
  /** Full ISO timestamp with a zone, ≤ 7 days ahead; REQUIRED on any Worker
   *  holding a `pdl_sdbx_` key (`sandboxSigningAllowed`). */
  SANDBOX_SIGNING_UNTIL?: string;
  TANDEM_PRIVATE_KEY: string; // PEM PKCS#8
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  /** Monitored inbox used as the license email's `reply_to` and named in its
   *  body. Keep in sync with TANDEM_SUPPORT_EMAIL in src/shared/constants.ts.
   *  REQUIRED: validated at the top of every request (see `supportEmailProblem`)
   *  and a bad value fails the Worker closed rather than emailing a buyer. */
  SUPPORT_EMAIL: string;
  TANDEM_ISSUANCE_ENV?: string; // "sandbox" | "production" (default production)
  LICENSE_KV: KvNamespace; // SAME namespace the update Worker reads
  LEDGER_KV: KvNamespace; // issuance-owned; holds PII
  GRANDFATHER_EMAILS?: string; // comma/space-separated, optional
  /** Required with a `pdl_sdbx_` key: the only buyers a sandbox Worker mints for. */
  SANDBOX_BUYER_EMAILS?: string;
  /** Incoming-webhook URL (Slack/Discord/ntfy) for operator alerts. Required to
   *  be alerted about EMAIL failures — those can't go through Resend. */
  ALERT_WEBHOOK_URL?: string;
  /** Operator inbox for non-email-stage alerts, sent via Resend. */
  ALERT_EMAIL?: string;
}

// Isolate-scope caches, keyed on the raw env value: Workers reuse module state
// across requests on the same isolate, so the Ed25519 import and grandfather
// Set are built once per isolate (and rebuilt if a secret rotates). A failed
// key import is never cached — it re-attempts (and 503s) per request.
let signerCache: { pem: string; signBytes: SignBytes; keyId: string } | null = null;
let grandfatherCache: { raw: string; set: Set<string> } | null = null;

function emailSetOf(raw: string): Set<string> {
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((e) => e.toLowerCase().trim())
      .filter(Boolean),
  );
}

function grandfatherSetOf(raw: string): Set<string> {
  if (grandfatherCache?.raw !== raw) grandfatherCache = { raw, set: emailSetOf(raw) };
  return grandfatherCache.set;
}

/**
 * Wrap the blob so no line exceeds `width` characters.
 *
 * This is delivery correctness, not cosmetics. A 484-character unbroken line is
 * what pushes a mail transfer agent to re-encode the body as quoted-printable,
 * whose soft line break (`=` at end of line) base64 reads as padding — silently
 * TRUNCATING the key.
 *
 * `width` is 72, deliberately **below** the quoted-printable line limit rather
 * than at it. QP's 76 counts the trailing `=` itself, so wrapping at exactly 76
 * still leaves lines an encoder wants to break. 72 is the long-standing safe
 * mail width and leaves headroom.
 *
 * Wrapping alone is not sufficient — see `licenseEmailText`, which also keeps
 * the body pure 7-bit ASCII so an encoder has no reason to reach for QP at all.
 * And even that is belt-and-braces: the receiving end repairs soft breaks
 * (`normalizePastedLicense`), and the `.license` attachment bypasses the body
 * entirely. Three independent defenses, because the failure is silent.
 *
 * Base64 ignores whitespace on decode, so the wrapped copy pastes back exactly
 * as issued. The cost is that double-tap-to-select-line on mobile no longer
 * grabs the whole key — acceptable now that the attachment is the primary path.
 */
export function wrapBlob(blob: string, width = 72): string {
  const lines: string[] = [];
  for (let i = 0; i < blob.length; i += width) lines.push(blob.slice(i, i + width));
  return lines.join("\n");
}

/**
 * Build the Resend attachment for the license.
 *
 * `content` must be base64 of the FILE'S BYTES. The blob is already base64
 * *text*, so it has to be base64-encoded a second time — passing the blob
 * straight through produces a file containing raw `{"metadata":…}` JSON, which
 * `activateLicense` rejects. `.license` is the extension the CLI and the runbook
 * already use (`tandem activate ./jane.license`).
 */
export function licenseAttachment(blob: string): { content: string; filename: string } {
  return { content: btoa(blob), filename: "tandem.license" };
}

/** What is wrong with `SUPPORT_EMAIL`, or `null` if nothing is. All of them fail
 *  the Worker closed; they are named separately because the operator-visible
 *  symptom differs (an unset value silently omits the support block from a paid
 *  customer's email, a placeholder prints `REPLACE_WITH_SUPPORT_INBOX` to them
 *  instead, a too-long one is a perfectly good address that would truncate the
 *  license key it is sent with). */
export type SupportEmailProblem = "unset" | "placeholder" | "malformed" | "too-long";

/** Placeholder shapes that actually occur here, not an invented list: the
 *  deploy template ships `SUPPORT_EMAIL = "REPLACE_WITH_SUPPORT_INBOX"` and
 *  `RESEND_FROM = "REPLACE_WITH_VERIFIED_SENDER"`, and the comment above the
 *  latter offers `Tandem <noreply@yourdomain.com>` as its example — the strings
 *  an operator can plausibly leave behind or half-edit. Matched against the raw
 *  value, so a display-name wrapper can't smuggle one past. Shared by BOTH
 *  config guards (hence the name): the two leftovers are the same two shapes,
 *  and a second regex would drift from this one. */
const CONFIG_PLACEHOLDER = /replace_with|yourdomain/i;

/** Longest value that still renders inside the body's line ceiling: the address
 *  gets its own line under a two-space indent, and `wrapBlob`'s 72 is the width
 *  below which no line invites an MTA to re-encode. Bounding it here is what
 *  giving it its own line was reaching for — that only caps the *sentence*, and
 *  a 70+ character value (the display-name form permitted below is exactly the
 *  long shape) pushes the rendered line back over 72, at which point QP's soft
 *  break silently truncates the base64 license key printed above it. A valid
 *  address is worth refusing when sending it is what breaks activation. */
const MAX_SUPPORT_EMAIL_LEN = 70;

/**
 * Validate the operator-configured support inbox.
 *
 * Deliberately NOT an RFC 5322 parser. It rejects the shapes a misconfiguration
 * actually produces — unset, whitespace, a leftover placeholder, a value with no
 * `@`, an empty local or domain part, embedded whitespace, a dotless domain, one
 * too long to wrap — and accepts everything else. The proof that the mailbox
 * exists and is read is the runbook's end-to-end send test; a stricter regex
 * here would only add ways to fail a valid address closed, which for this Worker
 * means refusing sales.
 *
 * A `Name <addr@example.com>` wrapper is accepted because `RESEND_FROM`'s
 * documented example uses exactly that form, so an operator copying its shape
 * across is a likely and legitimate configuration — not a defect to 503 on.
 */
export function supportEmailProblem(raw: string | undefined | null): SupportEmailProblem | null {
  const value = (raw ?? "").trim();
  if (value === "") return "unset";
  if (CONFIG_PLACEHOLDER.test(value)) return "placeholder";
  const wrapped = /^[^<>]*<([^<>]*)>$/.exec(value);
  const address = (wrapped ? wrapped[1] : value).trim();
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(address)) return "malformed";
  if (value.length > MAX_SUPPORT_EMAIL_LEN) return "too-long";
  return null;
}

/** Everything `supportEmailProblem` can find in a value that is NOT printed in
 *  the email body. The one divergence is deliberate — see below. */
export type ResendFromProblem = Exclude<SupportEmailProblem, "too-long">;

/**
 * Validate the operator-configured Resend sender.
 *
 * The same checks as `supportEmailProblem`, with `"too-long"` mapped to `null`,
 * and deliberately NOT a second regex: the two vars carry the same two
 * leftovers and a copy would drift.
 *
 * WHY THE LENGTH DIVERGES. `MAX_SUPPORT_EMAIL_LEN` exists because
 * `SUPPORT_EMAIL` is PRINTED in the email body, on its own line beneath the
 * wrapped base64 key: push that line past 72 columns and an MTA re-encodes the
 * body as quoted-printable, whose soft line break truncates the key.
 * `RESEND_FROM` is a header, never rendered into the body, so the cap buys
 * nothing there and would 503 a perfectly legal
 * `Long Display Name <noreply@…>` — refusing every sale over a value that
 * works.
 */
export function resendFromProblem(raw: string | undefined | null): ResendFromProblem | null {
  const problem = supportEmailProblem(raw);
  return problem === "too-long" ? null : problem;
}

/** Paddle API host from the key prefix; null for a missing, legacy-format or
 *  unrecognised key. */
export function paddleApiBase(key: string | undefined): string | null {
  if (!key) return null;
  if (key.startsWith("pdl_sdbx_")) return "https://sandbox-api.paddle.com";
  if (key.startsWith("pdl_live_")) return "https://api.paddle.com";
  return null;
}

/** `PADDLE_PRICE_IDS` → ids, or null when any entry is malformed or none is
 *  given. Empty entries (a trailing or doubled comma) are ignored. */
export function parsePriceIds(raw: string | undefined): string[] | null {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (ids.length === 0 || ids.some((s) => !/^pri_[a-z0-9]+$/.test(s))) return null;
  return ids;
}

const SANDBOX_MAX_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** True when `SANDBOX_SIGNING_UNTIL` permits signing at `nowMs`: a full ISO
 *  timestamp with a zone (`2026-10-24T00:00:00Z`), not past, at most 7 days
 *  ahead. A date-only value is refused: it parses as UTC midnight, so the
 *  operator's "until today" would already have expired. */
export function sandboxSigningAllowed(raw: string | undefined, nowMs: number): boolean {
  if (!raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
    return false;
  }
  const until = Date.parse(raw);
  if (!Number.isFinite(until)) return false;
  return until >= nowMs && until - nowMs <= SANDBOX_MAX_AHEAD_MS;
}

async function lookupViaPaddle(
  apiKey: string,
  base: string,
  customerId: string,
): Promise<CustomerLookup> {
  try {
    const resp = await fetch(`${base}/customers/${encodeURIComponent(customerId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return { ok: false, status: resp.status };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await resp.json();
    // Only the email: a license carries no name (docs/licensing-operations.md §0,
    // decision 2), so the Paddle name is never read even though checkout asks for it.
    return { ok: true, email: json?.data?.email };
  } catch {
    // A network error or an unparseable 200 body: retryable (`paddle-api`).
    return { ok: false };
  }
}

async function sendViaResend(env: WorkerEnv, to: string, blob: string) {
  // Not configured counts as a delivery failure so the event stays retryable
  // (the handler's 500 path logs it) rather than silently dropping a paid
  // customer's license. RESEND_FROM is belt-and-braces here — the fetch handler
  // now 503s on an unset/placeholder/malformed value BEFORE anything is minted
  // — but RESEND_API_KEY is a *secret*, deliberately unvalidated up front, and
  // an unset one still needs to land as the alertable `stage: "email"`.
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return { ok: false };
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to,
        // A buyer whose activation fails needs somewhere to write that isn't the
        // public issue tracker — the natural instinct is to paste the key, and
        // the key carries their own email address. `RESEND_FROM` is a noreply
        // address, so without this there is no inbound channel at all. It used
        // to be conditional, which made a missing var invisible; the fetch
        // handler now validates it up front, so it is unconditional here.
        reply_to: env.SUPPORT_EMAIL,
        subject: "Your Tandem license",
        text: licenseEmailText(blob, env.SUPPORT_EMAIL),
        attachments: [licenseAttachment(blob)],
      }),
    });
    // Carry the upstream status into the error log (`stage: "email"`) — a 422
    // (unverified sender domain) vs 401 (bad key) vs 429 (rate limit) is the
    // difference between a five-minute fix and a blind redeploy loop.
    return { ok: resp.ok, status: resp.status };
  } catch {
    return { ok: false };
  }
}

/**
 * The plain-text license email.
 *
 * Deliberately pure 7-bit ASCII — no em dashes, no smart quotes, no accented
 * characters. A single non-ASCII byte anywhere in the body is enough for a mail
 * transfer agent to re-encode the whole thing as quoted-printable, and QP's soft
 * line breaks are the one transformation that silently truncates a base64
 * license key. The buyer's name used to be the one exception; it is no longer
 * greeted by name (a license carries no name), so the whole body is ASCII.
 */
export function licenseEmailText(blob: string, supportEmail: string): string {
  return [
    "Hello,",
    "",
    "Thank you for buying Tandem. Your license is attached as",
    "tandem.license, and is also printed below.",
    "",
    // The CLI route is offered to npm installs only: the desktop bundle ships
    // no `tandem` command, and an npm CLI writes into its own app-data
    // directory, so a desktop buyer would see "activated" and stay unlicensed.
    // SettingsLicenseTab.svelte hides the same clause on desktop.
    "To activate, open Tandem -> Settings -> License and paste the key",
    "below. If you installed Tandem with npm, you can instead run",
    "`tandem activate ./tandem.license`, pointing at the attached file.",
    "",
    // Wrapped so an MTA doesn't re-encode the body as quoted-printable and
    // truncate the key. Base64 ignores the line breaks on paste.
    wrapBlob(blob),
    "",
    "Keep this email - it's your proof of purchase, and it lets you",
    "re-activate Tandem whenever you need to. Your license never",
    "expires, and it includes all future updates. There is no guarantee",
    "that future updates will be released.",
    "",
    "Please don't post the key publicly - it contains your email",
    "address.",
    "",
    // No "reply here": a reply would quote the key printed above into the
    // support inbox. `reply_to` still points there on purpose, as the inbound
    // channel when RESEND_FROM is a no-reply address, so this only stops
    // inviting it.
    "If activation gives you any trouble, write to:",
    // Its own line: the address is operator-configured and interpolating it
    // mid-sentence made this line's length unbounded (85 chars with a short
    // address, and the whole point of the 72 ceiling is that no line invites an
    // MTA to re-encode).
    `  ${supportEmail}`,
    "",
    // Paddle is the merchant of record, and its seller handbook asks for the
    // Terms, the Refund Policy and its own buyer-support site to be linked.
    // The two tandem.ink pages must be live before a live Worker sends this.
    "Your order was processed by Paddle, which handles payment, receipts",
    "and refunds. For anything about the payment itself:",
    `  ${PADDLE_BUYER_SUPPORT_URL}`,
    "",
    `Terms of sale: ${TERMS_URL}`,
    `Refund policy: ${REFUND_POLICY_URL}`,
    "",
    "-- Bryan Kolb",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Operator alerting.
//
// `wrangler tail` is a debugging tool, not an alert: no history, no thresholds,
// no notification, and it dies with the terminal session. Cloudflare offers
// nothing free that emails on a log condition. So the alert is raised in-band,
// from the same log entry the handler already produces.
//
// Worth waking someone for (exact set in `isAlertable`):
//   - `dropped`  — a payload we couldn't fulfil. A paid sale may be behind it.
//   - `noticed`  — an adjustment or API-key event a human must act on.
//   - `stage:"email"` — the license was minted but not delivered.
//   - `paddle-api*` / `notice-write` — a sale is waiting on Paddle or on KV.
//   - the `config*` stages — the Worker is 503ing every webhook, so no sale can
//     complete at all. These are the only ones raised before signature
//     verification; see `isAlertable` for that bound.
//   - `delivery-check`, raised by the daily cron, not by a webhook.
//
// CRITICAL: the email-stage alert must NOT go through Resend, which is the thing
// that just failed. It degrades to ALERT_WEBHOOK_URL (any incoming-webhook
// endpoint — Slack, Discord, ntfy). If only one channel is configured, an
// email-stage alert with no webhook is deliberately dropped rather than sent
// through the broken path, and says so in the log.
// ---------------------------------------------------------------------------

/** Best-effort per-isolate throttle. Paddle retries a failing delivery up to 60
 *  times over 3 days;
 *  without this a single misconfiguration emits an alert per retry per order.
 *  Isolates are short-lived, so this narrows the storm rather than eliminating
 *  it — which is the right trade for an alert you must not miss entirely. */
const ALERT_THROTTLE_MS = 5 * 60 * 1000;
const lastAlertAt = new Map<string, number>();

function shouldAlert(key: string, nowMs: number): boolean {
  const prev = lastAlertAt.get(key);
  if (prev !== undefined && nowMs - prev < ALERT_THROTTLE_MS) return false;
  lastAlertAt.set(key, nowMs);
  return true;
}

/** Test-only: clear the throttle so each case starts from a clean isolate.
 *  Without this the second test to provoke a given result is silently
 *  suppressed, and any "does not alert" assertion passes vacuously. */
export function _resetAlertThrottleForTests(): void {
  lastAlertAt.clear();
}

/**
 * The stages that mean "the Worker is misconfigured and refusing every
 * webhook". ENUMERATED, not prefix-matched: `stage?.startsWith("config")`
 * would silently adopt every future stage that happens to start with those six
 * characters. One list, read by both `alertBody` and `isAlertable`, so the two
 * cannot disagree about what counts as a config failure.
 */
const CONFIG_STAGES: readonly FailStage[] = [
  "config",
  "config-support-email",
  "config-resend-from",
  "config-paddle-api-key",
  "config-price-ids",
  "config-env-mismatch",
  "config-sandbox-until",
  "config-sandbox-buyers",
];

function isConfigStage(stage: FailStage | undefined): boolean {
  return stage !== undefined && CONFIG_STAGES.includes(stage);
}

const NOTICE_TEXT: Record<NoticeStage, string> = {
  "api-key-expiry": "The Paddle API key is expiring or has expired; replace it before sales fail",
  "refund-partial":
    "A partial refund was approved; the license was kept (revoke by hand if partials add up to a full refund)",
  "credit-partial": "A partial credit was approved; the license was kept",
  "credit-reverse":
    "A credit was reversed; restore the license by hand (or hand-sign one if it was never issued)",
  "chargeback-reverse":
    "A chargeback was reversed; restore the license by hand (or hand-sign one if it was never issued)",
  "adjustment-reversed":
    "An adjustment was reversed; restore the license by hand (or hand-sign one if it was never issued)",
  dropped: "A signed webhook event could not be fulfilled (a paid sale may be behind it)",
};

const STAGE_TEXT: Partial<Record<FailStage, string>> = {
  email: "A license was minted but could NOT be emailed",
  "paddle-api": "The Paddle API could not be reached to look up a buyer; the sale is waiting",
  "paddle-api-auth":
    "The Paddle API key is expired or lacks customer.read; every sale fails until it is replaced",
  ledger:
    "A ledger record is corrupt; every retry for that order fails until the record is repaired by hand",
  "notice-write":
    "A notice or dropped-event record could not be written to LEDGER_KV; Paddle will retry the event",
  "delivery-check":
    "The daily delivery check found failed Paddle notifications or an inactive destination (or could not run)",
};

/** Alert text. Carries the coarse result/stage ONLY — never an email, a license
 *  id, a ref, or payload bytes, so an alert channel is not a PII sink. */
function alertBody(entry: LogEntry): string {
  const what = isConfigStage(entry.stage)
    ? "The Worker is refusing every webhook (misconfiguration) — no sale can complete"
    : entry.notice
      ? NOTICE_TEXT[entry.notice]
      : entry.result === "dropped"
        ? NOTICE_TEXT.dropped
        : ((entry.stage && STAGE_TEXT[entry.stage]) ??
          "A webhook event could not be fulfilled (a paid sale may be behind it)");
  const replied200 = entry.result === "dropped" || entry.result === "noticed";
  return [
    `Tandem license issuance: ${what}.`,
    `result=${entry.result} stage=${entry.stage ?? entry.notice ?? "-"} status=${entry.status ?? "-"}`,
    "",
    // The cron's own alert is about no particular delivery, so the retry tail
    // would mislead.
    ...(entry.stage === "delivery-check"
      ? [
          "Check Paddle > Developer tools > Notifications and the destination, then reconcile:",
          "docs/licensing-operations.md §5.",
        ]
      : replied200
        ? ["Paddle will not retry this; see the `notice:` keys in LEDGER_KV (ops §5)."]
        : [
            "Paddle retries for up to 3 days (60 attempts), then marks the notification failed.",
            "Check Paddle > Developer tools > Notifications, replay after fixing, then reconcile:",
            "docs/licensing-operations.md §5.",
          ]),
  ].join("\n");
}

async function sendOperatorAlert(env: WorkerEnv, entry: LogEntry): Promise<void> {
  const body = alertBody(entry);
  // Resend is the thing that just failed — do not report an email failure
  // through it. `config-resend-from` joins it for a sharper reason: the
  // ALERT_EMAIL fallback below sends `from: env.RESEND_FROM`, so reporting a
  // broken RESEND_FROM through Resend uses the broken address and the alert
  // dies with the thing it is about. `config` and `config-support-email` leave
  // Resend perfectly usable.
  const resendIsSuspect = entry.stage === "email" || entry.stage === "config-resend-from";

  if (env.ALERT_WEBHOOK_URL) {
    try {
      const resp = await fetch(env.ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      // A non-ok response counts as a failure, not a delivery. A retired Slack
      // webhook 404s rather than throwing, and treating that as success loses
      // the alert silently — in the one piece of code whose entire purpose is
      // to not be missed.
      if (resp.ok) return;
    } catch {
      // fall through
    }
  }

  if (!resendIsSuspect && env.ALERT_EMAIL && env.RESEND_API_KEY && env.RESEND_FROM) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.RESEND_FROM,
          to: env.ALERT_EMAIL,
          subject: "[Tandem] license issuance needs attention",
          text: body,
        }),
      });
      if (resp.ok) return;
    } catch {
      // An alert that fails to send must never fail the webhook.
    }
  }

  // Both channels are exhausted (or the only viable one wasn't configured).
  // Say so in the log — otherwise the throttle slot is consumed and nothing
  // records that the alert never landed.
  console.log(
    JSON.stringify({
      result: "alert-undeliverable",
      ts: Math.floor(Date.now() / 1000),
      ...(entry.stage ? { stage: entry.stage } : {}),
    }),
  );
}

/**
 * Does this log entry warrant waking the operator?
 *
 * The `config*` stages come from `CONFIG_STAGES`, which is ENUMERATED
 * rather than prefix-matched for the reason stated there. The other rejected
 * shorthand is `result === "error"`, which sweeps in `unexpected` and
 * `blob-size` — transient failures that would storm the channel. `ledger` is
 * listed: it means a corrupt record, which fails every retry for that one order
 * until a human fixes it, so it is per-order rather than a storm. Every other
 * alertable outcome is reached only AFTER `verifyPaddleSignature`, which is why
 * a bad signature never alerts: a fresh header with a random `h1` costs an
 * outsider nothing, and an alert per request would drain the Resend quota that
 * delivers licenses. A wrong secret is caught by the daily delivery check.
 *
 * THE BOUND, written down because it is unusual: the config stages are the only
 * alertable class reachable BEFORE `verifyPaddleSignature` — every config guard
 * runs in `default.fetch`, ahead of the signature gate — so their volume is
 * bounded by inbound requests rather than by authenticated ones, against a
 * per-isolate throttle. That is acceptable only because they fire exactly while
 * the Worker is already refusing every sale, which is the thing you must not
 * miss. Do NOT move the guards behind verification to tighten it: that puts
 * `RESEND_FROM` back after the mint, which is the defect they exist to fix.
 */
export function isAlertable(entry: LogEntry): boolean {
  return (
    entry.result === "dropped" ||
    (entry.result === "error" &&
      (entry.stage === "email" ||
        entry.stage === "paddle-api" ||
        entry.stage === "paddle-api-auth" ||
        entry.stage === "notice-write" ||
        entry.stage === "ledger")) ||
    entry.result === "noticed" ||
    isConfigStage(entry.stage)
  );
}

/** Noticed/dropped throttle by ref, so two transactions never share a key. */
export function alertThrottleKey(entry: LogEntry): string {
  if (entry.result === "noticed" || entry.result === "dropped") {
    return `${entry.result}:${entry.notice ?? "-"}:${entry.ref ?? "-"}`;
  }
  return `${entry.result}:${entry.stage ?? "-"}`;
}

async function paddleGet(apiKey: string, url: string): Promise<unknown | null> {
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** Daily delivery check. Signature failures never alert (see `isAlertable`),
 * so a webhook secret regenerated in Paddle without a matching `wrangler secret
 * put`, or a destination Paddle deactivated, would otherwise leave sales sitting
 * in Paddle's failed list with no signal. Authenticated by the Worker's own API
 * key, so no outsider can trigger it. Returns true when it raised an alert. */
export async function runDeliveryCheck(env: WorkerEnv, nowMs: number): Promise<boolean> {
  const base = paddleApiBase(env.PADDLE_API_KEY);
  let bad: boolean;
  if (!base || !env.PADDLE_API_KEY) {
    bad = true; // a check that cannot run must say so, or it reads as healthy
  } else {
    // Comma-separated `status` filter per Paddle's list-notifications
    // reference; not yet exercised against a real account (ops §8).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const notes: any = await paddleGet(
      env.PADDLE_API_KEY,
      `${base}/notifications?status=failed,needs_retry`,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const settings: any = await paddleGet(env.PADDLE_API_KEY, `${base}/notification-settings`);
    if (!Array.isArray(notes?.data) || !Array.isArray(settings?.data)) {
      bad = true; // an API failure alerts too, for the same reason
    } else {
      bad =
        notes.data.length > 0 ||
        // No destination at all is the quietest way sales stop.
        settings.data.length === 0 ||
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        settings.data.some((d: any) => d?.active === false);
    }
  }
  if (!bad) return false;
  const entry: LogEntry = {
    result: "error",
    ts: Math.floor(nowMs / 1000),
    stage: "delivery-check",
  };
  console.log(JSON.stringify(entry));
  // Alerts directly rather than via isAlertable: this is the cron's own entry,
  // never a webhook's.
  if (!shouldAlert(alertThrottleKey(entry), nowMs)) return false;
  await sendOperatorAlert(env, entry);
  return true;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    const log = (entry: LogEntry) => {
      console.log(JSON.stringify(entry));
      // Alert AFTER logging and outside the response path — `waitUntil` keeps
      // the isolate alive for the send without delaying Paddle's 200/500.
      // `ctx` is always supplied by the real runtime; the optional guard keeps
      // the handler callable from a two-arg test harness. Falling back to a
      // floating promise (with its rejection swallowed) is right here: an alert
      // must never be able to fail the webhook it is reporting on.
      if (isAlertable(entry) && shouldAlert(alertThrottleKey(entry), Date.now())) {
        const pending = sendOperatorAlert(env, entry).catch(() => {});
        if (ctx) ctx.waitUntil(pending);
      }
    };

    // Import the signing key up front — a bad/missing key fails closed (503)
    // before any webhook processing. So does a key no shipped build trusts: its
    // licenses would fail verification on every device, and the buyer would be
    // told their key is bad, after the sale had already gone through.
    // `!signerCache` is not redundant: on a cold isolate with the secret unset,
    // `signerCache?.pem` and the key are both undefined and compare equal, so the
    // import would be skipped and the destructure below would throw a 500 that
    // logs and alerts nothing.
    if (!signerCache || signerCache.pem !== env.TANDEM_PRIVATE_KEY) {
      try {
        const key = await importPkcs8Ed25519(env.TANDEM_PRIVATE_KEY);
        const keyId = await keyIdOfPkcs8Ed25519(env.TANDEM_PRIVATE_KEY);
        if (!trustedKeyIds.includes(keyId)) throw new Error("untrusted signing key");
        signerCache = { pem: env.TANDEM_PRIVATE_KEY, signBytes: webCryptoSigner(key), keyId };
      } catch {
        log({ result: "error", ts: Math.floor(Date.now() / 1000), stage: "config" });
        return jsonResponse(503);
      }
    }
    const { signBytes, keyId } = signerCache;

    // Same fail-closed treatment as the signing key, and for the same reason: a
    // bad SUPPORT_EMAIL is not detectable from a successful-looking response.
    //
    // WHY HERE and not at the point of use in `sendViaResend`: by the time the
    // email is composed the license has already been minted, the entitlement
    // written to LICENSE_KV and the order recorded in the ledger. A point-of-use
    // refusal would leave an issued-but-undeliverable license behind and a 500
    // retry loop that can never succeed, and it would only fire for buyers —
    // i.e. after a bad deploy has already cost a sale. Checking before any
    // webhook processing means nothing durable is written, Paddle simply
    // re-delivers, and the untouched event is fulfilled once the var is fixed.
    //
    // The three problem kinds share one stage: they name the same `[vars]` line
    // and the operator reads the value to tell them apart. What the stage must
    // distinguish is this from the signing key's `config` — different fix.
    if (supportEmailProblem(env.SUPPORT_EMAIL) !== null) {
      log({
        result: "error",
        ts: Math.floor(Date.now() / 1000),
        stage: "config-support-email",
      });
      return jsonResponse(503);
    }

    // Same treatment, same reason, one stage further: RESEND_FROM.
    //
    // WHY HERE and not at the point of use in `sendViaResend`. That guard is a
    // bare `!env.RESEND_FROM`, which the SHIPPED value passes — the deploy
    // template's `REPLACE_WITH_VERIFIED_SENDER` is present, just not a sender.
    // Resend answers 422, the handler collapses to a retryable 500, and Paddle
    // retries until it marks the notification failed — AFTER the license was minted, the
    // entitlement written to LICENSE_KV and the order recorded in the ledger.
    // The buyer is charged, the license exists, and the email never sends.
    // Checking here means nothing durable is written, the untouched event is
    // simply re-delivered once the var is fixed, and the failure is visible on
    // the first request rather than the first sale.
    //
    // An UNSET value fails here too, deliberately: `if (env.RESEND_FROM && …)`
    // would keep the old point-of-use behaviour for the one case a fresh deploy
    // is most likely to hit. Its own stage, because the stage is the only thing
    // telling an operator which `[vars]` line to edit.
    if (resendFromProblem(env.RESEND_FROM) !== null) {
      log({
        result: "error",
        ts: Math.floor(Date.now() / 1000),
        stage: "config-resend-from",
      });
      return jsonResponse(503);
    }

    const configFail = (stage: FailStage) => {
      log({ result: "error", ts: Math.floor(Date.now() / 1000), stage });
      return jsonResponse(503);
    };
    const apiKey = env.PADDLE_API_KEY;
    const apiBase = paddleApiBase(apiKey);
    if (!apiKey || !apiBase) return configFail("config-paddle-api-key");
    const priceIds = parsePriceIds(env.PADDLE_PRICE_IDS);
    if (!priceIds) return configFail("config-price-ids");
    // A live key never runs in a test-mode Worker. A sandbox key may run with
    // `production` (the ops §8 end-to-end setup) only because it must also
    // carry SANDBOX_SIGNING_UNTIL: a sandbox Worker signs with the PRODUCTION
    // key, and a sandbox checkout needs only a public token and the 4242 test
    // card, so a forgotten one would mint real licenses forever.
    const isTest = (env.TANDEM_ISSUANCE_ENV ?? "production").toLowerCase() !== "production";
    if (apiKey.startsWith("pdl_live_") && isTest) return configFail("config-env-mismatch");
    if (
      apiKey.startsWith("pdl_sdbx_") &&
      !sandboxSigningAllowed(env.SANDBOX_SIGNING_UNTIL, Date.now())
    ) {
      return configFail("config-sandbox-until");
    }
    let sandboxBuyers: ReadonlySet<string> | undefined;
    if (apiKey.startsWith("pdl_sdbx_")) {
      sandboxBuyers = emailSetOf(env.SANDBOX_BUYER_EMAILS ?? "");
      // Every entry must be address-shaped, so the shipped placeholder 503s
      // like every other one instead of silently ignoring every test order.
      if (sandboxBuyers.size === 0 || [...sandboxBuyers].some((e) => !EMAIL_SHAPE.test(e))) {
        return configFail("config-sandbox-buyers");
      }
    }

    const grandfatherSet = grandfatherSetOf(env.GRANDFATHER_EMAILS ?? "");

    return handleIssuance(request, {
      webhookSecret: env.PADDLE_WEBHOOK_SECRET,
      signBytes,
      keyId,
      entitlementKv: env.LICENSE_KV,
      ledgerKv: env.LEDGER_KV,
      sendEmail: (to, blob) => sendViaResend(env, to, blob),
      isGrandfathered: (email) => grandfatherSet.has(email.toLowerCase().trim()),
      hasGrandfathers: grandfatherSet.size > 0,
      ...(sandboxBuyers ? { sandboxBuyers } : {}),
      lookupCustomer: (id) => lookupViaPaddle(apiKey, apiBase, id),
      priceIds,
      isTest,
      now: () => Date.now(),
      newLicenseId: () => globalThis.crypto.randomUUID(),
      log,
    });
  },

  async scheduled(_controller: unknown, env: WorkerEnv, ctx?: ExecutionContext): Promise<void> {
    const run = runDeliveryCheck(env, Date.now()).catch(() => {
      // An alert that throws must not fail the cron, but it must not vanish.
      console.log(
        JSON.stringify({
          result: "error",
          ts: Math.floor(Date.now() / 1000),
          stage: "delivery-check",
        }),
      );
      return false;
    });
    if (ctx) ctx.waitUntil(run);
    await run;
  },
};
