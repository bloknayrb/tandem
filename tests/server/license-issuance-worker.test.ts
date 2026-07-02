import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  base64ToBytes,
  canonicalize as canonicalizeWorker,
  constantTimeEqual,
  signLicense,
  verifyStandardWebhook,
} from "../../infra/license-issuance-worker/src/crypto.js";
import {
  handleIssuance,
  type IssuanceDeps,
  type KvNamespace,
  LICENSE_VERSION,
} from "../../infra/license-issuance-worker/src/worker.js";
import {
  handleUpdateRequest,
  LICENSE_HEADER,
} from "../../infra/license-update-worker/src/worker.js";
import type {
  LicenseEntitlement,
  LicenseMetadata,
} from "../../src/server/license/license-types.js";
import { canonicalize as canonicalizeServer } from "../../src/server/license/verifier.js";

// --- test crypto ------------------------------------------------------------
// A real Ed25519 keypair. The Worker signs with the PRIVATE half (via injected
// signBytes) and the test verifies with the PUBLIC half using Node's crypto —
// independent of the Worker's WebCrypto path. Combined with the canonicalize
// parity test below, this proves a Worker-produced blob verifies under the real
// on-device `verifyLicenseSignature`.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

const signBytes = async (data: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(crypto.sign(null, Buffer.from(data), privateKey));

interface DecodedBlob {
  metadata: Record<string, unknown>;
  signature: string;
}

function decodeBlob(blob: string): DecodedBlob {
  return JSON.parse(Buffer.from(blob, "base64").toString("utf-8")) as DecodedBlob;
}

/** Verify a Worker-produced blob the way the real server verifier does. */
function blobVerifies(blob: string): boolean {
  const { metadata, signature } = decodeBlob(blob);
  return crypto.verify(
    null,
    Buffer.from(canonicalizeServer(metadata)),
    publicKey,
    Buffer.from(signature, "hex"),
  );
}

// --- webhook signing (test fixture; scheme independently pinned by the golden
//     vector test) ------------------------------------------------------------
const SECRET = `whsec_${Buffer.from("issuance-worker-test-secret").toString("base64")}`;

function signWebhook(id: string, ts: string, body: string, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}

const NOW = 1_700_000_000_000;
const NOW_S = "1700000000";

interface ReqOpts {
  id?: string;
  ts?: string;
  secret?: string;
  method?: string;
  sig?: string;
}

function makeRequest(body: string, opts: ReqOpts = {}): Request {
  const id = opts.id ?? "msg_1";
  const ts = opts.ts ?? NOW_S;
  const headers = new Headers();
  headers.set("webhook-id", id);
  headers.set("webhook-timestamp", ts);
  headers.set("webhook-signature", opts.sig ?? signWebhook(id, ts, body, opts.secret ?? SECRET));
  const method = opts.method ?? "POST";
  return new Request("https://issuance.example/", {
    method,
    headers,
    // GET/HEAD requests may not carry a body.
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

// --- in-memory KV + deps ------------------------------------------------------
function makeKv(): KvNamespace & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => {
      map.set(k, v);
    },
    delete: async (k) => {
      map.delete(k);
    },
  };
}

interface TestDeps extends IssuanceDeps {
  entitlementKv: KvNamespace & { map: Map<string, string> };
  ledgerKv: KvNamespace & { map: Map<string, string> };
  sendEmail: IssuanceDeps["sendEmail"] & ReturnType<typeof vi.fn>;
  log: NonNullable<IssuanceDeps["log"]> & ReturnType<typeof vi.fn>;
}

function baseDeps(overrides: Partial<IssuanceDeps> = {}): TestDeps {
  let counter = 0;
  const defaults = {
    webhookSecret: SECRET,
    signBytes,
    entitlementKv: makeKv(),
    ledgerKv: makeKv(),
    sendEmail: vi.fn(async () => ({ ok: true })),
    isGrandfathered: () => false,
    isTest: false,
    now: () => NOW,
    newLicenseId: () => `lic-${++counter}`,
    log: vi.fn(),
  } satisfies IssuanceDeps;
  // Overrides may replace a narrowed field (e.g. a plain KvNamespace without
  // `map`); tests that override only inspect what they inject.
  return { ...defaults, ...overrides } as TestDeps;
}

// --- payload fixtures + ledger inspection --------------------------------------
const paidBody = (orderId = "ord_1", extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "order.paid",
    data: {
      id: orderId,
      total_amount: 4900,
      customer: { email: "buyer@example.com", name: "Jane Buyer" },
      ...extra,
    },
  });

const refundBody = (orderId: string, refunded = true) =>
  JSON.stringify({ type: "order.refunded", data: { id: orderId, refunded } });

/** Shape of the Worker's durable ledger record — the test's independent pin of
 * the on-wire format (deliberately NOT imported from the Worker). */
interface LedgerRec {
  orderId: string;
  licenseId: string;
  email: string;
  name: string;
  type: string;
  createdAt: string;
  updateWindowEnd: string | null;
  emailSent: boolean;
  refunded: boolean;
}

/** Read+parse an order's ledger record. The literal key format is the point —
 * it pins the mode-scoped `order:<mode>:<id>` convention against refactors. */
const ledgerRec = (deps: TestDeps, orderId = "ord_1", mode = "live"): LedgerRec =>
  JSON.parse(deps.ledgerKv.map.get(`order:${mode}:${orderId}`) as string) as LedgerRec;

// ===========================================================================
describe("crypto: canonicalize parity with the server verifier", () => {
  const hostile = [
    { id: "u", name: "Jane 😀 Buyer", email: "a@b.co" },
    { id: "u", name: "é combining", email: "a@b.co" }, // combining acute
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
      name: "Jane Buyer",
      email: "buyer@example.com",
      type: "personal",
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW).toISOString(),
      version: LICENSE_VERSION,
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

describe("crypto: verifyStandardWebhook (svix)", () => {
  // Golden vector — reproduces svix's own published manual-verification example
  // exactly, so it independently pins the whsec_-decode + HMAC construction.
  it("accepts the svix published golden vector", async () => {
    const ok = await verifyStandardWebhook(
      {
        id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
        timestamp: "1614265330",
        signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
      },
      '{"test": 2432232314}',
      "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      1614265330_000,
      300,
    );
    expect(ok).toBe(true);
  });

  // Wrapper with good-case defaults so each rejection case shows only what it
  // varies.
  const verifyWith = (o: {
    id?: string | null;
    ts?: string;
    sig?: string;
    body?: string;
    secret?: string;
    now?: number;
  }) => {
    const body = o.body ?? paidBody();
    return verifyStandardWebhook(
      {
        id: o.id === undefined ? "msg_1" : o.id,
        timestamp: o.ts ?? NOW_S,
        signature: o.sig ?? signWebhook("msg_1", o.ts ?? NOW_S, body, o.secret ?? SECRET),
      },
      body,
      o.secret ?? SECRET,
      o.now ?? NOW,
      300,
    );
  };

  it("accepts a freshly signed payload and matches any of multiple v1 sigs", async () => {
    const body = paidBody();
    const good = signWebhook("msg_1", NOW_S, body);
    const multi = `v1,AAAA${good.slice(5)}badpad== ${good}`; // first entry garbage, second good
    expect(await verifyWith({ body, sig: multi })).toBe(true);
  });

  it("rejects a tampered body, a stale timestamp, and a wrong secret", async () => {
    const body = paidBody();
    const sig = signWebhook("msg_1", NOW_S, body);
    expect(await verifyWith({ body: `${body} `, sig })).toBe(false); // tampered body
    expect(await verifyWith({ body, sig, now: NOW + 600_000 })).toBe(false); // stale (10 min)
    // signed with the right secret, verified against a different one
    expect(
      await verifyWith({ body, sig, secret: `whsec_${Buffer.from("other").toString("base64")}` }),
    ).toBe(false);
  });

  it("rejects missing headers, non-integer timestamps, and wrong-length sigs", async () => {
    expect(await verifyWith({ id: null, sig: "v1,x" })).toBe(false);
    expect(await verifyWith({ ts: "12ab", sig: "v1,x" })).toBe(false);
    // valid base64 but not 32 bytes -> skipped, no match, no throw
    expect(await verifyWith({ sig: "v1,AAAA" })).toBe(false);
  });
});

// ===========================================================================
describe("handleIssuance: order.paid happy path", () => {
  let deps: TestDeps;
  beforeEach(() => {
    deps = baseDeps();
  });

  it("mints, entitles, emails, and marks the event done", async () => {
    const res = await handleIssuance(makeRequest(paidBody("ord_1"), { id: "evt_1" }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // ledger order record
    const rec = ledgerRec(deps);
    expect(rec.type).toBe("personal");
    expect(rec.email).toBe("buyer@example.com");
    expect(rec.emailSent).toBe(true);
    expect(rec.updateWindowEnd).not.toBeNull();

    // entitlement (no PII) written under the licenseId — typed as the canonical
    // LicenseEntitlement so shape drift is a compile error (kv-store ↔ worker
    // parity, same convention as license-update-worker.test.ts).
    const expected: LicenseEntitlement = {
      updateWindowEnd: rec.updateWindowEnd,
      status: "personal",
      version: LICENSE_VERSION,
    };
    expect(JSON.parse(deps.entitlementKv.map.get(rec.licenseId) as string)).toEqual(expected);

    // event marked done
    expect(deps.ledgerKv.map.get("evt:live:evt_1")).toBe("done");

    // email delivered a verifiable blob
    expect(deps.sendEmail).toHaveBeenCalledOnce();
    const blob = deps.sendEmail.mock.calls[0][2] as string;
    expect(blobVerifies(blob)).toBe(true);
    expect(decodeBlob(blob).metadata.email).toBe("buyer@example.com");
  });

  it("never returns the blob in the HTTP response and logs only { result, ts }", async () => {
    const res = await handleIssuance(makeRequest(paidBody(), { id: "evt_1" }), deps);
    const blob = deps.sendEmail.mock.calls[0][2] as string;
    expect(JSON.stringify(await res.json())).not.toContain(blob.slice(0, 20));
    expect(deps.log).toHaveBeenCalledWith({ result: "issued", ts: NOW / 1000 });
    for (const [entry] of deps.log.mock.calls) {
      expect(Object.keys(entry as object).sort()).toEqual(["result", "ts"]);
    }
  });

  it("grandfathered email → type grandfathered, null update window", async () => {
    deps = baseDeps({ isGrandfathered: (e) => e === "buyer@example.com" });
    await handleIssuance(makeRequest(paidBody("ord_gf"), { id: "evt_gf" }), deps);
    const rec = ledgerRec(deps, "ord_gf");
    expect(rec.type).toBe("grandfathered");
    expect(rec.updateWindowEnd).toBeNull();
    const ent = JSON.parse(deps.entitlementKv.map.get(rec.licenseId) as string);
    expect(ent.updateWindowEnd).toBeNull();
  });

  it("clamps an over-long name and still produces a verifiable blob (C2)", async () => {
    const body = paidBody("ord_long", {
      customer: { email: "buyer@example.com", name: "x".repeat(500) },
    });
    await handleIssuance(makeRequest(body, { id: "evt_long" }), deps);
    const blob = deps.sendEmail.mock.calls[0][2] as string;
    expect(blobVerifies(blob)).toBe(true);
    expect((decodeBlob(blob).metadata.name as string).length).toBe(128);
    expect(base64ToBytes(blob).length).toBeLessThan(4096);
  });

  it("falls back to data.user.email when data.customer is absent (M3)", async () => {
    const body = JSON.stringify({
      type: "order.paid",
      data: { id: "ord_u", total_amount: 4900, user: { email: "u@example.com", name: "U" } },
    });
    await handleIssuance(makeRequest(body, { id: "evt_u" }), deps);
    expect(ledgerRec(deps, "ord_u").email).toBe("u@example.com");
  });
});

describe("handleIssuance: idempotency & recovery", () => {
  it("short-circuits a fully-processed replay (same webhook-id) without re-minting", async () => {
    const deps = baseDeps();
    const body = paidBody("ord_1");
    await handleIssuance(makeRequest(body, { id: "evt_1" }), deps);
    const firstLicenseId = ledgerRec(deps).licenseId;

    const res2 = await handleIssuance(makeRequest(body, { id: "evt_1" }), deps);
    expect(res2.status).toBe(200);
    expect(deps.sendEmail).toHaveBeenCalledOnce(); // not re-emailed
    expect(deps.log).toHaveBeenLastCalledWith({ result: "duplicate", ts: NOW / 1000 });
    expect(ledgerRec(deps).licenseId).toBe(firstLicenseId); // no new license minted
  });

  it("recovers a failed email on the retry (same webhook-id, not marked done)", async () => {
    let calls = 0;
    const sendEmail = vi.fn(async () => ({ ok: ++calls > 1 })); // first fails, second ok
    const deps = baseDeps({ sendEmail });
    const body = paidBody("ord_1");

    const res1 = await handleIssuance(makeRequest(body, { id: "evt_1" }), deps);
    expect(res1.status).toBe(500); // Polar will retry
    expect(deps.ledgerKv.map.get("evt:live:evt_1")).toBeUndefined(); // NOT marked done
    expect(ledgerRec(deps).emailSent).toBe(false);
    // entitlement was already written (before the email attempt)
    expect(deps.entitlementKv.map.get(ledgerRec(deps).licenseId)).toBeDefined();

    const res2 = await handleIssuance(makeRequest(body, { id: "evt_1" }), deps);
    expect(res2.status).toBe(200);
    expect(deps.ledgerKv.map.get("evt:live:evt_1")).toBe("done");
    expect(ledgerRec(deps).emailSent).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("returns 500 (retryable) when the entitlement write fails", async () => {
    const entitlementKv = makeKv();
    entitlementKv.put = async () => {
      throw new Error("KV down");
    };
    const deps = baseDeps({ entitlementKv });
    const res = await handleIssuance(makeRequest(paidBody("ord_1"), { id: "evt_1" }), deps);
    expect(res.status).toBe(500);
    // ledger record persisted so the retry can recover
    expect(deps.ledgerKv.map.get("order:live:ord_1")).toBeDefined();
    expect(deps.ledgerKv.map.get("evt:live:evt_1")).toBeUndefined();
  });
});

describe("handleIssuance: coupon containment & test mode", () => {
  it("ignores a $0 order from a non-grandfathered buyer", async () => {
    const deps = baseDeps();
    const res = await handleIssuance(
      makeRequest(paidBody("ord_free", { total_amount: 0 }), { id: "evt_free" }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.ledgerKv.map.get("order:live:ord_free")).toBeUndefined();
    expect(deps.log).toHaveBeenLastCalledWith({ result: "ignored", ts: NOW / 1000 });
  });

  it("issues a $0 order for a grandfathered buyer", async () => {
    const deps = baseDeps({ isGrandfathered: () => true });
    await handleIssuance(
      makeRequest(paidBody("ord_gf0", { total_amount: 0 }), { id: "evt_gf0" }),
      deps,
    );
    expect(ledgerRec(deps, "ord_gf0").type).toBe("grandfathered");
  });

  it("does NOT treat a discounted-but-paid order as free (any positive amount issues)", async () => {
    const deps = baseDeps();
    // net_amount low/zero but the buyer was charged a positive total_amount.
    const body = paidBody("ord_disc", { net_amount: 0, total_amount: 4900 });
    await handleIssuance(makeRequest(body, { id: "evt_disc" }), deps);
    expect(deps.ledgerKv.map.get("order:live:ord_disc")).toBeDefined();
    expect(deps.sendEmail).toHaveBeenCalledOnce();
  });

  it("in sandbox (isTest) writes the ledger but NOT the entitlement", async () => {
    const deps = baseDeps({ isTest: true });
    await handleIssuance(makeRequest(paidBody("ord_t"), { id: "evt_t" }), deps);
    expect(deps.ledgerKv.map.get("order:test:ord_t")).toBeDefined();
    expect(deps.entitlementKv.map.size).toBe(0);
    expect(deps.sendEmail).toHaveBeenCalledOnce(); // blob still delivered for e2e
  });
});

describe("handleIssuance: order.refunded", () => {
  async function issued() {
    const deps = baseDeps();
    await handleIssuance(makeRequest(paidBody("ord_1"), { id: "evt_1" }), deps);
    return deps;
  }

  it("revokes the entitlement and marks the ledger refunded", async () => {
    const deps = await issued();
    const licenseId = ledgerRec(deps).licenseId;
    expect(deps.entitlementKv.map.get(licenseId)).toBeDefined();

    const res = await handleIssuance(makeRequest(refundBody("ord_1"), { id: "evt_refund" }), deps);
    expect(res.status).toBe(200);
    expect(deps.entitlementKv.map.get(licenseId)).toBeUndefined(); // revoked
    expect(ledgerRec(deps).refunded).toBe(true);
    expect(deps.log).toHaveBeenLastCalledWith({ result: "revoked", ts: NOW / 1000 });
  });

  it("ignores a refund event without the refunded discriminator (H1)", async () => {
    const deps = await issued();
    const licenseId = ledgerRec(deps).licenseId;
    await handleIssuance(makeRequest(refundBody("ord_1", false), { id: "evt_r2" }), deps);
    expect(deps.entitlementKv.map.get(licenseId)).toBeDefined(); // NOT revoked
  });

  it("does not resurrect a refunded entitlement when the paid event retries (H2)", async () => {
    // Paid email FAILS first (so evt never marked done), then a refund revokes,
    // then the paid event retries — it must not re-assert the entitlement.
    const sendEmail = vi.fn(async () => ({ ok: false })); // always fail
    const deps = baseDeps({ sendEmail });
    await handleIssuance(makeRequest(paidBody("ord_1"), { id: "evt_1" }), deps); // 500
    const licenseId = ledgerRec(deps).licenseId;

    await handleIssuance(makeRequest(refundBody("ord_1"), { id: "evt_refund" }), deps);
    expect(deps.entitlementKv.map.get(licenseId)).toBeUndefined(); // revoked

    // Retry the original paid event.
    const res = await handleIssuance(makeRequest(paidBody("ord_1"), { id: "evt_1" }), deps);
    expect(res.status).toBe(200);
    expect(deps.entitlementKv.map.get(licenseId)).toBeUndefined(); // NOT resurrected
  });

  it("ignores a refund for an unknown order", async () => {
    const deps = baseDeps();
    const res = await handleIssuance(makeRequest(refundBody("nope"), { id: "evt_r3" }), deps);
    expect(res.status).toBe(200);
    expect(deps.log).toHaveBeenLastCalledWith({ result: "ignored", ts: NOW / 1000 });
  });
});

describe("issuance → update Worker contract", () => {
  // Behavioral parity across the two separately-built Workers: the entitlement
  // handleIssuance writes must be readable by handleUpdateRequest. This pins
  // the whole issuance→update KV contract, not just the type shape.
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

  it("an issued license is served an update; after a refund it gets 204", async () => {
    const deps = baseDeps();
    await handleIssuance(makeRequest(paidBody("ord_1"), { id: "evt_1" }), deps);
    const { licenseId } = ledgerRec(deps);

    const served = await checkUpdate(deps, licenseId);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(MANIFEST);

    await handleIssuance(makeRequest(refundBody("ord_1"), { id: "evt_r" }), deps);
    const denied = await checkUpdate(deps, licenseId);
    expect(denied.status).toBe(204);
  });

  it("a grandfathered license (null window) is served far in the future", async () => {
    const deps = baseDeps({ isGrandfathered: () => true });
    await handleIssuance(makeRequest(paidBody("ord_gf"), { id: "evt_gf" }), deps);
    const { licenseId } = ledgerRec(deps, "ord_gf");
    const headers = new Headers();
    headers.set(LICENSE_HEADER, licenseId);
    const res = await handleUpdateRequest(
      new Request("https://updates.example/latest.json", { headers }),
      {
        kv: deps.entitlementKv,
        latestJsonUrl: "https://example.com/latest.json",
        fetchFn: (async () => new Response(MANIFEST, { status: 200 })) as unknown as typeof fetch,
        now: () => NOW + 10_000 * 24 * 60 * 60 * 1000, // ~27 years on
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("handleIssuance: fail-closed gates", () => {
  it("rejects a bad signature with 401 and no side effects", async () => {
    const deps = baseDeps();
    const req = makeRequest(paidBody(), {
      id: "evt_1",
      sig: "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    const res = await handleIssuance(req, deps);
    expect(res.status).toBe(401);
    expect(deps.ledgerKv.map.size).toBe(0);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("400 on missing headers", async () => {
    const deps = baseDeps();
    const req = new Request("https://x/", { method: "POST", body: paidBody() });
    expect((await handleIssuance(req, deps)).status).toBe(400);
  });

  it("400 on a validly-signed non-JSON body", async () => {
    const deps = baseDeps();
    const res = await handleIssuance(makeRequest("not json", { id: "evt_1" }), deps);
    expect(res.status).toBe(400);
  });

  it("503 when the webhook secret is unconfigured", async () => {
    const deps = baseDeps({ webhookSecret: "" });
    // signature can't be valid without a secret; the 503 short-circuits first
    const res = await handleIssuance(makeRequest(paidBody(), { id: "evt_1" }), deps);
    expect(res.status).toBe(503);
  });

  it("405 on non-POST", async () => {
    const deps = baseDeps();
    const res = await handleIssuance(makeRequest(paidBody(), { id: "evt_1", method: "GET" }), deps);
    expect(res.status).toBe(405);
  });

  it("ignores an unknown event type and marks it done", async () => {
    const deps = baseDeps();
    const body = JSON.stringify({ type: "checkout.created", data: {} });
    const res = await handleIssuance(makeRequest(body, { id: "evt_x" }), deps);
    expect(res.status).toBe(200);
    expect(deps.log).toHaveBeenLastCalledWith({ result: "ignored", ts: NOW / 1000 });
    expect(deps.ledgerKv.map.get("evt:live:evt_x")).toBe("done");
  });
});
