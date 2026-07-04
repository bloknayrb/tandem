/**
 * Tandem license ISSUANCE endpoint (Cloudflare Worker) — the public seam that
 * turns a paid Polar checkout into an Ed25519-signed license (#1116, ADR-040).
 *
 * This supersedes the loopback-only server handler
 * `src/server/license/webhook.ts` (which Polar can never reach, and whose
 * `verifyPolarSignature` invented a wrong `t=,v1=` scheme). Stripping that
 * server handler from the shipped bundle is a separate follow-up.
 *
 * Design mirrors the sibling `infra/license-update-worker/`: a pure
 * `handleIssuance(request, deps)` with ALL I/O injected, so the whole flow runs
 * under vitest with a mock KV, a mock mailer, and a real generated Ed25519 key —
 * no Cloudflare runtime needed — plus a thin `default { fetch }` that wires the
 * real bindings.
 *
 * Security posture (see the design review folded into this file):
 *  - Signature verified (Standard-Webhooks/svix) BEFORE any parse or side effect.
 *  - Fail-closed status mapping, in gate order: non-POST → 405; missing
 *    secret/key → 503; missing headers → 400; bad signature / stale
 *    timestamp → 401; bad JSON → 400.
 *  - Three idempotency layers: per-attempt timestamp freshness, a `webhook-id`
 *    completion set (blocks replays of fully-processed events), and the durable
 *    `orderId` ledger (blocks re-mint; drives retry-based recovery). `issue()`
 *    and `revoke()` each re-read the ledger immediately before their first
 *    commit (see the "pre-commit recheck" comments below) so a same-orderId
 *    write from a concurrent request — another `order.paid` delivery, or an
 *    `order.refunded` racing it — is deferred to instead of blindly
 *    overwritten. This SHRINKS the window (from the whole request, including
 *    async Ed25519 signing, down to one KV round trip) but Workers KV has no
 *    compare-and-swap, so it does not make the pair atomic: two requests that
 *    are truly simultaneous through both reads can still both commit (a
 *    double-mint, or a mint that lands after a refund's tombstone recheck).
 *    Closing that residual gap needs a Durable Object per orderId — accepted
 *    as a follow-up (see README).
 *  - PII (email/name) lives ONLY in the issuance-owned ledger KV, never in the
 *    entitlement KV the update Worker reads. Logs carry `{ result, ts }` plus a
 *    non-PII failure `stage` on errors — never an email or license id. The HTTP
 *    response NEVER contains the blob (that would leak it into Polar's delivery
 *    logs); it reaches the buyer by email alone.
 */

import {
  importPkcs8Ed25519,
  type SignBytes,
  signLicense,
  verifyStandardWebhook,
  webCryptoSigner,
} from "./crypto.js";

/** License schema version baked into signed metadata. Drift changes the signed
 * bytes, so keep it in lockstep with the server (`webhook.ts` used "1.0"). */
export const LICENSE_VERSION = "1.0";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
/** Standard-Webhooks freshness tolerance (svix guidance; each attempt is
 * freshly timestamped, so this does not reject legitimate retries). */
export const TIMESTAMP_TOLERANCE_S = 300;
/** TTL for the `webhook-id` completion marker. Long enough for Polar's retry
 * span in practice; a late marker miss is harmless — the orderId ledger still
 * answers `duplicate` without re-minting or re-emailing. */
export const EVENT_TTL_S = 24 * 60 * 60;

const MAX_NAME_LEN = 128;
const MAX_EMAIL_LEN = 254; // RFC 5321
/** A real Polar order payload is well under 10KB; this is defense-in-depth
 * against forcing an unauthenticated caller's oversized body through HMAC +
 * JSON.parse before the signature check can reject it (the secret is not
 * needed to reach the body-read line). */
const MAX_BODY_BYTES = 65_536;
/** The on-device verifier rejects a decoded blob whose length exceeds 4096
 * (`verifier.ts`, measured on the decoded string). Our `>=`-on-bytes check is
 * deliberately stricter (UTF-8 bytes ≥ UTF-16 units), so no blob that passes
 * here can fail on-device. We must never email a blob the buyer's own client
 * can't verify. */
const MAX_BLOB_DECODED_BYTES = 4096;

/** Minimal structural view of a Cloudflare KV namespace (read + write). */
export interface KvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Coarse, closed result enum for logging — deliberately NOT the fine-grained
 * internal reason in the HTTP response (which could become a discrimination
 * oracle). `"error"` is the one retryable outcome: it maps to a retryable 5xx
 * (500; 503 for config failures) so Polar re-delivers. `"dropped"` marks an
 * event whose payload could not be fulfilled — an `order.paid` with no usable
 * email/orderId (a paid sale may be behind it), OR an `order.refunded` whose
 * `refunded` discriminator field is missing/non-boolean (a real refund may be
 * behind it; Polar's exact field shape is unconfirmed — see `revoke()`) — so
 * it's the one result worth alerting on; it returns 200 (a retry carries the
 * same bytes) but is NOT marked done, so a manual Polar re-send after a fix
 * reprocesses it. */
export type ResultKind =
  | "issued"
  | "duplicate"
  | "revoked"
  | "ignored"
  | "dropped"
  | "rejected"
  | "error";

/** Non-PII failure stage attached to error logs. Cloudflare's log stream is
 * operator-only (not attacker-visible), so tagging the failing stage — and the
 * upstream HTTP status for email — costs no security and makes a launch-day
 * Resend misconfiguration debuggable. */
export type FailStage = "config" | "email" | "blob-size" | "ledger" | "unexpected";

interface Failure {
  stage: FailStage;
  status?: number;
}

export interface LogEntry {
  result: ResultKind;
  ts: number;
  stage?: FailStage;
  /** Upstream HTTP status (email stage only). */
  status?: number;
}

/** What issue()/revoke() produce: a terminal result, or a Failure (→ 500). */
type EventOutcome = Exclude<ResultKind, "rejected" | "error"> | Failure;

export interface IssuanceDeps {
  webhookSecret: string;
  signBytes: SignBytes;
  /** licenseId → LicenseEntitlement; read by the update Worker. NO PII. */
  entitlementKv: KvNamespace;
  /** issuance-owned store: `order:<mode>:<id>` records + `evt:<mode>:<id>`. */
  ledgerKv: KvNamespace;
  /** Deliver the license blob to the buyer. Non-throwing; `status` is the
   * upstream HTTP status when a response was received (absent on config or
   * network failure). */
  sendEmail: (to: string, name: string, blob: string) => Promise<{ ok: boolean; status?: number }>;
  isGrandfathered: (email: string) => boolean;
  /** Deploy-time env flag: a sandbox deployment must not entitle updates. */
  isTest: boolean;
  now: () => number;
  newLicenseId: () => string;
  toleranceS?: number;
  log?: (entry: LogEntry) => void;
}

/** Durable ledger record. Carries the fields needed to re-sign an identical
 * blob on a retry/resend (Ed25519 is deterministic per RFC 8032 — a randomized
 * scheme would break the resend story) plus dedup/refund bookkeeping — no
 * separate copy of the signature. A refund that arrives before the paid event
 * writes a TOMBSTONE: `refunded: true` with empty licenseId/email. */
interface LedgerRecord {
  orderId: string;
  licenseId: string;
  email: string;
  name: string;
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
const evtKeyOf = (isTest: boolean, webhookId: string): string =>
  `evt:${modeOf(isTest)}:${webhookId}`;

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
    typeof r.name === "string" &&
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
  return deps.ledgerKv.put(orderKeyOf(deps.isTest, rec.orderId), JSON.stringify(rec));
}

// ---------------------------------------------------------------------------
// Input hygiene. Names are cosmetic → clamped. Emails are identity → rejected
// (not silently truncated) when implausible.
// ---------------------------------------------------------------------------

/** C0 controls + DEL, as \u escapes so the source carries no control bytes. */
 
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanName(raw: unknown): string {
  const s = (typeof raw === "string" ? raw : "")
    .replace(CONTROL_CHARS, "")
    .trim()
    .slice(0, MAX_NAME_LEN);
  return s || "Valued Customer";
}

// Minimal structural check (one "@", a non-empty local + domain part, a dot
// somewhere in the domain not at either end) — not full RFC 5322. Polar is the
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

function metadataFrom(rec: LedgerRecord) {
  return {
    id: rec.licenseId,
    name: rec.name,
    email: rec.email,
    type: rec.type,
    createdAt: rec.createdAt,
    expiresAt: rec.updateWindowEnd,
    version: LICENSE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// order.paid → mint (or idempotently re-drive) a license.
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
    const blob = await signLicense(metadataFrom(existing), deps.signBytes);
    const sent = await deps.sendEmail(existing.email, existing.name, blob);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function issue(data: any, deps: IssuanceDeps, nowMs: number): Promise<EventOutcome> {
  // `data.customer` is Polar's authoritative buyer object; the extra fallbacks
  // are belt-and-suspenders against schema drift so a paid customer is never
  // silently dropped for a nesting change.
  const email = cleanEmail(data?.customer?.email ?? data?.user?.email ?? data?.billing?.email);
  // No usable identity → "dropped", not "ignored": a paid sale may be behind
  // this. 200 (a retry carries the same bytes) but NOT marked done, so a manual
  // re-send after a parser fix reprocesses it; the distinct result is the
  // alert hook.
  if (!email) return "dropped";

  const name = cleanName(data?.customer?.name ?? data?.user?.name);
  const orderId = typeof data?.id === "string" ? data.id : null;
  if (!orderId) return "dropped";

  const grandfathered = deps.isGrandfathered(email);

  // Ledger dedup/re-drive MUST run before the coupon-containment gate below.
  // A redelivery/resend of an already-ledgered order can carry a payload
  // snapshot that differs from the original (e.g. a later partial adjustment
  // reads the current total as ≤0) — if the free-order gate ran first, that
  // resend would be silently "ignored" instead of hitting the re-drive branch,
  // breaking the failed-email recovery story for a real, already-paid order.
  const existing = await readOrder(deps, orderId);
  if (existing) return reDrive(existing, deps);

  // $0 / 100%-off coupon containment: a free order only yields a license for a
  // listed grandfather email. A non-listed $0 order is an authorization gap (a
  // leaked coupon → unbounded free licenses), so we ignore it. Only reached
  // for a genuinely NEW order (no ledger record above).
  if (isFreeOrder(data) && !grandfathered) return "ignored";

  // Fresh issuance. NOTE: only `personal`/`grandfathered` are minted here. If a
  // `commercial` SKU is ever sold through this same webhook it would be silently
  // downgraded to `personal` — wire an SKU→type map at that milestone.
  const licenseId = deps.newLicenseId();
  const type: LedgerRecord["type"] = grandfathered ? "grandfathered" : "personal";
  const createdAt = new Date(nowMs).toISOString();
  const updateWindowEnd = grandfathered ? null : new Date(nowMs + YEAR_MS).toISOString();

  const rec: LedgerRecord = {
    orderId,
    licenseId,
    email,
    name,
    type,
    createdAt,
    updateWindowEnd,
    emailSent: false,
    refunded: false,
  };

  const blob = await signLicense(metadataFrom(rec), deps.signBytes);
  // Belt-and-suspenders on the verifier's 4096-byte ceiling: never email a blob
  // the buyer's client would reject. Decoded size derived arithmetically from
  // the (always correctly padded) base64 we just produced. With name≤128 and
  // email≤254 the blob is ~0.6KB, so this only fires on a logic regression —
  // and then fails LOUD (retryable 500 + error logs), not as a silent drop.
  const padding = blob.endsWith("==") ? 2 : blob.endsWith("=") ? 1 : 0;
  if ((blob.length / 4) * 3 - padding >= MAX_BLOB_DECODED_BYTES) return { stage: "blob-size" };

  // Pre-commit recheck: Workers KV has no compare-and-swap, so another request
  // (a concurrent `order.paid` delivery racing us, OR a `order.refunded`
  // tombstone — see `revoke()`'s symmetric recheck) may have written a record
  // for this orderId in the time since our read above (which included the
  // await for Ed25519 signing). Re-reading immediately before the commit
  // shrinks that window from "the whole request" down to one KV round trip and
  // defers to whatever landed first instead of blindly overwriting it. This is
  // NOT full atomicity — two requests can still both pass both reads if they
  // are truly concurrent — closing that residual gap needs a Durable Object
  // per orderId (see README).
  const recheck = await readOrder(deps, orderId);
  if (recheck) return reDrive(recheck, deps);

  // Durable ledger first (holds everything needed to re-sign on retry). A
  // failed entitlement write below throws → retryable 500; the retry hits the
  // existing-record branch above (re-assert + resend).
  await writeOrder(deps, rec);
  if (!deps.isTest) await deps.entitlementKv.put(licenseId, entitlementValue(rec));

  const sent = await deps.sendEmail(email, name, blob);
  if (!sent.ok) return { stage: "email", status: sent.status }; // 500 → retry re-sends

  rec.emailSent = true;
  // If THIS write fails, the exception below collapses to a retryable 500 with
  // `emailSent` still false on disk — a retry re-sends the same (deterministic)
  // blob rather than losing it. Accepted: duplicate delivery of a customer's
  // own license is harmless, unlike a silently-dropped one.
  await writeOrder(deps, rec);
  return "issued";
}

/** A Polar order is "free" only when it carries at least one numeric amount
 * field and EVERY present amount field is ≤0. Amounts are integer minor units.
 * This deliberately biases toward NOT classifying a paying customer as free:
 * a discounted-but-paid order keeps a positive `total_amount` even if a
 * fee-adjusted `net_amount` reads low, so it still issues. When no amount field
 * is present at all we treat the order as paid (`order.paid` already validated
 * payment). The exact field semantics must be confirmed against a real Polar
 * sandbox payload before relying on the coupon path. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isFreeOrder(data: any): boolean {
  const present: number[] = [];
  for (const key of ["net_amount", "total_amount", "amount"]) {
    const v = data?.[key];
    if (typeof v === "number" && Number.isFinite(v)) present.push(v);
  }
  return present.length > 0 && present.every((v) => v <= 0);
}

// ---------------------------------------------------------------------------
// order.refunded → revoke the UPDATE entitlement (not the offline run-license,
// which is perpetual by design). An ambiguous/unconfirmed `refunded` field
// resolves to "dropped" (alert, no commit) rather than a guessed revoke/ignore.
// ---------------------------------------------------------------------------

/** Revoke an order that ALREADY has a ledger record: delete its entitlement
 * (tombstones and never-entitled records have no licenseId, so this is a
 * no-op for them) and mark it refunded. Idempotent — revoking an
 * already-refunded record just re-writes the same state. */
async function applyRefund(rec: LedgerRecord, deps: IssuanceDeps): Promise<EventOutcome> {
  if (!deps.isTest && rec.licenseId) await deps.entitlementKv.delete(rec.licenseId);
  rec.refunded = true;
  await writeOrder(deps, rec);
  return "revoked";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function revoke(data: any, deps: IssuanceDeps, nowMs: number): Promise<EventOutcome> {
  // Only an EXPLICIT `false` is treated as a genuinely mis-routed non-refund
  // event — routing here already required `type === "order.refunded"`, so
  // this is defense-in-depth, not the primary discriminator. Polar's exact
  // field name/shape for a refunded order is UNCONFIRMED against a real
  // sandbox payload (same risk class as `isFreeOrder`'s amount-field guess).
  // A missing/non-boolean field is therefore NEITHER auto-revoked (which
  // would silently delete a paying customer's entitlement on a wrong guess)
  // NOR auto-ignored (which would silently leave a real refund unprocessed
  // forever) — it falls through to "dropped" below: alertable, not committed
  // either way, recoverable via a manual Polar re-send once confirmed.
  if (data?.refunded === false) return "ignored";
  const orderId = typeof data?.id === "string" ? data.id : null;
  if (!orderId) return "dropped";
  if (data?.refunded !== true) return "dropped";

  const rec = await readOrder(deps, orderId);
  if (rec) return applyRefund(rec, deps);

  // No record yet — but this is the SAME KV-has-no-compare-and-swap gap as
  // `issue()`'s pre-commit recheck: a concurrent `order.paid` mint may be
  // committing right now, between our read above and the tombstone write
  // below. Re-read immediately before writing the tombstone; if a mint landed,
  // revoke IT (delete its entitlement, mark refunded) instead of blindly
  // writing an empty-licenseId tombstone that would silently orphan its
  // entitlement forever (Polar never redelivers a refund we've already 200'd,
  // so there is no second chance to catch this).
  const recheck = await readOrder(deps, orderId);
  if (recheck) return applyRefund(recheck, deps);

  // Refund-before-paid: delivery order is not guaranteed, and a refund that
  // outraces a (failed, still-retrying) paid event must not be lost — Polar
  // won't redeliver a refund we 200'd. Write a TOMBSTONE so the later paid
  // retry hits the `existing.refunded` tiebreaker instead of minting a live
  // entitlement for a refunded order.
  const tombstone: LedgerRecord = {
    orderId,
    licenseId: "",
    email: "",
    name: "",
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
// Pure request handler. Fail-closed at every gate; a single top-level result is
// logged (never PII). The body is a constant shape — never the blob.
// ---------------------------------------------------------------------------

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ ok: status < 400 }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleIssuance(request: Request, deps: IssuanceDeps): Promise<Response> {
  const nowMs = deps.now();
  const ts = Math.floor(nowMs / 1000);
  const reply = (status: number, result: ResultKind, fail?: Failure): Response => {
    const entry: LogEntry = { result, ts };
    if (fail) {
      entry.stage = fail.stage;
      if (fail.status !== undefined) entry.status = fail.status;
    }
    deps.log?.(entry);
    return jsonResponse(status);
  };
  try {
    if (request.method !== "POST") return reply(405, "rejected");

    // (1) Config present? Fail closed BEFORE reading anything.
    if (!deps.webhookSecret) return reply(503, "error", { stage: "config" });

    // (1b) Reject an oversized body via its declared Content-Length BEFORE
    // buffering it — the webhook secret isn't needed to reach this point, so
    // an unauthenticated caller could otherwise force an arbitrarily large
    // body through HMAC + JSON.parse before signature verification can reject
    // it. A missing/unparsable header falls through to the read below (the
    // platform's own request-size ceiling is the backstop).
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return reply(400, "rejected");
    }

    // (2) Read the raw body ONCE — signed content is over these exact bytes.
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) return reply(400, "rejected");

    // (3) Headers present & well-formed?
    const headers = {
      id: request.headers.get("webhook-id"),
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
    };
    if (!headers.id || !headers.timestamp || !headers.signature) {
      return reply(400, "rejected");
    }

    // (4) Signature + (5) freshness.
    const ok = await verifyStandardWebhook(
      headers,
      rawBody,
      deps.webhookSecret,
      nowMs,
      deps.toleranceS ?? TIMESTAMP_TOLERANCE_S,
    );
    if (!ok) return reply(401, "rejected");

    // (6) Parse.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return reply(400, "rejected");
    }
    const type = payload?.type;
    if (typeof type !== "string") return reply(400, "rejected");

    // (7) Replay/idempotency: short-circuit fully-processed events. A retry of a
    // FAILED delivery was never marked done, so it proceeds and re-drives via
    // the orderId ledger.
    const evtKey = evtKeyOf(deps.isTest, headers.id);
    if ((await deps.ledgerKv.get(evtKey)) === "done") {
      return reply(200, "duplicate");
    }

    // (8) Route on an allowlisted event type only. Unknown event TYPES are
    // terminally uninteresting → mark done so replays short-circuit.
    let outcome: EventOutcome;
    if (type === "order.paid") {
      outcome = await issue(payload.data, deps, nowMs);
    } else if (type === "order.refunded") {
      outcome = await revoke(payload.data, deps, nowMs);
    } else {
      await deps.ledgerKv.put(evtKey, "done", { expirationTtl: EVENT_TTL_S });
      return reply(200, "ignored");
    }

    if (typeof outcome === "object") return reply(500, "error", outcome); // Polar retries

    // (9) Mark done only for durable outcomes. `ignored`/`dropped` order events
    // are deliberately NOT marked: nothing durable was written, reprocessing is
    // idempotent, and the marker would make a manual Polar re-send (the
    // recovery path after fixing a parser/coupon issue) silently no-op for the
    // marker's TTL.
    if (outcome === "issued" || outcome === "duplicate" || outcome === "revoked") {
      await deps.ledgerKv.put(evtKey, "done", { expirationTtl: EVENT_TTL_S });
    }
    return reply(200, outcome);
  } catch (err) {
    // Any unexpected throw collapses to a static 500 — never re-thrown with
    // payload content (which could echo body bytes into the runtime log). The
    // stage distinguishes a corrupt ledger record (operator: inspect/repair the
    // order key via `wrangler kv`) from everything else.
    return reply(500, "error", {
      stage: err instanceof LedgerCorruptError ? "ledger" : "unexpected",
    });
  }
}

// ---------------------------------------------------------------------------
// Cloudflare entry point — wires real bindings. Config failures fail closed.
// ---------------------------------------------------------------------------

interface WorkerEnv {
  POLAR_WEBHOOK_SECRET: string;
  TANDEM_PRIVATE_KEY: string; // PEM PKCS#8
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  TANDEM_ISSUANCE_ENV?: string; // "sandbox" | "production" (default production)
  LICENSE_KV: KvNamespace; // SAME namespace the update Worker reads
  LEDGER_KV: KvNamespace; // issuance-owned; holds PII
  GRANDFATHER_EMAILS?: string; // comma/space-separated, optional
}

// Isolate-scope caches, keyed on the raw env value: Workers reuse module state
// across requests on the same isolate, so the Ed25519 import and grandfather
// Set are built once per isolate (and rebuilt if a secret rotates). A failed
// key import is never cached — it re-attempts (and 503s) per request.
let signerCache: { pem: string; signBytes: SignBytes } | null = null;
let grandfatherCache: { raw: string; set: Set<string> } | null = null;

function grandfatherSetOf(raw: string): Set<string> {
  if (grandfatherCache?.raw !== raw) {
    const set = new Set(
      raw
        .split(/[,\s]+/)
        .map((e) => e.toLowerCase().trim())
        .filter(Boolean),
    );
    grandfatherCache = { raw, set };
  }
  return grandfatherCache.set;
}

async function sendViaResend(env: WorkerEnv, to: string, name: string, blob: string) {
  // Not configured counts as a delivery failure so the event stays retryable
  // (the handler's 500 path logs it) rather than silently dropping a paid
  // customer's license.
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
        subject: "Your Tandem license",
        text: licenseEmailText(name, blob),
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

function licenseEmailText(name: string, blob: string): string {
  return [
    `Hi ${name},`,
    "",
    "Thank you for buying Tandem. Your license key is below. To activate, open",
    "Tandem -> Settings -> License -> Activate and paste it in (or run",
    "`tandem activate <key>` from the CLI).",
    "",
    blob,
    "",
    "Keep this email — it's your proof of purchase and lets you re-activate on",
    "any device you personally use.",
    "",
    "— The Tandem team",
  ].join("\n");
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const log = (entry: LogEntry) => console.log(JSON.stringify(entry));

    // Import the signing key up front — a bad/missing key fails closed (503)
    // before any webhook processing.
    if (signerCache?.pem !== env.TANDEM_PRIVATE_KEY) {
      try {
        const key = await importPkcs8Ed25519(env.TANDEM_PRIVATE_KEY);
        signerCache = { pem: env.TANDEM_PRIVATE_KEY, signBytes: webCryptoSigner(key) };
      } catch {
        log({ result: "error", ts: Math.floor(Date.now() / 1000), stage: "config" });
        return jsonResponse(503);
      }
    }
    const { signBytes } = signerCache;
    const grandfatherSet = grandfatherSetOf(env.GRANDFATHER_EMAILS ?? "");

    return handleIssuance(request, {
      webhookSecret: env.POLAR_WEBHOOK_SECRET,
      signBytes,
      entitlementKv: env.LICENSE_KV,
      ledgerKv: env.LEDGER_KV,
      sendEmail: (to, name, blob) => sendViaResend(env, to, name, blob),
      isGrandfathered: (email) => grandfatherSet.has(email.toLowerCase().trim()),
      isTest: (env.TANDEM_ISSUANCE_ENV ?? "production").toLowerCase() !== "production",
      now: () => Date.now(),
      newLicenseId: () => globalThis.crypto.randomUUID(),
      log,
    });
  },
};
