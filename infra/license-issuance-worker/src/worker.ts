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
 *  - Fail-closed ordering: missing secret/key → 503; bad headers/JSON → 400;
 *    bad signature / stale timestamp → 401.
 *  - Three idempotency layers: per-attempt timestamp freshness, a `webhook-id`
 *    completion set (blocks replays of fully-processed events), and the durable
 *    `orderId` ledger (blocks re-mint; drives retry-based recovery).
 *  - PII (email/name) lives ONLY in the issuance-owned ledger KV, never in the
 *    entitlement KV the update Worker reads. Logs carry `{ result, ts }` only —
 *    never an email or license id. The HTTP response NEVER contains the blob
 *    (that would leak it into Polar's delivery logs); it reaches the buyer by
 *    email alone.
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
/** TTL for the `webhook-id` completion marker — comfortably longer than Polar's
 * full retry span so a late retry of a SUCCEEDED event still short-circuits. */
export const EVENT_TTL_S = 24 * 60 * 60;

const MAX_NAME_LEN = 128;
const MAX_EMAIL_LEN = 254; // RFC 5321
/** The on-device verifier hard-rejects a decoded blob ≥ 4096 bytes
 * (`verifier.ts`). We must never email a blob the buyer's own client can't
 * verify, so we assert well under that ceiling before delivery. */
const MAX_BLOB_DECODED_BYTES = 4096;

/** Minimal structural view of a Cloudflare KV namespace (read + write). */
export interface KvNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Coarse, closed result enum for logging — deliberately NOT the fine-grained
 * internal reason (which could become a discrimination oracle). `"error"` is
 * the one retryable outcome: it maps to HTTP 500 so Polar re-delivers. */
export type ResultKind = "issued" | "duplicate" | "revoked" | "ignored" | "rejected" | "error";

export interface IssuanceDeps {
  webhookSecret: string;
  signBytes: SignBytes;
  /** licenseId → LicenseEntitlement; read by the update Worker. NO PII. */
  entitlementKv: KvNamespace;
  /** issuance-owned store: `order:<mode>:<id>` records + `evt:<mode>:<id>`. */
  ledgerKv: KvNamespace;
  /** Deliver the license blob to the buyer. Non-throwing; returns `{ ok }`. */
  sendEmail: (to: string, name: string, blob: string) => Promise<{ ok: boolean }>;
  isGrandfathered: (email: string) => boolean;
  /** Deploy-time env flag: a sandbox deployment must not entitle updates. */
  isTest: boolean;
  now: () => number;
  newLicenseId: () => string;
  toleranceS?: number;
  log?: (entry: { result: ResultKind; ts: number }) => void;
}

/** Durable ledger record. Holds exactly the fields needed to re-sign an
 * identical blob on a retry/resend — no separate copy of the signature. */
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

/** Read an order's ledger record; null when absent. A corrupt record throws,
 * landing in the handler's top-level catch → retryable 500. */
async function readOrder(deps: IssuanceDeps, orderId: string): Promise<LedgerRecord | null> {
  const raw = await deps.ledgerKv.get(orderKeyOf(deps.isTest, orderId));
  return raw ? (JSON.parse(raw) as LedgerRecord) : null;
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

function cleanEmail(raw: unknown): string | null {
  const e = (typeof raw === "string" ? raw : "").replace(CONTROL_CHARS, "").replace(/\s+/g, "");
  if (!e || e.length > MAX_EMAIL_LEN || !e.includes("@")) return null;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function issue(data: any, deps: IssuanceDeps, nowMs: number): Promise<ResultKind> {
  // `data.customer` is Polar's authoritative buyer object; the extra fallbacks
  // are belt-and-suspenders against schema drift so a paid customer is never
  // silently dropped for a nesting change.
  const email = cleanEmail(data?.customer?.email ?? data?.user?.email ?? data?.billing?.email);
  if (!email) return "ignored"; // malformed → don't retry forever

  const name = cleanName(data?.customer?.name ?? data?.user?.name);
  const orderId = typeof data?.id === "string" ? data.id : null;
  if (!orderId) return "ignored";

  const grandfathered = deps.isGrandfathered(email);

  // $0 / 100%-off coupon containment: a free order only yields a license for a
  // listed grandfather email. A non-listed $0 order is an authorization gap (a
  // leaked coupon → unbounded free licenses), so we ignore it.
  if (isFreeOrder(data) && !grandfathered) return "ignored";

  const existing = await readOrder(deps, orderId);
  if (existing) {
    // If a refund already revoked this order, a late retry of the original paid
    // event must NOT resurrect the entitlement or re-email. Events can
    // interleave; the ledger's refunded flag is the tiebreaker.
    if (existing.refunded) return "duplicate";
    if (!deps.isTest) {
      await deps.entitlementKv.put(existing.licenseId, entitlementValue(existing)); // idempotent re-assert
    }
    if (!existing.emailSent) {
      const blob = await signLicense(metadataFrom(existing), deps.signBytes);
      const sent = await deps.sendEmail(existing.email, existing.name, blob);
      if (!sent.ok) return "error";
      existing.emailSent = true;
      await writeOrder(deps, existing);
    }
    return "duplicate";
  }

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
  if ((blob.length / 4) * 3 - padding >= MAX_BLOB_DECODED_BYTES) return "error";

  // Durable ledger first (holds everything needed to re-sign on retry). A
  // failed entitlement write below throws → retryable 500; the retry hits the
  // existing-record branch above (re-assert + resend).
  await writeOrder(deps, rec);
  if (!deps.isTest) await deps.entitlementKv.put(licenseId, entitlementValue(rec));

  const sent = await deps.sendEmail(email, name, blob);
  if (!sent.ok) return "error"; // 500 → retry re-sends

  rec.emailSent = true;
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
// which is perpetual by design). Gated on an explicit refunded discriminator so
// a mis-routed non-refund event can never delete an entitlement.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function revoke(data: any, deps: IssuanceDeps): Promise<ResultKind> {
  if (data?.refunded !== true) return "ignored";
  const orderId = typeof data?.id === "string" ? data.id : null;
  if (!orderId) return "ignored";

  const rec = await readOrder(deps, orderId);
  if (!rec) return "ignored";

  if (!deps.isTest) await deps.entitlementKv.delete(rec.licenseId);
  rec.refunded = true;
  await writeOrder(deps, rec);
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
  const reply = (status: number, result: ResultKind): Response => {
    deps.log?.({ result, ts });
    return jsonResponse(status);
  };
  try {
    if (request.method !== "POST") return reply(405, "rejected");

    // (1) Config present? Fail closed BEFORE reading anything.
    if (!deps.webhookSecret) return reply(503, "error");

    // (2) Read the raw body ONCE — signed content is over these exact bytes.
    const rawBody = await request.text();

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

    // (8) Route on an allowlisted event type only; anything else is ignored.
    let result: ResultKind;
    if (type === "order.paid") {
      result = await issue(payload.data, deps, nowMs);
    } else if (type === "order.refunded") {
      result = await revoke(payload.data, deps);
    } else {
      result = "ignored";
    }

    if (result === "error") return reply(500, "error"); // Polar retries

    // (9) Mark processed only on full success (including ignored event types,
    // so replays don't re-enter the router).
    await deps.ledgerKv.put(evtKey, "done", { expirationTtl: EVENT_TTL_S });
    return reply(200, result);
  } catch {
    // Any unexpected throw collapses to a static 500 — never re-thrown with
    // payload content (which could echo body bytes into the runtime log).
    return reply(500, "error");
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
    return { ok: resp.ok };
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
    const log = (entry: { result: ResultKind; ts: number }) => console.log(JSON.stringify(entry));

    // Import the signing key up front — a bad/missing key fails closed (503)
    // before any webhook processing.
    if (signerCache?.pem !== env.TANDEM_PRIVATE_KEY) {
      try {
        const key = await importPkcs8Ed25519(env.TANDEM_PRIVATE_KEY);
        signerCache = { pem: env.TANDEM_PRIVATE_KEY, signBytes: webCryptoSigner(key) };
      } catch {
        log({ result: "error", ts: Math.floor(Date.now() / 1000) });
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
