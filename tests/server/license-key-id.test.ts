/**
 * License signing-key ids (ADR-040 amendment, 2026-10-15).
 *
 * The production verifier is bound to the pinned key, whose private half is
 * never in CI, so its accept path cannot be reached with a real blob. These
 * tests drive the same selection and verify code through
 * `_verifyAgainstForTests` with temporary keys, over maps built by the
 * production `buildKeyMap`, so a selection bug that rejected every blob
 * carrying a `keyId` would fail here rather than at the first sale.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  keyIdOfPkcs8Ed25519,
} from "../../infra/license-issuance-worker/src/crypto.js";
import { TRUSTED_KEY_IDS } from "../../infra/license-issuance-worker/src/worker.js";
import { signWithKey } from "../../scripts/sign-license.js";
import {
  buildKeyMap,
  keyIdForPublicKey,
  LEGACY_KEY_ID,
  TRUSTED_PUBLIC_KEYS,
} from "../../src/server/license/public-key.js";
import { _verifyAgainstForTests, canonicalize } from "../../src/server/license/verifier.js";

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey,
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    id: keyIdForPublicKey(publicKey),
  };
}

const A = keypair();
const B = keypair();

const FIELDS = {
  id: "lic-1",
  name: "Ada",
  email: "ada@example.com",
  type: "personal" as const,
  createdAt: "2026-10-15T00:00:00.000Z",
  expiresAt: null,
  version: "1.0",
};

/** Sign arbitrary metadata (including deliberately wrong `keyId`s) with a key. */
function blob(metadata: Record<string, unknown>, privateKey: crypto.KeyObject): string {
  const signature = crypto.sign(null, Buffer.from(canonicalize(metadata)), privateKey);
  return Buffer.from(JSON.stringify({ metadata, signature: signature.toString("hex") })).toString(
    "base64",
  );
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe("verifier key selection", () => {
  const both = buildKeyMap([A.publicPem, B.publicPem]);

  it("verifies a keyless license against the legacy key", () => {
    const v = _verifyAgainstForTests(blob(FIELDS, A.privateKey), both, A.id);
    expect(v.name).toBe("Ada");
  });

  it("verifies a license naming its own key", () => {
    const v = _verifyAgainstForTests(blob({ ...FIELDS, keyId: A.id }, A.privateKey), both, A.id);
    expect(v.keyId).toBe(A.id);
  });

  it("verifies a second key's license when both are trusted", () => {
    const v = _verifyAgainstForTests(blob({ ...FIELDS, keyId: B.id }, B.privateKey), both, A.id);
    expect(v.keyId).toBe(B.id);
  });

  it("refuses a license signed by one key but naming the other", () => {
    expect(
      code(() =>
        _verifyAgainstForTests(blob({ ...FIELDS, keyId: A.id }, B.privateKey), both, A.id),
      ),
    ).toBe("BAD_SIGNATURE");
  });

  it("answers BAD_SIGNATURE for a well-formed id no trusted key carries", () => {
    const onlyA = buildKeyMap([A.publicPem]);
    expect(
      code(() =>
        _verifyAgainstForTests(blob({ ...FIELDS, keyId: B.id }, B.privateKey), onlyA, A.id),
      ),
    ).toBe("BAD_SIGNATURE");
  });

  it("retires keyless licenses when the legacy key leaves the list", () => {
    const onlyB = buildKeyMap([B.publicPem]);
    expect(code(() => _verifyAgainstForTests(blob(FIELDS, A.privateKey), onlyB, A.id))).toBe(
      "BAD_SIGNATURE",
    );
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["an array", [A.id]],
    ["an object", { id: A.id }],
    ["uppercase hex", A.id.toUpperCase()],
    ["too short", A.id.slice(0, 15)],
    ["__proto__", "__proto__"],
    ["constructor", "constructor"],
  ])("answers MALFORMED for a keyId that is %s", (_label, keyId) => {
    expect(
      code(() => _verifyAgainstForTests(blob({ ...FIELDS, keyId }, A.privateKey), both, A.id)),
    ).toBe("MALFORMED");
  });
});

describe("key map", () => {
  it("has a null prototype and is frozen", () => {
    const map = buildKeyMap([A.publicPem]);
    expect(Object.getPrototypeOf(map)).toBeNull();
    expect(Object.isFrozen(map)).toBe(true);
  });

  it("refuses a duplicate key", () => {
    expect(() => buildKeyMap([A.publicPem, A.publicPem])).toThrow(/duplicate/);
  });
});

describe("key id derivation agrees across the server and the Worker", () => {
  it("derives today's production id from its public value (which contains `_`)", async () => {
    // A deterministic fixture: plain `atob` throws on this value, so a Worker
    // decode that skipped base64url would fail here, not at the first webhook.
    const x = "7gm5YEEylcqDgxr1rQ_gA_K8ZzOPfqmvUBtE6CI8QCk";
    const digest = await globalThis.crypto.subtle.digest("SHA-256", base64UrlToBytes(x));
    const id = Buffer.from(digest).subarray(0, 8).toString("hex");
    expect(id).toBe("79c10e75fb8cfa46");
    expect(id).toBe(LEGACY_KEY_ID);
    expect(keyIdForPublicKey(TRUSTED_PUBLIC_KEYS[0])).toBe(id);
  });

  it("gives the same id for a random key pair on both sides", async () => {
    for (const k of [A, B, keypair(), keypair()]) {
      expect(await keyIdOfPkcs8Ed25519(k.privatePem)).toBe(k.id);
    }
  });

  it("the Worker trusts exactly the keys the server ships", () => {
    // One commit adds a key to both lists (licensing-operations.md §0).
    const serverIds = TRUSTED_PUBLIC_KEYS.map((pem) => keyIdForPublicKey(pem));
    expect(serverIds.length).toBeGreaterThan(0);
    expect([...TRUSTED_KEY_IDS].sort()).toEqual([...serverIds].sort());
  });
});

describe("sign-license script", () => {
  it("stamps the signing key's own id, and the result verifies", () => {
    const trusted = buildKeyMap([A.publicPem]);
    const { metadata, blob: b } = signWithKey(FIELDS, A.privatePem, trusted);
    expect(metadata.keyId).toBe(A.id);
    expect(_verifyAgainstForTests(b, trusted, A.id).keyId).toBe(A.id);
  });

  it("refuses to sign with a key no build trusts", () => {
    expect(() => signWithKey(FIELDS, B.privatePem, buildKeyMap([A.publicPem]))).toThrow(
      /not in TRUSTED_PUBLIC_KEYS/,
    );
  });
});

describe("test seam", () => {
  it("is called from no production source file", () => {
    // `_verifyAgainstForTests` accepts caller-supplied keys; production must
    // only ever verify against the pinned list.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|svelte|js|mjs)$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (text.includes("_verifyAgainstForTests") && !full.endsWith("verifier.ts")) {
            offenders.push(full);
          }
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    walk(path.join(process.cwd(), "infra"));
    walk(path.join(process.cwd(), "scripts"));
    expect(offenders).toEqual([]);
  });
});
