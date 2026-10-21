import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  base64ToBytes,
  canonicalize as canonicalizeWorker,
  constantTimeEqual,
  hexToBytes,
  importPkcs8Ed25519,
  keyIdOfPkcs8Ed25519,
  signLicense,
  verifyPaddleSignature,
  webCryptoSigner,
} from "../../infra/license-issuance-worker/src/crypto.js";
import issuanceWorker, {
  _resetAlertThrottleForTests,
  _setTrustedKeyIdsForTests,
  alertThrottleKey,
  EVENT_TTL_S,
  type FailStage,
  handleIssuance,
  type IssuanceDeps,
  isAlertable,
  type KvNamespace,
  LICENSE_VERSION,
  licenseEmailText,
  parsePriceIds,
  resendFromProblem,
  sandboxSigningAllowed,
  supportEmailProblem,
  TRUSTED_KEY_IDS,
} from "../../infra/license-issuance-worker/src/worker.js";
import {
  handleUpdateRequest,
  LICENSE_HEADER,
} from "../../infra/license-update-worker/src/worker.js";
import type {
  LicenseEntitlement,
  LicenseMetadata,
} from "../../src/server/license/license-types.js";
import { buildKeyMap, keyIdForPublicKey } from "../../src/server/license/public-key.js";
import {
  _verifyAgainstForTests,
  canonicalize as canonicalizeServer,
} from "../../src/server/license/verifier.js";

// --- test crypto ------------------------------------------------------------
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

const signBytes = async (data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(crypto.sign(null, Buffer.from(data), privateKey));
const TEST_KEY_ID = keyIdForPublicKey(publicKey);
const TEST_KEYS_BY_ID = buildKeyMap([publicKey.export({ type: "spki", format: "pem" }).toString()]);

interface DecodedBlob {
  metadata: Record<string, unknown>;
  signature: string;
}

function decodeBlob(blob: string): DecodedBlob {
  return JSON.parse(Buffer.from(blob, "base64").toString("utf-8")) as DecodedBlob;
}

function blobVerifies(blob: string): boolean {
  try {
    _verifyAgainstForTests(blob, TEST_KEYS_BY_ID);
    return true;
  } catch {
    return false;
  }
}

// --- Paddle webhook signing --------------------------------------------------
// Same construction as @paddle/paddle-node-sdk 3.10.0 `NodeCrypto.computeHmac`:
// `createHmac('sha256', secret)` over `${ts}:${body}`, hex. The secret is the
// raw destination-secret string, not decoded.
const SECRET = "pdl_ntfset_01testsecret_abcdef";

function signPaddle(ts: string, body: string, secret = SECRET): string {
  return crypto.createHmac("sha256", secret).update(`${ts}:${body}`).digest("hex");
}

const NOW = 1_700_000_000_000;
const NOW_S = "1700000000";

interface ReqOpts {
  ts?: string;
  secret?: string;
  method?: string;
  sig?: string;
}

function makeRequest(body: string, opts: ReqOpts = {}): Request {
  const ts = opts.ts ?? NOW_S;
  const headers = new Headers();
  headers.set(
    "Paddle-Signature",
    opts.sig ?? `ts=${ts};h1=${signPaddle(ts, body, opts.secret ?? SECRET)}`,
  );
  const method = opts.method ?? "POST";
  return new Request("https://issuance.example/", {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

// --- in-memory KV + deps ------------------------------------------------------
function makeKv(): KvNamespace & {
  map: Map<string, string>;
  putOptions: Map<string, { expirationTtl?: number } | undefined>;
} {
  const map = new Map<string, string>();
  const putOptions = new Map<string, { expirationTtl?: number } | undefined>();
  return {
    map,
    putOptions,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v, options) => {
      map.set(k, v);
      putOptions.set(k, options);
    },
    delete: async (k) => {
      map.delete(k);
    },
    list: async ({ prefix }) => ({
      keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

interface TestDeps extends IssuanceDeps {
  entitlementKv: ReturnType<typeof makeKv>;
  ledgerKv: ReturnType<typeof makeKv>;
  sendEmail: IssuanceDeps["sendEmail"] & ReturnType<typeof vi.fn>;
  lookupCustomer: IssuanceDeps["lookupCustomer"] & ReturnType<typeof vi.fn>;
  log: NonNullable<IssuanceDeps["log"]> & ReturnType<typeof vi.fn>;
}

const buyer = (email = "buyer@example.com") => vi.fn(async () => ({ ok: true as const, email }));

function baseDeps(overrides: Partial<IssuanceDeps> = {}): TestDeps {
  let counter = 0;
  const defaults = {
    webhookSecret: SECRET,
    signBytes,
    keyId: TEST_KEY_ID,
    entitlementKv: makeKv(),
    ledgerKv: makeKv(),
    sendEmail: vi.fn(async () => ({ ok: true })),
    isGrandfathered: () => false,
    hasGrandfathers: false,
    lookupCustomer: buyer(),
    priceIds: ["pri_test1"],
    isTest: false,
    now: () => NOW,
    newLicenseId: () => `lic-${++counter}`,
    log: vi.fn(),
  } satisfies IssuanceDeps;
  return { ...defaults, ...overrides } as TestDeps;
}

// --- payload fixtures ---------------------------------------------------------
let autoEvt = 0;
const nextEvt = () => `evt_auto${++autoEvt}`;

interface PaidOpts {
  eventId?: string;
  txnId?: string;
  customerId?: string | null;
  totals?: Record<string, unknown>;
  items?: unknown;
  status?: string;
}

const paidBody = (o: PaidOpts = {}) =>
  JSON.stringify({
    event_id: o.eventId ?? nextEvt(),
    event_type: "transaction.completed",
    occurred_at: "2026-10-17T00:00:00Z",
    notification_id: "ntf_x",
    data: {
      id: o.txnId ?? "txn_1",
      status: o.status ?? "completed",
      customer_id: o.customerId === undefined ? "ctm_1" : o.customerId,
      items: o.items ?? [{ price: { id: "pri_test1" }, quantity: 1 }],
      details: { totals: o.totals ?? { grand_total: "4500", total: "4500", balance: "0" } },
    },
  });

interface RefundOpts {
  eventId?: string;
  eventType?: string;
  adjId?: string;
  txnId?: string;
  action?: string;
  status?: string;
  type?: string;
}

const refundBody = (o: RefundOpts = {}) =>
  JSON.stringify({
    event_id: o.eventId ?? nextEvt(),
    event_type: o.eventType ?? "adjustment.created",
    occurred_at: "2026-10-17T00:00:00Z",
    data: {
      id: o.adjId ?? "adj_1",
      transaction_id: o.txnId ?? "txn_1",
      action: o.action ?? "refund",
      status: o.status ?? "approved",
      type: o.type ?? "full",
    },
  });

interface LedgerRec {
  orderId: string;
  licenseId: string;
  email: string;
  type: string;
  createdAt: string;
  updateWindowEnd: string | null;
  emailSent: boolean;
  refunded: boolean;
}

const ledgerRec = (deps: TestDeps, txnId = "txn_1", mode = "live"): LedgerRec =>
  JSON.parse(deps.ledgerKv.map.get(`order:${mode}:${txnId}`) as string) as LedgerRec;

function expectRevoked(deps: TestDeps, licenseId: string): void {
  expect(JSON.parse(deps.entitlementKv.map.get(licenseId) as string)).toEqual({
    updateWindowEnd: null,
    status: "revoked",
  });
}

function expectLive(deps: TestDeps, licenseId: string): void {
  expect(JSON.parse(deps.entitlementKv.map.get(licenseId) as string)).toEqual({
    updateWindowEnd: null,
    status: "personal",
    version: LICENSE_VERSION,
  });
}

const lastLog = (deps: TestDeps) => deps.log.mock.calls.at(-1)?.[0] as Record<string, unknown>;
const noticeKeys = (deps: TestDeps) =>
  [...deps.ledgerKv.map.keys()].filter((k) => k.startsWith("notice:"));

// ===========================================================================
describe("crypto: canonicalize parity with the server verifier", () => {
  const hostile = [
    { id: "u", name: "Jane 😀 Buyer", email: "a@b.co" },
    { id: "u", name: "é precomposed", email: "a@b.co" }, // U+00E9
    { id: "u", name: "é combining", email: "a@b.co" }, // e + U+0301 combining acute
    { id: "u", name: "lone \ud800 surrogate", email: "a@b.co" },
    { id: "u", name: 'quotes " and \\ backslash', email: "a@b.co" },
    JSON.parse('{"__proto__":1,"a":2,"z":3}'),
    { b: [3, 2, 1], a: { d: 4, c: 5 } },
  ];
  it("produces byte-identical output for hostile inputs", () => {
    for (const obj of hostile) {
      expect(canonicalizeWorker(obj)).toBe(canonicalizeServer(obj));
    }
  });
});

describe("crypto: constantTimeEqual", () => {
  it("matches equal inputs, rejects unequal and length-mismatched inputs without throwing", () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe("crypto: signLicense round-trips through the real verifier path", () => {
  it("a blob signed by the Worker verifies with the matching public key", async () => {
    // Typed as the on-device LicenseMetadata so a field drift in the Worker's
    // metadata shape is a compile error here, not a production activation
    // failure.
    const metadata: LicenseMetadata = {
      id: "lic-x",
      email: "buyer@example.com",
      type: "personal",
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW).toISOString(),
      version: LICENSE_VERSION,
      keyId: TEST_KEY_ID,
    };
    const blob = await signLicense(metadata, signBytes);
    expect(blobVerifies(blob)).toBe(true);
    // tampering the metadata breaks verification
    const tampered = decodeBlob(blob);
    tampered.metadata.email = "attacker@evil.com";
    const tblob = Buffer.from(JSON.stringify(tampered)).toString("base64");
    expect(blobVerifies(tblob)).toBe(false);
  });
});

describe("crypto: production WebCrypto signing path", () => {
  // The other signing tests inject a Node-crypto signer; production signs via
  // importPkcs8Ed25519 + webCryptoSigner. Exercise that exact path (Node 22
  // WebCrypto supports Ed25519) so a PEM-strip or importKey regression can't
  // ship blobs the buyer's client rejects while the suite stays green.
  it("importPkcs8Ed25519 + webCryptoSigner produce a blob the real verifier accepts", async () => {
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const key = await importPkcs8Ed25519(pem);
    const metadata: LicenseMetadata = {
      id: "lic-wc",
      email: "wc@example.com",
      type: "personal",
      createdAt: new Date(NOW).toISOString(),
      expiresAt: null,
      version: LICENSE_VERSION,
      keyId: await keyIdOfPkcs8Ed25519(pem),
    };
    const blob = await signLicense(metadata, webCryptoSigner(key));
    expect(blobVerifies(blob)).toBe(true);
  });

  it("rejects a malformed PEM (fails closed at import, not at sign time)", async () => {
    await expect(importPkcs8Ed25519("not a pem at all")).rejects.toThrow();
  });
});

describe("crypto: verifyPaddleSignature", () => {
  const body = '{"event_id":"evt_1"}';
  const good = signPaddle(NOW_S, body);
  const v = (header: string | null, o: { body?: string; secret?: string; now?: number } = {}) =>
    verifyPaddleSignature(header, o.body ?? body, o.secret ?? SECRET, o.now ?? NOW, 300);

  it("accepts a vector computed exactly as the Paddle Node SDK computes it", async () => {
    // Hardcoded: secret, ts, body and h1 from the SDK's construction.
    const h1 = crypto
      .createHmac("sha256", "pdl_ntfset_vector")
      .update('1700000000:{"a":1}')
      .digest("hex");
    expect(
      await verifyPaddleSignature(`ts=1700000000;h1=${h1}`, '{"a":1}', "pdl_ntfset_vector", NOW, 5),
    ).toBe(true);
  });

  it("matches any of multiple h1 entries", async () => {
    expect(await v(`ts=${NOW_S};h1=${"0".repeat(64)};h1=${good}`)).toBe(true);
  });

  it("refuses more than 8 h1 entries even when one matches", async () => {
    const many = Array.from({ length: 8 }, () => `h1=${"0".repeat(64)}`).join(";");
    expect(await v(`ts=${NOW_S};${many};h1=${good}`)).toBe(false);
  });

  it("refuses non-hex, short and uppercase-mismatched h1, missing/duplicate/stale ts", async () => {
    expect(await v(`ts=${NOW_S};h1=zz${good.slice(2)}`)).toBe(false);
    expect(await v(`ts=${NOW_S};h1=${good.slice(0, 62)}`)).toBe(false);
    expect(await v(`h1=${good}`)).toBe(false);
    expect(await v(`ts=${NOW_S};ts=${NOW_S};h1=${good}`)).toBe(false);
    expect(await v(`ts=${NOW_S};h1=${good}`, { now: NOW + 600_000 })).toBe(false);
    expect(await v(`ts=${NOW_S};h1=${good}`, { now: NOW - 600_000 })).toBe(false);
    expect(await v(`ts=12ab;h1=${good}`)).toBe(false);
    expect(await v(null)).toBe(false);
  });

  it("a one-whitespace body tamper fails, and a base64-decoded secret fails", async () => {
    expect(await v(`ts=${NOW_S};h1=${good}`, { body: `${body} ` })).toBe(false);
    const decoded = Buffer.from(SECRET.replace(/^pdl_ntfset_/, ""), "base64").toString("latin1");
    expect(await v(`ts=${NOW_S};h1=${good}`, { secret: decoded })).toBe(false);
  });

  it("hexToBytes round-trips", () => {
    expect([...hexToBytes("00ff10")]).toEqual([0, 255, 16]);
    expect(() => hexToBytes("0")).toThrow();
  });
});

// ===========================================================================
describe("handleIssuance: transaction.completed happy path", () => {
  let deps: TestDeps;
  beforeEach(() => {
    deps = baseDeps();
  });

  it("mints, entitles, emails, indexes, and marks the event done", async () => {
    const res = await handleIssuance(makeRequest(paidBody({ eventId: "evt_1" })), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rec = ledgerRec(deps);
    expect(rec.type).toBe("personal");
    expect(rec.email).toBe("buyer@example.com");
    expect(rec.emailSent).toBe(true);
    expect(rec.updateWindowEnd).toBeNull();
    const expected: LicenseEntitlement = {
      updateWindowEnd: rec.updateWindowEnd,
      status: "personal",
      version: LICENSE_VERSION,
    };
    expect(JSON.parse(deps.entitlementKv.map.get(rec.licenseId) as string)).toEqual(expected);
    expect(deps.ledgerKv.map.get("evt:live:evt_1")).toBe("done");
    expect(deps.ledgerKv.putOptions.get("evt:live:evt_1")).toEqual({ expirationTtl: EVENT_TTL_S });
    expect(deps.ledgerKv.putOptions.get("order:live:txn_1")).toBeUndefined();
    expect(deps.ledgerKv.map.get(`txnlic:live:txn_1:${rec.licenseId}`)).toBe("");
    expect(deps.ledgerKv.putOptions.get(`txnlic:live:txn_1:${rec.licenseId}`)).toBeUndefined();
    expect(deps.lookupCustomer).toHaveBeenCalledExactlyOnceWith("ctm_1");
    const blob = deps.sendEmail.mock.calls[0][1] as string;
    expect(blobVerifies(blob)).toBe(true);
    expect(decodeBlob(blob).metadata.keyId).toBe(TEST_KEY_ID);
  });

  it("issued and adjustment events resolve the SAME ledger key (txnIdOf)", async () => {
    await handleIssuance(makeRequest(paidBody({ txnId: "txn_pair" })), deps);
    expect(deps.ledgerKv.map.get("order:live:txn_pair")).toBeDefined();
    await handleIssuance(makeRequest(refundBody({ adjId: "adj_pair", txnId: "txn_pair" })), deps);
    expect(lastLog(deps)).toEqual({ result: "revoked", ts: NOW / 1000 });
    expect(ledgerRec(deps, "txn_pair").refunded).toBe(true);
    expect(deps.ledgerKv.map.get("order:live:adj_pair")).toBeUndefined();
  });

  it("never returns the blob and logs only { result, ts } on success", async () => {
    const res = await handleIssuance(makeRequest(paidBody()), deps);
    const blob = deps.sendEmail.mock.calls[0][1] as string;
    expect(JSON.stringify(await res.json())).not.toContain(blob.slice(0, 20));
    for (const [entry] of deps.log.mock.calls) {
      expect(Object.keys(entry as object).sort()).toEqual(["result", "ts"]);
    }
  });

  it("grandfathered email → type grandfathered", async () => {
    deps = baseDeps({ isGrandfathered: (e) => e === "buyer@example.com", hasGrandfathers: true });
    await handleIssuance(makeRequest(paidBody({ txnId: "txn_gf" })), deps);
    expect(ledgerRec(deps, "txn_gf").type).toBe("grandfathered");
  });

  it("a maximum-length (254-char) email still produces a verifiable blob under the size cap", async () => {
    const longEmail = `${"x".repeat(254 - "@example.com".length)}@example.com`;
    expect(longEmail).toHaveLength(254);
    deps = baseDeps({ lookupCustomer: buyer(longEmail) });
    await handleIssuance(makeRequest(paidBody()), deps);
    const blob = deps.sendEmail.mock.calls[0][1] as string;
    expect(blobVerifies(blob)).toBe(true);
    expect(decodeBlob(blob).metadata.email).toBe(longEmail);
    expect(base64ToBytes(blob).length).toBeLessThan(4096);
  });

  it("mints metadata with no `name`, even when Paddle's customer record has one", async () => {
    // A license carries the email alone (docs/licensing-operations.md §0,
    // decision 2); the Paddle lookup may still return a name, and it is ignored.
    deps = baseDeps({
      lookupCustomer: vi.fn(async () => ({
        ok: true as const,
        email: "buyer@example.com",
        name: "Jane Buyer",
      })),
    });
    await handleIssuance(makeRequest(paidBody()), deps);
    const blob = deps.sendEmail.mock.calls[0][1] as string;
    expect(blobVerifies(blob)).toBe(true);
    expect(Object.keys(decodeBlob(blob).metadata).sort()).toEqual([
      "createdAt",
      "email",
      "expiresAt",
      "id",
      "keyId",
      "type",
      "version",
    ]);
    expect(ledgerRec(deps)).not.toHaveProperty("name");
  });

  it("two paidBody() calls without eventId get DIFFERENT event ids", () => {
    expect(JSON.parse(paidBody()).event_id).not.toBe(JSON.parse(paidBody()).event_id);
  });
});

describe("handleIssuance: idempotency & recovery", () => {
  it("short-circuits a fully-processed replay (same event_id) without re-minting", async () => {
    const deps = baseDeps();
    const body = paidBody({ eventId: "evt_1" });
    await handleIssuance(makeRequest(body), deps);
    const first = ledgerRec(deps).licenseId;
    const res2 = await handleIssuance(makeRequest(body), deps);
    expect(res2.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledOnce();
    expect(lastLog(deps)).toEqual({ result: "duplicate", ts: NOW / 1000 });
    expect(ledgerRec(deps).licenseId).toBe(first);
  });

  it("recovers a failed email on the retry (same event_id, not marked done)", async () => {
    let calls = 0;
    const sendEmail = vi.fn(async () => ({ ok: ++calls > 1 }));
    const deps = baseDeps({ sendEmail });
    const body = paidBody({ eventId: "evt_1" });
    const res1 = await handleIssuance(makeRequest(body), deps);
    expect(res1.status).toBe(500); // Paddle retries
    expect(deps.ledgerKv.map.get("evt:live:evt_1")).toBeUndefined();
    const res2 = await handleIssuance(makeRequest(body), deps);
    expect(res2.status).toBe(200);
    expect(ledgerRec(deps).emailSent).toBe(true);
    expect(deps.lookupCustomer).toHaveBeenCalledOnce(); // re-drive does no lookup
  });

  it("re-drives under a DIFFERENT event_id without re-minting", async () => {
    const deps = baseDeps();
    await handleIssuance(makeRequest(paidBody({ eventId: "evt_1" })), deps);
    const first = ledgerRec(deps).licenseId;
    const putSpy = vi.spyOn(deps.entitlementKv, "put");
    await handleIssuance(makeRequest(paidBody({ eventId: "evt_2" })), deps);
    expect(lastLog(deps)).toEqual({ result: "duplicate", ts: NOW / 1000 });
    expect(putSpy).toHaveBeenCalledExactlyOnceWith(first, expect.any(String));
  });

  it("a corrupt ledger record → retryable 500 tagged 'ledger'", async () => {
    const deps = baseDeps();
    deps.ledgerKv.map.set("order:live:txn_1", "{corrupt");
    const res = await handleIssuance(makeRequest(paidBody()), deps);
    expect(res.status).toBe(500);
    expect(lastLog(deps)).toEqual({ result: "error", ts: NOW / 1000, stage: "ledger" });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("a failed email logs stage 'email' with the upstream status", async () => {
    const deps = baseDeps({ sendEmail: vi.fn(async () => ({ ok: false, status: 422 })) });
    await handleIssuance(makeRequest(paidBody()), deps);
    expect(lastLog(deps)).toEqual({ result: "error", ts: NOW / 1000, stage: "email", status: 422 });
  });
});

describe("handleIssuance: issue() order of operations", () => {
  async function ledgered(deps: TestDeps) {
    await handleIssuance(makeRequest(paidBody({ eventId: "evt_first" })), deps);
    deps.lookupCustomer.mockClear();
  }

  it("a redelivered ledgered order with customer_id null is re-driven, no lookup", async () => {
    const deps = baseDeps();
    await ledgered(deps);
    const res = await handleIssuance(makeRequest(paidBody({ customerId: null })), deps);
    expect(res.status).toBe(200);
    expect(lastLog(deps)).toEqual({ result: "duplicate", ts: NOW / 1000 });
    expect(deps.lookupCustomer).not.toHaveBeenCalled();
  });

  it("a redelivered ledgered order whose price was removed is re-driven, no lookup", async () => {
    const deps = baseDeps();
    await ledgered(deps);
    deps.priceIds = ["pri_other"];
    await handleIssuance(makeRequest(paidBody()), deps);
    expect(lastLog(deps)).toEqual({ result: "duplicate", ts: NOW / 1000 });
    expect(deps.lookupCustomer).not.toHaveBeenCalled();
  });

  it("a new order with a foreign price, an empty cart, or a mixed cart is dropped", async () => {
    for (const items of [
      [{ price: { id: "pri_foreign" } }],
      [],
      [{ price: { id: "pri_test1" } }, { price: { id: "pri_foreign" } }],
    ]) {
      const deps = baseDeps();
      const res = await handleIssuance(makeRequest(paidBody({ items })), deps);
      expect(res.status).toBe(200);
      expect(lastLog(deps).result).toBe("dropped");
      expect(deps.lookupCustomer).not.toHaveBeenCalled();
    }
  });

  it("a FREE order with a foreign price is ignored: no record, no alert, no lookup", async () => {
    // Otherwise anyone holding the client token could drain the alert quota
    // with free checkouts of some other $0 price.
    const deps = baseDeps({ hasGrandfathers: true, isGrandfathered: () => true });
    const res = await handleIssuance(
      makeRequest(
        paidBody({
          eventId: "evt_ff",
          items: [{ price: { id: "pri_foreign" } }],
          totals: { grand_total: "0", total: "0" },
        }),
      ),
      deps,
    );
    expect(res.status).toBe(200);
    expect(lastLog(deps)).toEqual({ result: "ignored", ts: NOW / 1000 });
    expect(noticeKeys(deps)).toEqual([]);
    expect(deps.lookupCustomer).not.toHaveBeenCalled();
  });

  it("a sandbox Worker mints only for listed buyers; anyone else is ignored before minting", async () => {
    const listed = baseDeps({ sandboxBuyers: new Set(["buyer@example.com"]) });
    await handleIssuance(makeRequest(paidBody()), listed);
    expect(lastLog(listed)).toEqual({ result: "issued", ts: NOW / 1000 });

    const other = baseDeps({ sandboxBuyers: new Set(["bryan@example.com"]) });
    await handleIssuance(makeRequest(paidBody()), other);
    expect(lastLog(other)).toEqual({ result: "ignored", ts: NOW / 1000 });
    expect(other.ledgerKv.map.has("order:live:txn_1")).toBe(false);
    expect(other.sendEmail).not.toHaveBeenCalled();
  });

  it("status ≠ completed, a bad txn id, a bad customer id → dropped", async () => {
    for (const o of [
      { status: "paid" },
      { txnId: "ord_1" },
      { customerId: null },
      { customerId: "x" },
    ]) {
      const deps = baseDeps();
      await handleIssuance(makeRequest(paidBody(o)), deps);
      expect(lastLog(deps).result).toBe("dropped");
    }
  });

  it("a 100%-code order: grandfathered buyer → lookup then issued; anyone else → ignored", async () => {
    const free = { grand_total: "0", total: "0" };
    const gf = baseDeps({
      hasGrandfathers: true,
      isGrandfathered: (e) => e === "buyer@example.com",
    });
    await handleIssuance(makeRequest(paidBody({ totals: free })), gf);
    expect(gf.lookupCustomer).toHaveBeenCalledOnce();
    expect(lastLog(gf)).toEqual({ result: "issued", ts: NOW / 1000 });
    expect(ledgerRec(gf).type).toBe("grandfathered");

    const other = baseDeps({ hasGrandfathers: true, isGrandfathered: () => false });
    const body = paidBody({ eventId: "evt_free", totals: free });
    await handleIssuance(makeRequest(body), other);
    expect(other.lookupCustomer).toHaveBeenCalledOnce();
    expect(lastLog(other)).toEqual({ result: "ignored", ts: NOW / 1000 });
    expect(other.ledgerKv.map.get("evt:live:evt_free")).toBeUndefined(); // not marked
  });

  it("a free order with an EMPTY grandfather list makes no lookup call", async () => {
    const deps = baseDeps({ hasGrandfathers: false });
    await handleIssuance(makeRequest(paidBody({ totals: { grand_total: "0", total: "0" } })), deps);
    expect(deps.lookupCustomer).not.toHaveBeenCalled();
    expect(lastLog(deps).result).toBe("ignored");
  });

  it("free-order totals: '4500' issues, unparseable either field → dropped, never reads balance", async () => {
    const paid = baseDeps();
    await handleIssuance(
      makeRequest(paidBody({ totals: { grand_total: "4500", total: "4500", balance: "0" } })),
      paid,
    );
    expect(lastLog(paid).result).toBe("issued");
    for (const totals of [
      { grand_total: 4500, total: "4500" },
      { grand_total: "4500" },
      { grand_total: "45.00", total: "4500" },
      {},
    ]) {
      const deps = baseDeps();
      await handleIssuance(makeRequest(paidBody({ totals })), deps);
      expect(lastLog(deps).result).toBe("dropped");
    }
    // one positive → paid
    const mixed = baseDeps();
    await handleIssuance(
      makeRequest(paidBody({ totals: { grand_total: "0", total: "100" } })),
      mixed,
    );
    expect(lastLog(mixed).result).toBe("issued");
  });
});

describe("handleIssuance: buyer lookup mapping", () => {
  const fail = (status?: number) =>
    vi.fn(async () =>
      status === undefined ? { ok: false as const } : { ok: false as const, status },
    );

  it("404 and other 4xx → dropped; 401/403 → 500 paddle-api-auth; 429/5xx/network → 500 paddle-api", async () => {
    const cases: [number | undefined, number, Record<string, unknown>][] = [
      [404, 200, { result: "dropped" }],
      [400, 200, { result: "dropped" }],
      [422, 200, { result: "dropped" }],
      [401, 500, { result: "error", stage: "paddle-api-auth", status: 401 }],
      [403, 500, { result: "error", stage: "paddle-api-auth", status: 403 }],
      [408, 500, { result: "error", stage: "paddle-api", status: 408 }],
      [429, 500, { result: "error", stage: "paddle-api", status: 429 }],
      [503, 500, { result: "error", stage: "paddle-api", status: 503 }],
      [undefined, 500, { result: "error", stage: "paddle-api" }],
    ];
    for (const [status, http, expected] of cases) {
      const deps = baseDeps({ lookupCustomer: fail(status) });
      const res = await handleIssuance(makeRequest(paidBody()), deps);
      expect(res.status).toBe(http);
      expect(lastLog(deps)).toMatchObject(expected);
      expect(deps.ledgerKv.map.has("order:live:txn_1")).toBe(false);
    }
  });

  it("re-drives a ledger record that still carries a pre-2026-10-20 `name`, signing none", async () => {
    // Extra fields are tolerated, so an old-shape record is not "corrupt"; the
    // re-signed blob is built field by field and leaves the name out.
    const deps = baseDeps();
    deps.ledgerKv.map.set(
      "order:live:txn_1",
      JSON.stringify({
        orderId: "txn_1",
        licenseId: "lic-old",
        email: "buyer@example.com",
        name: "Jane Buyer",
        type: "personal",
        createdAt: new Date(NOW).toISOString(),
        updateWindowEnd: null,
        emailSent: false,
        refunded: false,
      }),
    );
    await handleIssuance(makeRequest(paidBody()), deps);
    expect(lastLog(deps).result).toBe("duplicate");
    const blob = deps.sendEmail.mock.calls[0][1] as string;
    expect(blobVerifies(blob)).toBe(true);
    expect(decodeBlob(blob).metadata).not.toHaveProperty("name");
    expect(decodeBlob(blob).metadata.id).toBe("lic-old");
    // Re-saving the record also drops the name from the ledger itself.
    const stored = JSON.parse(deps.ledgerKv.map.get("order:live:txn_1") as string);
    expect(stored.emailSent).toBe(true);
    expect(stored).not.toHaveProperty("name");
  });

  it("unusable email → dropped", async () => {
    const bad = baseDeps({ lookupCustomer: buyer("not-an-email@nodot") });
    await handleIssuance(makeRequest(paidBody()), bad);
    expect(lastLog(bad).result).toBe("dropped");
  });
});

describe("handleIssuance: gate and dispatcher", () => {
  it("missing Paddle-Signature → 400; bad signature → 401, no side effects", async () => {
    const deps = baseDeps();
    const req = new Request("https://x/", { method: "POST", body: paidBody() });
    expect((await handleIssuance(req, deps)).status).toBe(400);
    const bad = await handleIssuance(
      makeRequest(paidBody(), { sig: `ts=${NOW_S};h1=${"0".repeat(64)}` }),
      deps,
    );
    expect(bad.status).toBe(401);
    expect(deps.ledgerKv.map.size).toBe(0);
  });

  it("valid signature + non-JSON / missing event_type / missing event_id → dropped + notice record, not marked", async () => {
    for (const body of [
      "not json",
      JSON.stringify({ event_id: "evt_nt", data: {} }),
      JSON.stringify({ event_type: "transaction.completed", data: {} }),
    ]) {
      const deps = baseDeps();
      const res = await handleIssuance(makeRequest(body), deps);
      expect(res.status).toBe(200);
      expect(lastLog(deps).result).toBe("dropped");
      expect(noticeKeys(deps)).toHaveLength(1);
      expect(noticeKeys(deps)[0]).toMatch(/^notice:live:dropped:(evt_nt|body_[0-9a-f]{16})$/);
      expect([...deps.ledgerKv.map.keys()].some((k) => k.startsWith("evt:"))).toBe(false);
    }
  });

  it("an oversized body still 400s before verification", async () => {
    const deps = baseDeps();
    const big = JSON.stringify({ event_id: "evt_big", pad: "x".repeat(300_000) });
    expect((await handleIssuance(makeRequest(big), deps)).status).toBe(400);
    expect(deps.ledgerKv.map.size).toBe(0);
  });

  it("unknown event type → ignored and marked done", async () => {
    const deps = baseDeps();
    const body = JSON.stringify({ event_id: "evt_x", event_type: "checkout.created", data: {} });
    await handleIssuance(makeRequest(body), deps);
    expect(lastLog(deps)).toEqual({ result: "ignored", ts: NOW / 1000 });
    expect(deps.ledgerKv.map.get("evt:live:evt_x")).toBe("done");
  });

  it("a Notice outcome replies 200 (not 500), records, marks done; a Failure still replies 500", async () => {
    const deps = baseDeps();
    const body = JSON.stringify({
      event_id: "evt_ak",
      event_type: "api_key.expiring",
      data: { id: "apikey_01abc" },
    });
    const res = await handleIssuance(makeRequest(body), deps);
    expect(res.status).toBe(200);
    expect(lastLog(deps)).toEqual({
      result: "noticed",
      ts: NOW / 1000,
      notice: "api-key-expiry",
      ref: "apikey_01abc",
    });
    expect(
      JSON.parse(deps.ledgerKv.map.get("notice:live:api-key-expiry:apikey_01abc") as string),
    ).toEqual({
      stage: "api-key-expiry",
      eventType: "api_key.expiring",
      at: new Date(NOW).toISOString(),
    });
    expect(deps.ledgerKv.map.get("evt:live:evt_ak")).toBe("done");

    const failing = baseDeps({ sendEmail: vi.fn(async () => ({ ok: false })) });
    expect((await handleIssuance(makeRequest(paidBody()), failing)).status).toBe(500);
  });

  it("an api_key event with an unexpected id shape falls back to event_id as ref", async () => {
    const deps = baseDeps();
    const body = JSON.stringify({
      event_id: "evt_ak2",
      event_type: "api_key.expired",
      data: { id: "WEIRD" },
    });
    await handleIssuance(makeRequest(body), deps);
    expect(noticeKeys(deps)).toEqual(["notice:live:api-key-expiry:evt_ak2"]);
  });

  it("a failed notice write → 500 and no marker", async () => {
    const deps = baseDeps();
    const realPut = deps.ledgerKv.put.bind(deps.ledgerKv);
    deps.ledgerKv.put = async (k, v, o) => {
      if (k.startsWith("notice:")) throw new Error("KV down");
      return realPut(k, v, o);
    };
    const body = refundBody({ eventId: "evt_np", type: "partial" });
    const res = await handleIssuance(makeRequest(body), deps);
    expect(res.status).toBe(500);
    expect(lastLog(deps)).toEqual({ result: "error", ts: NOW / 1000, stage: "notice-write" });
    expect(isAlertable({ result: "error", ts: 0, stage: "notice-write" })).toBe(true);
    expect(deps.ledgerKv.map.get("evt:live:evt_np")).toBeUndefined();
    // and a failed DROPPED record write too
    const dres = await handleIssuance(makeRequest("not json"), deps);
    expect(dres.status).toBe(500);
    expect(lastLog(deps)).toEqual({ result: "error", ts: NOW / 1000, stage: "notice-write" });
  });

  it("a malformed or over-long event_id is marked by its body digest, and a redelivery dedupes on it", async () => {
    for (const eventId of ["EVT-not-paddle", `evt_${"a".repeat(600)}`]) {
      const deps = baseDeps();
      const body = paidBody({ eventId });
      await handleIssuance(makeRequest(body), deps);
      expect(lastLog(deps).result).toBe("issued");
      const markers = [...deps.ledgerKv.map.keys()].filter((k) => k.startsWith("evt:"));
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatch(/^evt:live:body_[0-9a-f]{16}$/);
      await handleIssuance(makeRequest(body), deps);
      expect(lastLog(deps)).toEqual({ result: "duplicate", ts: NOW / 1000 });
      expect(deps.sendEmail).toHaveBeenCalledOnce();
    }
  });

  it("a dropped event writes notice:<mode>:dropped:<event_id> before replying, test mode keyed test", async () => {
    const deps = baseDeps({ isTest: true });
    await handleIssuance(makeRequest(paidBody({ eventId: "evt_dr", status: "paid" })), deps);
    expect(noticeKeys(deps)).toEqual(["notice:test:dropped:evt_dr"]);
    expect(lastLog(deps)).toEqual({
      result: "dropped",
      ts: NOW / 1000,
      notice: "dropped",
      ref: "evt_dr",
    });
    // The record carries the transaction when one could be derived.
    expect(JSON.parse(deps.ledgerKv.map.get("notice:test:dropped:evt_dr") as string)).toMatchObject(
      {
        stage: "dropped",
        txnId: "txn_1",
        eventType: "transaction.completed",
      },
    );
  });

  it("a dropped event's re-send after a fix reprocesses (not marked done)", async () => {
    const deps = baseDeps({
      lookupCustomer: vi.fn(async () => ({ ok: false as const, status: 404 })),
    });
    const body = paidBody({ eventId: "evt_re" });
    await handleIssuance(makeRequest(body), deps);
    expect(lastLog(deps).result).toBe("dropped");
    deps.lookupCustomer = buyer();
    await handleIssuance(makeRequest(body), deps);
    expect(lastLog(deps)).toEqual({ result: "issued", ts: NOW / 1000 });
  });
});

describe("handleIssuance: adjustments (first-match table)", () => {
  async function issued(o: { isTest?: boolean } = {}) {
    const deps = baseDeps(o);
    await handleIssuance(makeRequest(paidBody({ eventId: "evt_paid" })), deps);
    return deps;
  }

  const rows: [string, string, string, string, string | null][] = [
    // action, status, type, expected result, notice
    ["refund", "approved", "full", "revoked", null],
    ["refund", "approved", "partial", "noticed", "refund-partial"],
    ["credit", "approved", "full", "revoked", null],
    ["credit", "approved", "partial", "noticed", "credit-partial"],
    ["chargeback", "approved", "full", "revoked", null],
    ["chargeback", "approved", "partial", "revoked", null],
    ["chargeback_warning", "approved", "full", "settled", null],
    ["chargeback_warning_reverse", "approved", "partial", "settled", null],
    ["chargeback_reverse", "approved", "full", "noticed", "chargeback-reverse"],
    ["credit_reverse", "approved", "full", "noticed", "credit-reverse"],
    ["refund", "pending_approval", "full", "settled", null],
    ["refund", "rejected", "full", "settled", null],
    ["refund", "reversed", "full", "noticed", "adjustment-reversed"],
    ["chargeback", "reversed", "full", "noticed", "adjustment-reversed"],
    ["refund", "weird", "full", "dropped", "dropped"],
    ["weird", "approved", "full", "dropped", "dropped"],
    ["refund", "approved", "weird", "dropped", "dropped"],
  ];

  for (const [action, status, type, result, notice] of rows) {
    it(`${action}/${status}/${type} → ${result}${notice ? ` ${notice}` : ""}`, async () => {
      const deps = await issued();
      const licenseId = ledgerRec(deps).licenseId;
      const res = await handleIssuance(
        makeRequest(refundBody({ eventId: "evt_adj", action, status, type })),
        deps,
      );
      expect(res.status).toBe(200);
      expect(lastLog(deps).result).toBe(result);
      if (notice) expect(lastLog(deps).notice).toBe(notice);
      if (result === "revoked") {
        expectRevoked(deps, licenseId);
        expect(ledgerRec(deps).refunded).toBe(true);
      } else {
        expectLive(deps, licenseId);
        expect(ledgerRec(deps).refunded).toBe(false);
      }
      const marked = deps.ledgerKv.map.get("evt:live:evt_adj") === "done";
      expect(marked).toBe(result !== "dropped");
      if (result === "noticed") {
        const rec = JSON.parse(deps.ledgerKv.map.get(`notice:live:${notice}:adj_1`) as string);
        expect(rec).toMatchObject({
          stage: notice,
          txnId: "txn_1",
          eventType: "adjustment.created",
        });
      }
    });
  }

  it("pending → approved: settles, then revokes on adjustment.updated", async () => {
    const deps = await issued();
    const licenseId = ledgerRec(deps).licenseId;
    await handleIssuance(makeRequest(refundBody({ status: "pending_approval" })), deps);
    expect(lastLog(deps).result).toBe("settled");
    expectLive(deps, licenseId);
    await handleIssuance(makeRequest(refundBody({ eventType: "adjustment.updated" })), deps);
    expect(lastLog(deps).result).toBe("revoked");
    expectRevoked(deps, licenseId);
  });

  it("pending → rejected: settles twice, license kept", async () => {
    const deps = await issued();
    const licenseId = ledgerRec(deps).licenseId;
    await handleIssuance(makeRequest(refundBody({ status: "pending_approval" })), deps);
    await handleIssuance(
      makeRequest(refundBody({ eventType: "adjustment.updated", status: "rejected" })),
      deps,
    );
    expect(lastLog(deps).result).toBe("settled");
    expectLive(deps, licenseId);
  });

  it("a partial refund before the paid event → notice only; the later paid event still issues", async () => {
    const deps = baseDeps();
    await handleIssuance(makeRequest(refundBody({ type: "partial" })), deps);
    expect(lastLog(deps).result).toBe("noticed");
    expect(deps.ledgerKv.map.has("order:live:txn_1")).toBe(false);
    await handleIssuance(makeRequest(paidBody()), deps);
    expect(lastLog(deps)).toEqual({ result: "issued", ts: NOW / 1000 });
  });

  it("a full refund before the paid event tombstones and blocks issuance", async () => {
    const deps = baseDeps();
    await handleIssuance(makeRequest(refundBody({ txnId: "txn_race" })), deps);
    expect(lastLog(deps)).toEqual({ result: "revoked", ts: NOW / 1000 });
    await handleIssuance(makeRequest(paidBody({ txnId: "txn_race" })), deps);
    expect(lastLog(deps)).toEqual({ result: "duplicate", ts: NOW / 1000 });
    expect(deps.entitlementKv.map.size).toBe(0);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("does not resurrect a refunded entitlement when the paid event retries", async () => {
    const deps = baseDeps({ sendEmail: vi.fn(async () => ({ ok: false })) });
    const paid = paidBody({ eventId: "evt_p1" });
    await handleIssuance(makeRequest(paid), deps);
    const licenseId = ledgerRec(deps).licenseId;
    await handleIssuance(makeRequest(refundBody()), deps);
    expectRevoked(deps, licenseId);
    await handleIssuance(makeRequest(paid), deps);
    expectRevoked(deps, licenseId);
  });

  it("an adjustment with a malformed transaction_id is dropped, even when pending (placement guess)", async () => {
    const deps = await issued();
    await handleIssuance(
      makeRequest(refundBody({ txnId: "bogus", status: "pending_approval" })),
      deps,
    );
    expect(lastLog(deps).result).toBe("dropped");
  });

  it("two notices / two drops for different refs both alert (throttle keyed by ref)", () => {
    const a = {
      result: "noticed" as const,
      ts: 0,
      notice: "refund-partial" as const,
      ref: "adj_a",
    };
    const b = { ...a, ref: "adj_b" };
    expect(alertThrottleKey(a)).not.toBe(alertThrottleKey(b));
    expect(
      alertThrottleKey({ result: "dropped", ts: 0, notice: "dropped", ref: "evt_a" }),
    ).not.toBe(alertThrottleKey({ result: "dropped", ts: 0, notice: "dropped", ref: "evt_b" }));
    expect(alertThrottleKey({ result: "error", ts: 0, stage: "email" })).toBe("error:email");
  });
});

describe("handleIssuance: double mint", () => {
  it("two mints for one txn → two txnlic keys; a full refund tombstones both", async () => {
    const deps = baseDeps();
    // Simulate the race: both requests read "no record" through the recheck.
    const realGet = deps.ledgerKv.get.bind(deps.ledgerKv);
    let blind = true;
    deps.ledgerKv.get = vi.fn(async (k: string) =>
      blind && k.startsWith("order:") ? null : realGet(k),
    );
    await handleIssuance(makeRequest(paidBody({ eventId: "evt_m1" })), deps);
    await handleIssuance(makeRequest(paidBody({ eventId: "evt_m2" })), deps);
    blind = false;
    const idx = [...deps.ledgerKv.map.keys()].filter((k) => k.startsWith("txnlic:live:txn_1:"));
    expect(idx).toHaveLength(2);
    const ids = idx.map((k) => k.split(":").at(-1) as string);
    expect(ledgerRec(deps).licenseId).toBe(ids[1]); // ledger holds only the second
    await handleIssuance(makeRequest(refundBody()), deps);
    for (const id of ids) expectRevoked(deps, id);
  });

  it("applyRefund pages through a multi-page list", async () => {
    const deps = baseDeps();
    await handleIssuance(makeRequest(paidBody()), deps);
    deps.ledgerKv.map.set("txnlic:live:txn_1:lic-extra", "");
    const realList = deps.ledgerKv.list;
    deps.ledgerKv.list = vi.fn(async (o: { prefix: string; cursor?: string }) => {
      const all = (await realList(o)).keys;
      return o.cursor === undefined
        ? { keys: all.slice(0, 1), list_complete: false, cursor: "c1" }
        : { keys: all.slice(1), list_complete: true };
    });
    await handleIssuance(makeRequest(refundBody()), deps);
    expectRevoked(deps, "lic-1");
    expectRevoked(deps, "lic-extra");
  });

  it("the index entry is written BEFORE the ledger record (index ⊇ ledger)", async () => {
    const deps = baseDeps();
    const realPut = deps.ledgerKv.put.bind(deps.ledgerKv);
    deps.ledgerKv.put = async (k, v, o) => {
      if (k.startsWith("txnlic:")) throw new Error("KV down");
      return realPut(k, v, o);
    };
    const res = await handleIssuance(makeRequest(paidBody()), deps);
    expect(res.status).toBe(500);
    expect(deps.ledgerKv.map.has("order:live:txn_1")).toBe(false);
  });

  it("a refund still revokes the ledger's own license when the index listing is stale", async () => {
    // KV list() lags writes by up to ~60 s; the ledger's licenseId is the
    // backstop for a refund that lands inside that window.
    const deps = baseDeps();
    await handleIssuance(makeRequest(paidBody()), deps);
    deps.ledgerKv.list = vi.fn(async () => ({ keys: [], list_complete: true }));
    await handleIssuance(makeRequest(refundBody()), deps);
    expectRevoked(deps, "lic-1");
  });

  it("a refund writes the ledger flag BEFORE the entitlements", async () => {
    // So a redelivery racing the refund sees `refunded` and cannot re-drive the
    // live entitlement back over the tombstone.
    const deps = baseDeps();
    await handleIssuance(makeRequest(paidBody()), deps);
    deps.entitlementKv.put = vi.fn(async () => {
      throw new Error("KV down");
    });
    const res = await handleIssuance(makeRequest(refundBody()), deps);
    expect(res.status).toBe(500);
    expect(ledgerRec(deps).refunded).toBe(true);
  });

  it("in test mode the index is mode-scoped and no entitlement is written", async () => {
    const deps = baseDeps({ isTest: true });
    await handleIssuance(makeRequest(paidBody()), deps);
    expect(deps.ledgerKv.map.has("txnlic:test:txn_1:lic-1")).toBe(true);
    await handleIssuance(makeRequest(refundBody()), deps);
    expect(deps.entitlementKv.map.size).toBe(0);
    expect(ledgerRec(deps, "txn_1", "test").refunded).toBe(true);
  });
});

describe("handleIssuance: pre-commit recheck", () => {
  it("issue() defers to a refund tombstone that lands between its read and commit", async () => {
    const deps = baseDeps();
    const tombstone = JSON.stringify({
      orderId: "txn_ri",
      licenseId: "",
      email: "",
      type: "personal",
      createdAt: new Date(NOW).toISOString(),
      updateWindowEnd: null,
      emailSent: true,
      refunded: true,
    });
    let calls = 0;
    const realGet = deps.ledgerKv.get.bind(deps.ledgerKv);
    deps.ledgerKv.get = vi.fn(async (k: string) => {
      if (k === "order:live:txn_ri") return ++calls > 1 ? tombstone : null;
      return realGet(k);
    });
    await handleIssuance(makeRequest(paidBody({ txnId: "txn_ri" })), deps);
    expect(lastLog(deps)).toEqual({ result: "duplicate", ts: NOW / 1000 });
    expect(deps.entitlementKv.map.size).toBe(0);
    expect([...deps.ledgerKv.map.keys()].some((k) => k.startsWith("txnlic:"))).toBe(false);
  });
});

describe("issuance → update Worker contract", () => {
  const MANIFEST = '{"version":"9.9.9","platforms":{}}';
  function checkUpdate(deps: TestDeps, licenseId: string) {
    const headers = new Headers();
    headers.set(LICENSE_HEADER, licenseId);
    return handleUpdateRequest(new Request("https://updates.example/latest.json", { headers }), {
      kv: deps.entitlementKv,
      latestJsonUrl: "https://example.com/latest.json",
      fetchFn: (async () => new Response(MANIFEST, { status: 200 })) as unknown as typeof fetch,
      now: () => NOW,
    });
  }
  it("an issued license is served an update; after a full refund it gets 204", async () => {
    const deps = baseDeps();
    await handleIssuance(makeRequest(paidBody()), deps);
    const { licenseId } = ledgerRec(deps);
    expect((await checkUpdate(deps, licenseId)).status).toBe(200);
    await handleIssuance(makeRequest(refundBody()), deps);
    expect((await checkUpdate(deps, licenseId)).status).toBe(204);
  });
});

describe("handleIssuance: fail-closed gates", () => {
  it("503 when the webhook secret is unconfigured; 405 on non-POST", async () => {
    expect(
      (await handleIssuance(makeRequest(paidBody()), baseDeps({ webhookSecret: "" }))).status,
    ).toBe(503);
    expect(
      (await handleIssuance(makeRequest(paidBody(), { method: "GET" }), baseDeps())).status,
    ).toBe(405);
  });

  it("the done-marker short-circuit is unreachable without a valid signature", async () => {
    const deps = baseDeps();
    deps.ledgerKv.map.set("evt:live:evt_1", "done");
    const res = await handleIssuance(
      makeRequest(paidBody({ eventId: "evt_1" }), { sig: `ts=${NOW_S};h1=${"0".repeat(64)}` }),
      deps,
    );
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
describe("default fetch wiring (env → deps)", () => {
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const nowTs = () => Math.floor(Date.now() / 1000).toString();
  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

  function makeEnv(overrides: Record<string, unknown> = {}) {
    return {
      PADDLE_WEBHOOK_SECRET: SECRET,
      PADDLE_API_KEY: "pdl_live_apikey_test1",
      PADDLE_PRICE_IDS: "pri_test1",
      TANDEM_PRIVATE_KEY: pem,
      RESEND_API_KEY: "re_test",
      RESEND_FROM: "Tandem <noreply@example.com>",
      SUPPORT_EMAIL: "support@tandem.test",
      LICENSE_KV: makeKv(),
      LEDGER_KV: makeKv(),
      ...overrides,
    };
  }

  /** Routes by host: Paddle → a customer, Resend → an email id, else 200 {}. */
  function routedFetch(o: { resend?: number; paddle?: number } = {}) {
    return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (
        url.startsWith("https://api.paddle.com/") ||
        url.startsWith("https://sandbox-api.paddle.com/")
      ) {
        return o.paddle && o.paddle !== 200
          ? new Response("{}", { status: o.paddle })
          : new Response(JSON.stringify({ data: { email: "buyer@example.com", name: "Jane" } }), {
              status: 200,
            });
      }
      if (url === "https://api.resend.com/emails") {
        return new Response('{"id":"em_1"}', { status: o.resend ?? 200 });
      }
      return new Response("{}", { status: 200 });
    });
  }
  const callsTo = (m: ReturnType<typeof routedFetch>, prefix: string) =>
    m.mock.calls.filter(([u]) => String(u).startsWith(prefix));

  async function captureLogs(fn: () => Promise<unknown>) {
    const logs: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      logs.push(JSON.parse(line));
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return logs.filter((e) => e.result === "error").map((e) => e.stage);
  }

  beforeEach(() => {
    _resetAlertThrottleForTests();
    _setTrustedKeyIdsForTests([TEST_KEY_ID]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    _setTrustedKeyIdsForTests();
  });

  it("a signing key no build trusts → 503 at stage config", async () => {
    _setTrustedKeyIdsForTests(TRUSTED_KEY_IDS);
    const env = makeEnv();
    const stages = await captureLogs(async () => {
      const res = await issuanceWorker.fetch(
        makeRequest(paidBody(), { ts: nowTs() }),
        env as never,
      );
      expect(res.status).toBe(503);
    });
    expect(stages).toContain("config");
    expect(env.LEDGER_KV.map.size).toBe(0);
  });

  it("an unset signing key on a cold isolate → 503 at stage config, not a silent 500", async () => {
    // beforeEach leaves the signer cache empty, which is a cold isolate: the
    // first request after a deploy that forgot `secret put TANDEM_PRIVATE_KEY`.
    const env = makeEnv({ TANDEM_PRIVATE_KEY: undefined });
    const stages = await captureLogs(async () => {
      const res = await issuanceWorker.fetch(
        makeRequest(paidBody(), { ts: nowTs() }),
        env as never,
      );
      expect(res.status).toBe(503);
    });
    expect(stages).toEqual(["config"]);
    expect(env.LEDGER_KV.map.size).toBe(0);
  });

  it("production: looks up the buyer at api.paddle.com, mints, emails via Resend", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv();
    const res = await issuanceWorker.fetch(
      makeRequest(paidBody({ txnId: "txn_w" }), { ts: nowTs() }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(env.LEDGER_KV.map.has("order:live:txn_w")).toBe(true);
    expect(env.LICENSE_KV.map.size).toBe(1);
    const [lookup] = callsTo(fetchMock, "https://api.paddle.com/");
    expect(String(lookup[0])).toBe("https://api.paddle.com/customers/ctm_1");
    expect((lookup[1]?.headers as Record<string, string>).Authorization).toBe(
      "Bearer pdl_live_apikey_test1",
    );
    const [[, init]] = callsTo(fetchMock, "https://api.resend.com/emails");
    const sent = JSON.parse(init?.body as string);
    expect(sent.to).toBe("buyer@example.com");
    expect(sent.reply_to).toBe("support@tandem.test");
    const fileBytes = Buffer.from(sent.attachments[0].content, "base64").toString("utf-8");
    expect(blobVerifies(fileBytes)).toBe(true);
    // Paddle answered with a name ("Jane"); none of it reaches the key, the
    // ledger or the greeting.
    expect(decodeBlob(fileBytes).metadata).not.toHaveProperty("name");
    expect(JSON.parse(env.LEDGER_KV.map.get("order:live:txn_w") as string)).not.toHaveProperty(
      "name",
    );
    expect(sent.text).not.toContain("Jane");
    for (const line of (sent.text as string).split("\n"))
      expect(line.length).toBeLessThanOrEqual(72);
  });

  it("a sandbox key derives the sandbox host", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv({
      PADDLE_API_KEY: "pdl_sdbx_apikey_test1",
      TANDEM_ISSUANCE_ENV: "sandbox",
      SANDBOX_SIGNING_UNTIL: inDays(3),
      SANDBOX_BUYER_EMAILS: "buyer@example.com",
    });
    const res = await issuanceWorker.fetch(
      makeRequest(paidBody({ txnId: "txn_s" }), { ts: nowTs() }),
      env as never,
    );
    expect(res.status).toBe(200);
    expect(callsTo(fetchMock, "https://sandbox-api.paddle.com/customers/")).toHaveLength(1);
    expect(env.LEDGER_KV.map.has("order:test:txn_s")).toBe(true);
    expect(env.LICENSE_KV.map.size).toBe(0);
  });

  it("does not alert on an ordinary successful issuance — and issuance happened", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv({ ALERT_WEBHOOK_URL: "https://hooks.example.com/quiet" });
    await issuanceWorker.fetch(
      makeRequest(paidBody({ txnId: "txn_q" }), { ts: nowTs() }),
      env as never,
    );
    expect(env.LEDGER_KV.map.has("order:live:txn_q")).toBe(true);
    expect(callsTo(fetchMock, "https://hooks.example.com/quiet")).toHaveLength(0);
  });

  it("routes an EMAIL failure away from Resend", async () => {
    const fetchMock = routedFetch({ resend: 422 });
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv({
      ALERT_WEBHOOK_URL: "https://hooks.example.com/xyz",
      ALERT_EMAIL: "ops@example.com",
    });
    const res = await issuanceWorker.fetch(makeRequest(paidBody(), { ts: nowTs() }), env as never);
    expect(res.status).toBe(500);
    expect(callsTo(fetchMock, "https://hooks.example.com/xyz")).toHaveLength(1);
    expect(callsTo(fetchMock, "https://api.resend.com/emails")).toHaveLength(1);
  });

  it("a dropped event alerts with the 200-reply tail and carries no ids", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv({ ALERT_WEBHOOK_URL: "https://hooks.example.com/d" });
    await issuanceWorker.fetch(
      makeRequest(paidBody({ eventId: "evt_dropx", txnId: "txn_dropx", status: "paid" }), {
        ts: nowTs(),
      }),
      env as never,
    );
    const [alert] = callsTo(fetchMock, "https://hooks.example.com/d");
    const text = JSON.parse(alert[1]?.body as string).text as string;
    expect(text).toMatch(/could not be fulfilled/);
    expect(text).toMatch(/Paddle will not retry this/);
    expect(text).not.toContain("evt_dropx");
    expect(text).not.toContain("txn_dropx");
  });

  it("two drops for different events within 5 minutes both alert", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv({ ALERT_WEBHOOK_URL: "https://hooks.example.com/t" });
    for (const id of ["evt_da", "evt_db"]) {
      await issuanceWorker.fetch(
        makeRequest(paidBody({ eventId: id, status: "paid" }), { ts: nowTs() }),
        env as never,
      );
    }
    expect(callsTo(fetchMock, "https://hooks.example.com/t")).toHaveLength(2);
  });

  it("a paddle-api-auth failure alerts with its own arm", async () => {
    const fetchMock = routedFetch({ paddle: 401 });
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv({ ALERT_WEBHOOK_URL: "https://hooks.example.com/a" });
    const res = await issuanceWorker.fetch(makeRequest(paidBody(), { ts: nowTs() }), env as never);
    expect(res.status).toBe(500);
    const [alert] = callsTo(fetchMock, "https://hooks.example.com/a");
    const text = JSON.parse(alert[1]?.body as string).text as string;
    expect(text).toContain("lacks customer.read");
    expect(text).toContain("60 attempts");
  });

  it("alert bodies carry no PII", async () => {
    const fetchMock = routedFetch({ resend: 422 });
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv({ ALERT_WEBHOOK_URL: "https://hooks.example.com/pii" });
    await issuanceWorker.fetch(
      makeRequest(paidBody({ txnId: "txn_pii" }), { ts: nowTs() }),
      env as never,
    );
    const [alert] = callsTo(fetchMock, "https://hooks.example.com/pii");
    const text = JSON.parse(alert[1]?.body as string).text as string;
    expect(text).not.toContain("buyer@example.com");
    expect(text).not.toContain("txn_pii");
  });

  it("grandfather matching is case-insensitive and a 100% order from a listed buyer issues", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith("https://api.paddle.com/")
          ? new Response(JSON.stringify({ data: { email: "alice@EXAMPLE.com", name: "A" } }))
          : new Response("{}"),
      ),
    );
    const env = makeEnv({ GRANDFATHER_EMAILS: "Alice@Example.com, bob@x.co" });
    await issuanceWorker.fetch(
      makeRequest(paidBody({ txnId: "txn_g", totals: { grand_total: "0", total: "0" } }), {
        ts: nowTs(),
      }),
      env as never,
    );
    expect(JSON.parse(env.LEDGER_KV.map.get("order:live:txn_g") as string).type).toBe(
      "grandfathered",
    );
  });

  it("config guard order: key → support → resend → api-key → price-ids → env-mismatch → sandbox-until", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const stages = await captureLogs(async () => {
      const envs = [
        { RESEND_FROM: "REPLACE_WITH_VERIFIED_SENDER", PADDLE_API_KEY: undefined },
        { SUPPORT_EMAIL: "  ", RESEND_FROM: undefined },
        { TANDEM_PRIVATE_KEY: "garbage-not-a-pem", SUPPORT_EMAIL: "  " },
        { PADDLE_API_KEY: undefined, PADDLE_PRICE_IDS: "" },
        { PADDLE_API_KEY: "legacy_key_format" },
        { PADDLE_PRICE_IDS: "", TANDEM_ISSUANCE_ENV: "sandbox" },
        { PADDLE_PRICE_IDS: "pri_ok, PRI_bad" },
        { TANDEM_ISSUANCE_ENV: "sandbox" },
        { PADDLE_API_KEY: "pdl_sdbx_apikey_x" },
        { PADDLE_API_KEY: "pdl_sdbx_apikey_x", SANDBOX_SIGNING_UNTIL: inDays(3) },
      ];
      for (const o of envs) {
        await issuanceWorker.fetch(makeRequest(paidBody(), { ts: nowTs() }), makeEnv(o) as never);
      }
    });
    expect(stages).toEqual([
      "config-resend-from",
      "config-support-email",
      "config",
      "config-paddle-api-key",
      "config-paddle-api-key",
      "config-price-ids",
      "config-price-ids",
      "config-env-mismatch",
      "config-sandbox-until",
      "config-sandbox-buyers",
    ]);
  });

  it("SANDBOX_SIGNING_UNTIL: missing, past, > 7 days → 503; valid date → allowed; nothing minted when refused", async () => {
    vi.stubGlobal("fetch", routedFetch());
    for (const until of [undefined, inDays(-1), inDays(8), "garbage"]) {
      const env = makeEnv({ PADDLE_API_KEY: "pdl_sdbx_apikey_x", SANDBOX_SIGNING_UNTIL: until });
      const res = await issuanceWorker.fetch(
        makeRequest(paidBody(), { ts: nowTs() }),
        env as never,
      );
      expect(res.status).toBe(503);
      expect(env.LEDGER_KV.map.size).toBe(0);
    }
    // the ops §8 end-to-end configuration: sandbox key + production
    const ok = makeEnv({
      PADDLE_API_KEY: "pdl_sdbx_apikey_x",
      SANDBOX_SIGNING_UNTIL: inDays(3),
      SANDBOX_BUYER_EMAILS: "Buyer@Example.com",
    });
    expect(
      (await issuanceWorker.fetch(makeRequest(paidBody(), { ts: nowTs() }), ok as never)).status,
    ).toBe(200);
    expect(ok.LEDGER_KV.map.has("order:live:txn_1")).toBe(true); // listed buyer → minted
  });

  it("a sandbox key with an empty, placeholder or malformed SANDBOX_BUYER_EMAILS → 503 config-sandbox-buyers, nothing minted", async () => {
    vi.stubGlobal("fetch", routedFetch());
    // The middle value is the literal wrangler.toml ships.
    for (const buyers of [" , ", "REPLACE_WITH_YOUR_OWN_TEST_EMAIL", "me@x.co, oops"]) {
      const env = makeEnv({
        PADDLE_API_KEY: "pdl_sdbx_apikey_x",
        SANDBOX_SIGNING_UNTIL: inDays(3),
        SANDBOX_BUYER_EMAILS: buyers,
      });
      const stages = await captureLogs(async () => {
        const res = await issuanceWorker.fetch(
          makeRequest(paidBody(), { ts: nowTs() }),
          env as never,
        );
        expect(res.status).toBe(503);
      });
      expect(stages, buyers).toEqual(["config-sandbox-buyers"]);
      expect(env.LEDGER_KV.map.size).toBe(0);
    }
  });

  it("a free order with GRANDFATHER_EMAILS unset makes no Paddle API call (wiring)", async () => {
    const f = routedFetch();
    vi.stubGlobal("fetch", f);
    const env = makeEnv();
    const body = paidBody({ totals: { grand_total: "0", total: "0" } });
    await captureLogs(() => issuanceWorker.fetch(makeRequest(body, { ts: nowTs() }), env as never));
    expect(callsTo(f, "https://api.paddle.com/")).toHaveLength(0);
    expect(env.LEDGER_KV.map.has("order:live:txn_1")).toBe(false);
  });

  it("a Paddle network error or a non-JSON 200 is retryable (500 paddle-api), never dropped", async () => {
    for (const respond of [
      async () => {
        throw new TypeError("network");
      },
      async () => new Response("<html>oops</html>", { status: 200 }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).startsWith("https://api.paddle.com/")
            ? respond()
            : new Response('{"id":"em_1"}', { status: 200 }),
        ),
      );
      const env = makeEnv();
      let status = 0;
      const stages = await captureLogs(async () => {
        status = (
          await issuanceWorker.fetch(makeRequest(paidBody(), { ts: nowTs() }), env as never)
        ).status;
      });
      expect(status).toBe(500);
      expect(stages).toEqual(["paddle-api"]);
      expect([...env.LEDGER_KV.map.keys()].filter((k) => k.startsWith("notice:"))).toEqual([]);
    }
  });

  it("SANDBOX_SIGNING_UNTIL must be a full zoned ISO timestamp; a date-only value is refused", () => {
    const now = Date.parse("2026-10-17T15:00:00Z");
    // Date-only parses as UTC midnight, so it is refused even when in range.
    expect(sandboxSigningAllowed("2026-10-18", now)).toBe(false);
    expect(sandboxSigningAllowed("2026-10-18T00:00", now)).toBe(false); // no zone
    expect(sandboxSigningAllowed("2026-10-17T14:59:59Z", now)).toBe(false); // past
    expect(sandboxSigningAllowed("2026-10-18T00:00:00Z", now)).toBe(true);
    expect(sandboxSigningAllowed("2026-10-18T00:00:00-04:00", now)).toBe(true);
    expect(sandboxSigningAllowed("2026-10-24T15:00:00Z", now)).toBe(true); // exactly 7 days
    expect(sandboxSigningAllowed("2026-10-24T15:00:01Z", now)).toBe(false);
  });

  it("PADDLE_PRICE_IDS ignores empty entries but still refuses a malformed one", () => {
    expect(parsePriceIds("pri_a,")).toEqual(["pri_a"]);
    expect(parsePriceIds("pri_a,, pri_b")).toEqual(["pri_a", "pri_b"]);
    expect(parsePriceIds(" , ")).toBeNull();
    expect(parsePriceIds("pri_a,PRI_b")).toBeNull();
    expect(parsePriceIds(undefined)).toBeNull();
  });

  it("a pdl_live_ key in a non-production Worker → 503 env mismatch, nothing minted", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const env = makeEnv({ TANDEM_ISSUANCE_ENV: "sandbox" });
    expect(
      (await issuanceWorker.fetch(makeRequest(paidBody(), { ts: nowTs() }), env as never)).status,
    ).toBe(503);
    expect(env.LEDGER_KV.map.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supportEmailProblem names the misconfiguration it found", () => {
    // Placeholder cases are the strings this repo actually ships (wrangler.toml
    // line 27, and the `noreply@yourdomain.com` RESEND_FROM example above it) —
    // not an invented list.
    expect(supportEmailProblem(undefined)).toBe("unset");
    expect(supportEmailProblem("")).toBe("unset");
    expect(supportEmailProblem("   \t ")).toBe("unset");
    expect(supportEmailProblem("REPLACE_WITH_SUPPORT_INBOX")).toBe("placeholder");
    expect(supportEmailProblem("replace_with_support_inbox")).toBe("placeholder");
    // A placeholder that IS address-shaped — the case a bare `@` check misses.
    expect(supportEmailProblem("support@yourdomain.com")).toBe("placeholder");
    expect(supportEmailProblem("Support <REPLACE_WITH_SUPPORT_INBOX>")).toBe("placeholder");
    expect(supportEmailProblem("support")).toBe("malformed");
    expect(supportEmailProblem("@tandem.ink")).toBe("malformed");
    expect(supportEmailProblem("support@")).toBe("malformed");
    expect(supportEmailProblem("support@tandem")).toBe("malformed"); // dotless domain
    expect(supportEmailProblem("sup port@tandem.ink")).toBe("malformed");
    // Valid, including the display-name form RESEND_FROM's own example uses —
    // an operator copying that shape across must not take issuance down.
    expect(supportEmailProblem("support@tandem.ink")).toBeNull();
    expect(supportEmailProblem("  support@tandem.ink  ")).toBeNull();
    expect(supportEmailProblem("Tandem Support <support@tandem.ink>")).toBeNull();
  });

  it("rejects an address too long to render inside the body's 72-column ceiling", () => {
    // Not a style rule. The address prints on its own line under a two-space
    // indent, directly beneath the wrapped base64 key. Push that line past 72
    // and an MTA re-encodes the body as quoted-printable, whose soft line break
    // truncates the key — the buyer's activation then fails with a valid
    // support address in the mail that broke it. The guard is the only thing
    // standing between `[vars]` and that line, so the bound belongs here.
    const longButValid =
      "Tandem Support (include your order id) <support@tandem-collab.example.com>";
    expect(longButValid.length).toBeGreaterThan(72 - 2);
    expect(supportEmailProblem(longButValid)).toBe("too-long");

    // Positive control on the same sample: the longest ACCEPTED value must
    // actually fit. Asserting only the rejection would pass with the ceiling
    // set to any number at all.
    const atCeiling = `${"a".repeat(70 - "@tandem.ink".length)}@tandem.ink`;
    expect(atCeiling).toHaveLength(72 - 2);
    expect(supportEmailProblem(atCeiling)).toBeNull();
    for (const line of licenseEmailText("QUJD", atCeiling).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(72);
    }
    expect(supportEmailProblem(`a${atCeiling}`)).toBe("too-long");
  });

  it("the license email promises all future updates and no window or renewal (A5)", () => {
    // Joined so a reflow of the copy cannot split a phrase across lines.
    const text = licenseEmailText("QUJD", "support@tandem.ink").replace(/\s+/g, " ");
    expect(text).toContain("never expires");
    expect(text).toContain("includes all future updates");
    expect(text).not.toMatch(/first year|renew|one year|update window/i);
  });

  it("the license email links the Terms, the Refund Policy and Paddle's buyer support", () => {
    const text = licenseEmailText("QUJD", "support@tandem.ink");
    expect(text).toContain("https://tandem.ink/terms");
    expect(text).toContain("https://tandem.ink/refunds");
    expect(text).toContain("https://paddle.net");
  });

  it("the license email speaks as one person and does not invite a reply under the key", () => {
    // Sales copy is in the licensor's singular voice, and a reply would quote
    // the key printed above the support line.
    const text = licenseEmailText("QUJD", "support@tandem.ink").replace(/\s+/g, " ");
    expect(text).toContain("-- Bryan Kolb");
    expect(text).not.toMatch(/\b(we|us|our|team)\b/i);
    expect(text).not.toMatch(/\breply\b/i);
    // The CLI route is the npm install's alone: the desktop bundle ships no
    // `tandem` command, and an npm CLI activates its own app-data directory.
    expect(text).toContain("If you installed Tandem with npm");
  });

  it("an unset RESEND_API_KEY → retryable 500, not a silent drop", async () => {
    vi.stubGlobal("fetch", routedFetch());
    const env = makeEnv({ RESEND_API_KEY: undefined });
    const res = await issuanceWorker.fetch(
      makeRequest(paidBody({ txnId: "txn_r" }), { ts: nowTs() }),
      env as never,
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(env.LEDGER_KV.map.get("order:live:txn_r") as string).emailSent).toBe(false);
  });

  it("resendFromProblem names the misconfiguration, diverging only on length", () => {
    expect(resendFromProblem(undefined)).toBe("unset");
    // The literal value shipped in infra/license-issuance-worker/wrangler.toml.
    expect(resendFromProblem("REPLACE_WITH_VERIFIED_SENDER")).toBe("placeholder");
    // The half-edited form: the toml's own example domain, left in place.
    expect(resendFromProblem("Tandem <noreply@yourdomain.com>")).toBe("placeholder");
    expect(resendFromProblem("noreply")).toBe("malformed");
    expect(resendFromProblem("Tandem <noreply@tandem.ink>")).toBeNull();

    // The one deliberate divergence. MAX_SUPPORT_EMAIL_LEN (70) exists because
    // SUPPORT_EMAIL is PRINTED in the email body under a two-space indent, and a
    // line over 72 columns invites an MTA to re-encode as quoted-printable,
    // whose soft break truncates the base64 key. RESEND_FROM is a header, never
    // rendered, so the cap would 503 a perfectly legal long display name.
    // The length is asserted rather than eyeballed — a hand-picked "long"
    // literal is easily under the cap, and then this pins nothing.
    const long = `Tandem Support (include your order id) <${"a".repeat(20)}@tandem.ink>`;
    expect(long.length).toBeGreaterThan(70); // MAX_SUPPORT_EMAIL_LEN
    expect(supportEmailProblem(long)).toBe("too-long");
    expect(resendFromProblem(long)).toBeNull();
  });

  it("isAlertable covers exactly dropped, noticed, email/paddle-api*/notice-write/ledger errors and the config stages", () => {
    expect(isAlertable({ result: "dropped", ts: 0 })).toBe(true);
    expect(isAlertable({ result: "noticed", ts: 0, notice: "refund-partial", ref: "adj_1" })).toBe(
      true,
    );
    for (const stage of [
      "email",
      "paddle-api",
      "paddle-api-auth",
      "notice-write",
      "ledger",
    ] as FailStage[]) {
      expect(isAlertable({ result: "error", ts: 0, stage })).toBe(true);
    }
    for (const stage of [
      "config",
      "config-support-email",
      "config-resend-from",
      "config-paddle-api-key",
      "config-price-ids",
      "config-env-mismatch",
      "config-sandbox-until",
      "config-sandbox-buyers",
    ] as FailStage[]) {
      expect(isAlertable({ result: "error", ts: 0, stage })).toBe(true);
    }
    for (const stage of ["unexpected", "blob-size", "delivery-check"] as FailStage[]) {
      expect(isAlertable({ result: "error", ts: 0, stage })).toBe(false);
    }
    expect(isAlertable({ result: "settled", ts: 0 })).toBe(false);
    expect(isAlertable({ result: "issued", ts: 0 })).toBe(false);
    expect(isAlertable({ result: "error", ts: 0, stage: "config-future" as FailStage })).toBe(
      false,
    );
  });

  it("a broken RESEND_FROM alerts via the webhook and NEVER via Resend", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("gone", { status: 404 });
      }),
    );
    const pending: Promise<unknown>[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await issuanceWorker.fetch(
        makeRequest(paidBody(), { ts: nowTs() }),
        makeEnv({
          RESEND_FROM: "REPLACE_WITH_VERIFIED_SENDER",
          ALERT_WEBHOOK_URL: "https://hooks.example/tandem",
          ALERT_EMAIL: "ops@tandem.test",
        }) as never,
        { waitUntil: (p: Promise<unknown>) => pending.push(p) } as never,
      );
      await Promise.all(pending);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual(["https://hooks.example/tandem"]);
  });

  // --- scheduled delivery check ---------------------------------------------
  function deliveryFetch(o: {
    failed?: unknown[];
    settings?: unknown[];
    status?: number;
    settingsStatus?: number;
  }) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/notifications?")) {
        return new Response(JSON.stringify({ data: o.failed ?? [] }), { status: o.status ?? 200 });
      }
      if (url.endsWith("/notification-settings")) {
        return new Response(
          JSON.stringify({ data: o.settings ?? [{ id: "ntfset_1", active: true }] }),
          { status: o.settingsStatus ?? o.status ?? 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
  }
  const runScheduled = async (env: unknown) => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await issuanceWorker.scheduled({}, env as never);
    } finally {
      spy.mockRestore();
    }
  };

  it("scheduled: quiet when nothing failed and every destination is active", async () => {
    const f = deliveryFetch({});
    vi.stubGlobal("fetch", f);
    await runScheduled(makeEnv({ ALERT_WEBHOOK_URL: "https://hooks.example.com/dc" }));
    expect(
      callsTo(f, "https://api.paddle.com/notifications?status=failed,needs_retry"),
    ).toHaveLength(1);
    expect(callsTo(f, "https://hooks.example.com/dc")).toHaveLength(0);
  });

  it("scheduled: alerts on a failed notification, an inactive destination, or an API failure", async () => {
    for (const o of [
      { failed: [{ id: "ntf_1", status: "failed" }] },
      { settings: [{ id: "ntfset_1", active: false }] },
      { settings: [] }, // no destination at all
      { status: 401 },
      { settingsStatus: 500 }, // the settings endpoint failing on its own
    ]) {
      _resetAlertThrottleForTests();
      const f = deliveryFetch(o);
      vi.stubGlobal("fetch", f);
      await runScheduled(makeEnv({ ALERT_WEBHOOK_URL: "https://hooks.example.com/dc" }));
      const [alert] = callsTo(f, "https://hooks.example.com/dc");
      expect(alert, JSON.stringify(o)).toBeDefined();
      const text = JSON.parse(alert[1]?.body as string).text as string;
      expect(text).toContain("delivery check");
      expect(text).not.toContain("Paddle retries"); // the cron alert is about no one delivery
    }
  });

  it("scheduled: a Worker with no Paddle API key alerts rather than reading as healthy", async () => {
    _resetAlertThrottleForTests();
    const f = deliveryFetch({});
    vi.stubGlobal("fetch", f);
    await runScheduled(
      makeEnv({ ALERT_WEBHOOK_URL: "https://hooks.example.com/dc", PADDLE_API_KEY: undefined }),
    );
    expect(callsTo(f, "https://hooks.example.com/dc")).toHaveLength(1);
  });
});
