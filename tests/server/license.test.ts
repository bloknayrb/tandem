import crypto from "crypto";
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { LicenseMetadata, SignedLicense } from "../../src/server/license/license-types.js";
import { TANDEM_PUBLIC_KEY } from "../../src/server/license/public-key.js";
import { canonicalize, verifyLicense } from "../../src/server/license/verifier.js";

describe("Licensing Core", () => {
  describe("canonicalize", () => {
    it("should deterministically order keys", () => {
      const obj1 = { name: "User", email: "user@example.com", age: 30 };
      const obj2 = { age: 30, name: "User", email: "user@example.com" };
      expect(canonicalize(obj1)).toBe(canonicalize(obj2));
      expect(canonicalize(obj1)).toBe('{"age":30,"email":"user@example.com","name":"User"}');
    });

    it("should handle nested arrays and nulls", () => {
      const obj = { b: null, a: [1, 2, { d: 4, c: 3 }] };
      expect(canonicalize(obj)).toBe('{"a":[1,2,{"c":3,"d":4}],"b":null}');
    });
  });

  describe("License Verification (End-to-End)", () => {
    it("should verify a valid signature with the correct key", () => {
      // We will generate a temp key pair to test the signing/verification mechanism
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      const metadata: LicenseMetadata = {
        id: crypto.randomUUID(),
        name: "Test User",
        email: "test@example.com",
        type: "personal",
        createdAt: new Date().toISOString(),
        expiresAt: null,
        version: "1.0",
      };

      const dataStr = canonicalize(metadata);
      const signature = crypto.sign(null, Buffer.from(dataStr), privateKey);

      const signedLicense: SignedLicense = {
        metadata,
        signature: signature.toString("hex"),
      };

      const base64License = Buffer.from(JSON.stringify(signedLicense)).toString("base64");

      // Verify the license using a mock verify that uses our temp public key
      const verifyWithTempKey = (licenseStr: string, pubKey: string): LicenseMetadata => {
        const decoded = Buffer.from(licenseStr, "base64").toString("utf-8");
        const parsed = JSON.parse(decoded) as SignedLicense;
        const dataBytes = Buffer.from(canonicalize(parsed.metadata));
        const sigBytes = Buffer.from(parsed.signature, "hex");

        const verified = crypto.verify(null, dataBytes, pubKey, sigBytes);
        if (!verified) throw new Error("Signature verification failed");
        return parsed.metadata;
      };

      const verifiedMetadata = verifyWithTempKey(base64License, publicKey);
      expect(verifiedMetadata.name).toBe("Test User");
      expect(verifiedMetadata.email).toBe("test@example.com");
      expect(verifiedMetadata.type).toBe("personal");
    });

    it("should throw if the signature is invalid or tampered with", () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      const metadata: LicenseMetadata = {
        id: crypto.randomUUID(),
        name: "Test User",
        email: "test@example.com",
        type: "personal",
        createdAt: new Date().toISOString(),
        expiresAt: null,
        version: "1.0",
      };

      const dataStr = canonicalize(metadata);
      const signature = crypto.sign(null, Buffer.from(dataStr), privateKey);

      // Tamper name
      const tamperedMetadata = { ...metadata, name: "Tampered User" };

      const signedLicense: SignedLicense = {
        metadata: tamperedMetadata,
        signature: signature.toString("hex"),
      };

      const base64License = Buffer.from(JSON.stringify(signedLicense)).toString("base64");

      const verifyWithTempKey = (licenseStr: string, pubKey: string): LicenseMetadata => {
        const decoded = Buffer.from(licenseStr, "base64").toString("utf-8");
        const parsed = JSON.parse(decoded) as SignedLicense;
        const dataBytes = Buffer.from(canonicalize(parsed.metadata));
        const sigBytes = Buffer.from(parsed.signature, "hex");

        const verified = crypto.verify(null, dataBytes, pubKey, sigBytes);
        if (!verified) throw new Error("Signature verification failed");
        return parsed.metadata;
      };

      expect(() => verifyWithTempKey(base64License, publicKey)).toThrow(
        "Signature verification failed",
      );
    });

    it("should reject expired licenses", () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      const expiredDate = new Date();
      expiredDate.setDate(expiredDate.getDate() - 1); // 1 day ago

      const metadata: LicenseMetadata = {
        id: crypto.randomUUID(),
        name: "Expired User",
        email: "expired@example.com",
        type: "personal",
        createdAt: new Date().toISOString(),
        expiresAt: expiredDate.toISOString(),
        version: "1.0",
      };

      const dataStr = canonicalize(metadata);
      const signature = crypto.sign(null, Buffer.from(dataStr), privateKey);

      const signedLicense: SignedLicense = {
        metadata,
        signature: signature.toString("hex"),
      };

      const base64License = Buffer.from(JSON.stringify(signedLicense)).toString("base64");

      const verifyWithTempKey = (licenseStr: string, pubKey: string): LicenseMetadata => {
        const decoded = Buffer.from(licenseStr, "base64").toString("utf-8");
        const parsed = JSON.parse(decoded) as SignedLicense;
        const dataBytes = Buffer.from(canonicalize(parsed.metadata));
        const sigBytes = Buffer.from(parsed.signature, "hex");

        const verified = crypto.verify(null, dataBytes, pubKey, sigBytes);
        if (!verified) throw new Error("Signature verification failed");

        if (parsed.metadata.expiresAt) {
          const expires = new Date(parsed.metadata.expiresAt);
          if (expires.getTime() < Date.now()) {
            throw new Error(`License expired on ${parsed.metadata.expiresAt}`);
          }
        }
        return parsed.metadata;
      };

      expect(() => verifyWithTempKey(base64License, publicKey)).toThrow(/License expired on/);
    });
  });

  describe("Production Key Verification", () => {
    it("should carry a valid PEM format public key", () => {
      expect(TANDEM_PUBLIC_KEY).toContain("-----BEGIN PUBLIC KEY-----");
      expect(TANDEM_PUBLIC_KEY).toContain("-----END PUBLIC KEY-----");
    });

    /**
     * Pin the exact shipped verification key.
     *
     * Everything else in this describe block is structural — the PEM check
     * passes for ANY well-formed key, and the round-trip below `return`s early
     * whenever `keys/` is absent, which in CI is always (it's gitignored and
     * never checked in). So before this test, a silent skip read as a pass and
     * NOTHING verified which key the product actually ships. Swapping the key
     * — by a bad merge, a stray paste from a dev keypair, or a rebase that
     * resurrected an old line — would have been invisible until customers'
     * licenses stopped verifying in the field.
     *
     * Update `EXPECTED_PUBLIC_KEY_SHA256` deliberately, in the same commit as a
     * real key rotation, never to make a red test green.
     *
     * The hash is over the base64 body with all whitespace stripped, so it is
     * immune to CRLF/LF checkout differences (see the `core.autocrlf` gotcha in
     * CLAUDE.md) and to reflowing the PEM.
     */
    it("ships the pinned production public key (fingerprint)", () => {
      const EXPECTED_PUBLIC_KEY_SHA256 =
        "d896ad7b41bfab69a5c356bbd0e68576201ac2fd5a0f90f9eddfa4f7d78a688b";
      const body = TANDEM_PUBLIC_KEY.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(
        /\s+/g,
        "",
      );
      const actual = crypto.createHash("sha256").update(body).digest("hex");
      expect(actual).toBe(EXPECTED_PUBLIC_KEY_SHA256);
    });

    it("should verify a license signed by the local private key using verifyLicense", () => {
      let privateKey: string;
      try {
        const privKeyPath = path.join(process.cwd(), "keys", "tandem-private-key.pem");
        privateKey = fs.readFileSync(privKeyPath, "utf8");
      } catch {
        // Skip if the private key is absent — always the case in CI, and the
        // reason the fingerprint test above exists. This one only adds value on
        // an operator's machine, where it proves the checked-in public key and
        // the local private key are actually a pair.
        return;
      }

      const metadata: LicenseMetadata = {
        id: crypto.randomUUID(),
        name: "Production User",
        email: "prod@example.com",
        type: "personal",
        createdAt: new Date().toISOString(),
        expiresAt: null,
        version: "1.0",
      };

      const dataStr = canonicalize(metadata);
      const signature = crypto.sign(null, Buffer.from(dataStr), privateKey);

      const signedLicense: SignedLicense = {
        metadata,
        signature: signature.toString("hex"),
      };

      const base64License = Buffer.from(JSON.stringify(signedLicense)).toString("base64");

      // Explain the failure rather than surfacing a bare "bad signature".
      // The likeliest cause is benign and self-inflicted: the runbook tells you
      // to run `generate-keys.ts`, and the moment you do, this previously-
      // skipped test starts running against a keypair that is NOT the pair of
      // the pinned public key. Without this message that reads as a broken
      // checkout rather than an unfinished key ceremony.
      let verified: LicenseMetadata;
      try {
        verified = verifyLicense(base64License);
      } catch (err) {
        throw new Error(
          "The keypair in keys/ does not match the public key shipped in " +
            "src/server/license/public-key.ts.\n" +
            "If you just ran `npx tsx scripts/generate-keys.ts`, that is expected: finish the " +
            "ceremony by pasting the new PUBLIC key into public-key.ts and updating " +
            "EXPECTED_PUBLIC_KEY_SHA256 above, in the same commit (docs/licensing-operations.md §0).\n" +
            "If you did NOT intend to rotate the signing key, delete keys/ — it is gitignored " +
            "scratch, and every license already issued was signed by the pinned key.\n" +
            `Underlying: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      expect(verified.name).toBe("Production User");
      expect(verified.email).toBe("prod@example.com");
    });
  });
});
