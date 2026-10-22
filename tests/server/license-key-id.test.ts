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
import { defaultPrivateKeyPath, signWithKey } from "../../scripts/sign-license.js";
import {
  buildKeyMap,
  keyIdForPublicKey,
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

/**
 * A's id must contain a hex letter: the "uppercase hex" case below is
 * `A.id.toUpperCase()`, and an all-digit id (about 1 draw in 1,800) uppercases
 * to A's own valid id, which verifies instead of answering MALFORMED.
 */
function keypairWithHexLetter(): ReturnType<typeof keypair> {
  for (;;) {
    const k = keypair();
    if (/[a-f]/.test(k.id)) return k;
  }
}

const A = keypairWithHexLetter();
const B = keypair();

const FIELDS = {
  id: "lic-1",
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

  it("refuses a keyless license as an unknown key, even when its signer is trusted", () => {
    // BAD_SIGNATURE, not MALFORMED: the only keyless licenses were signed by the
    // retired original key, and that code's copy ("predates a signing-key
    // change, have it reissued") is the true story (docs/licensing-operations.md §0).
    const b = blob(FIELDS, A.privateKey);
    expect(code(() => _verifyAgainstForTests(b, both))).toBe("BAD_SIGNATURE");
    expect(() => _verifyAgainstForTests(b, both)).toThrow(/unknown key/);
  });

  it("verifies a license naming its own key", () => {
    const v = _verifyAgainstForTests(blob({ ...FIELDS, keyId: A.id }, A.privateKey), both);
    expect(v.keyId).toBe(A.id);
  });

  it("verifies a second key's license when both are trusted", () => {
    const v = _verifyAgainstForTests(blob({ ...FIELDS, keyId: B.id }, B.privateKey), both);
    expect(v.keyId).toBe(B.id);
  });

  it("refuses a license signed by one key but naming the other", () => {
    expect(
      code(() => _verifyAgainstForTests(blob({ ...FIELDS, keyId: A.id }, B.privateKey), both)),
    ).toBe("BAD_SIGNATURE");
  });

  it("answers BAD_SIGNATURE for a well-formed id no trusted key carries", () => {
    const onlyA = buildKeyMap([A.publicPem]);
    const b = blob({ ...FIELDS, keyId: B.id }, B.privateKey);
    expect(code(() => _verifyAgainstForTests(b, onlyA))).toBe("BAD_SIGNATURE");
    // Refused at the lookup, not by trying another key and failing there.
    expect(() => _verifyAgainstForTests(b, onlyA)).toThrow(/unknown key/);
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
    expect(code(() => _verifyAgainstForTests(blob({ ...FIELDS, keyId }, A.privateKey), both))).toBe(
      "MALFORMED",
    );
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
  it.each(TRUSTED_PUBLIC_KEYS.map((pem) => [keyIdForPublicKey(pem), pem]))(
    "derives the shipped key %s's id identically with WebCrypto",
    async (id, pem) => {
      // The ids themselves are pinned by EXPECTED_KEYS (license.test.ts); this
      // checks the Worker's derivation agrees on each real key. The fixed key
      // below carries the `_`/`-` coverage, whatever the shipped key contains.
      const { x } = crypto.createPublicKey(pem).export({ format: "jwk" });
      const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        base64UrlToBytes(x as string),
      );
      expect(Buffer.from(digest).subarray(0, 8).toString("hex")).toBe(id);
    },
  );

  it("derives the same id on both sides for a key whose public value has `_` and `-`", async () => {
    // Fixed, not random, so a Worker that decoded `jwk.x` with plain `atob`
    // fails every run rather than about one in four. A throwaway test key that
    // no build trusts.
    const fixed = crypto.createPrivateKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        d: "FnHR7ZxzRnRMUUDLCiVn-oSYUv39rviEiqlYZFhjH8U",
        x: "zpZ_f5ZZYL7h-0Dh4HRQMSvSXN1NJJdHHkQ7N1fAj8g",
      },
      format: "jwk",
    });
    const pem = fixed.export({ type: "pkcs8", format: "pem" }).toString();
    expect(await keyIdOfPkcs8Ed25519(pem)).toBe(keyIdForPublicKey(crypto.createPublicKey(fixed)));
  });

  it("gives the same id for a random key pair on both sides", async () => {
    for (const k of [A, B, keypair(), keypair()]) {
      expect(await keyIdOfPkcs8Ed25519(k.privatePem)).toBe(k.id);
    }
  });

  it("the Worker trusts exactly the keys the server ships", () => {
    // One commit adds a key to both lists (docs/licensing-operations.md §0).
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
    expect(_verifyAgainstForTests(b, trusted).keyId).toBe(A.id);
  });

  it("refuses to sign with a key no build trusts", () => {
    expect(() => signWithKey(FIELDS, B.privatePem, buildKeyMap([A.publicPem]))).toThrow(
      /not in TRUSTED_PUBLIC_KEYS/,
    );
  });
  it("defaults --key to keys/tandem-<id>.pem for the one trusted key, and to nothing for two", () => {
    expect(defaultPrivateKeyPath(buildKeyMap([A.publicPem]))).toBe(
      path.join("keys", `tandem-${A.id}.pem`),
    );
    // Mid-rotation there is no safe guess, so the operator must name the key.
    expect(defaultPrivateKeyPath(buildKeyMap([A.publicPem, B.publicPem]))).toBeUndefined();
  });
});

describe("test seam", () => {
  it("is called from no production source file", () => {
    // `_verifyAgainstForTests` accepts caller-supplied keys; production must
    // only ever verify against the pinned list.
    const definition = path.join(process.cwd(), "src", "server", "license", "verifier.ts");
    const holders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|svelte|js|mjs)$/.test(entry.name)) {
          if (fs.readFileSync(full, "utf8").includes("_verifyAgainstForTests")) holders.push(full);
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    walk(path.join(process.cwd(), "infra"));
    walk(path.join(process.cwd(), "scripts"));
    // Positive anchor: the sweep must see the definition, or it is looking in
    // the wrong place and an empty offender list would mean nothing.
    expect(holders).toContain(definition);
    expect(holders.filter((f) => f !== definition)).toEqual([]);
  });
});
