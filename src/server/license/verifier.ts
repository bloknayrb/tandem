/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "crypto";
import type { LicenseMetadata, SignedLicense } from "./license-types.js";
import { TANDEM_PUBLIC_KEY } from "./public-key.js";

export function canonicalObject(obj: any): any {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalObject);
  }
  const sortedKeys = Object.keys(obj).sort();
  const sortedObj: any = {};
  for (const key of sortedKeys) {
    sortedObj[key] = canonicalObject(obj[key]);
  }
  return sortedObj;
}

/**
 * Deterministically stringify an object by sorting its keys.
 * This guarantees consistent signatures across different platforms and runs.
 */
export function canonicalize(obj: any): string {
  return JSON.stringify(canonicalObject(obj));
}

/**
 * Verifies the Ed25519 signature of a base64-encoded signed license against the
 * embedded public key — signature ONLY, no expiry check.
 *
 * This is the correct check for the *run* gate (ADR-040 §3/§4): a paid license
 * lets you run the current version **forever**; `expiresAt` governs only the
 * update window, not the right to run. Callers that need the update-window
 * decision read `metadata.expiresAt` themselves (see `license-state.ts`).
 * Throws if the format is malformed or the signature is invalid.
 */
export function verifyLicenseSignature(licenseString: string): LicenseMetadata {
  // Bound the input before any allocation — license blobs are small (<2KB).
  if (licenseString.length > 10_000) {
    throw new Error("License verification failed: input exceeds maximum length");
  }
  try {
    // 1. Decode base64
    const decoded = Buffer.from(licenseString, "base64").toString("utf-8");
    const signedLicense = JSON.parse(decoded) as SignedLicense;

    if (!signedLicense.metadata || !signedLicense.signature) {
      throw new Error("Invalid license format: missing metadata or signature");
    }

    // 2. Verify signature
    const data = Buffer.from(canonicalize(signedLicense.metadata));
    const signature = Buffer.from(signedLicense.signature, "hex");

    const verified = crypto.verify(null, data, TANDEM_PUBLIC_KEY, signature);

    if (!verified) {
      throw new Error("Signature verification failed");
    }

    return signedLicense.metadata;
  } catch (error: any) {
    // Preserve already-wrapped messages to avoid double-wrapping.
    if (error instanceof Error && error.message.startsWith("License verification failed")) {
      throw error;
    }
    throw new Error(`License verification failed: ${error.message}`, { cause: error });
  }
}

/**
 * Verifies signature AND rejects an expired license. Stricter than the run
 * gate needs — kept for callers that want a single "valid & unexpired now"
 * check. The on-device run/update gate uses {@link verifyLicenseSignature}
 * plus its own `expiresAt` reading instead.
 */
export function verifyLicense(licenseString: string): LicenseMetadata {
  const metadata = verifyLicenseSignature(licenseString);
  if (metadata.expiresAt) {
    const expires = new Date(metadata.expiresAt);
    if (expires.getTime() < Date.now()) {
      throw new Error(`License expired on ${metadata.expiresAt}`);
    }
  }
  return metadata;
}
