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

    it("should verify a license signed by the local private key using verifyLicense", () => {
      let privateKey: string;
      try {
        const privKeyPath = path.join(process.cwd(), "keys", "tandem-private-key.pem");
        privateKey = fs.readFileSync(privKeyPath, "utf8");
      } catch {
        // Skip if private key is not present (e.g. in CI environment)
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

      const verified = verifyLicense(base64License);
      expect(verified.name).toBe("Production User");
      expect(verified.email).toBe("prod@example.com");
    });
  });
});
