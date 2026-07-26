/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "crypto";
import type { LicenseVerifyCode } from "../../shared/license-copy.js";
import type { LicenseMetadata, SignatureVerified, SignedLicense } from "./license-types.js";
import { normalizePastedLicense } from "./paste.js";
import { TANDEM_PUBLIC_KEY } from "./public-key.js";

export type { LicenseVerifyCode };

export function canonicalObject(obj: any): any {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalObject);
  }
  const sortedKeys = Object.keys(obj).sort();
  // Null-prototype accumulator so a `__proto__` (or `constructor`/`prototype`)
  // own-key is canonicalized as a normal key instead of mutating the prototype
  // (plain `{}` + `sortedObj["__proto__"] = …` would silently drop it from the
  // signed bytes). Symmetric signer/verifier either way, but this removes the
  // foot-gun if the trusted field set ever grows.
  const sortedObj: any = Object.create(null);
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
 * The code is the ONLY thing that crosses this boundary — never the input bytes,
 * never the underlying parse/crypto message (which can embed blob content).
 * The union and its copy live in `src/shared/license-copy.ts`.
 */
export class LicenseVerifyError extends Error {
  constructor(
    readonly code: LicenseVerifyCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LicenseVerifyError";
  }
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
export function verifyLicenseSignature(rawLicenseString: string): SignatureVerified {
  // Bound the RAW input first — the normalize below allocates a new string, and
  // "bound before any allocation" is the whole point of this check. The raw
  // ceiling is deliberately looser than the post-normalize one: quoted-printable
  // soft breaks only ever ADD bytes, so anything that could legitimately
  // normalize down to <=10k starts well under 20k.
  if (rawLicenseString.length > 20_000) {
    throw new LicenseVerifyError(
      "TOO_LONG",
      "License verification failed: input exceeds maximum length",
    );
  }

  // Repair transport damage HERE, at the crypto boundary, rather than at each
  // entry point. A quoted-printable soft break is mail-transport corruption, and
  // this is the layer that should tolerate it before hashing — putting it at the
  // call sites made it a contract every future caller has to remember, and one
  // caller ALREADY forgot: `resolveLicenseState` reads `license.json` straight
  // off disk and verifies it raw. A blob saved with a soft break still in it
  // would then fail on every boot, forever, reported as "installed but could not
  // be verified" with copy blaming a signing-key rotation.
  //
  // This cannot forge anything: whatever survives the transform must still carry
  // a valid Ed25519 signature over its own canonicalized metadata.
  const licenseString = normalizePastedLicense(rawLicenseString);

  // Re-bound after normalizing — stripping an interior `=` can LENGTHEN the
  // decode (Node treats `=` as terminating), so this check must run on exactly
  // the string that gets decoded, not on the raw input.
  if (licenseString.length > 10_000) {
    throw new LicenseVerifyError(
      "TOO_LONG",
      "License verification failed: input exceeds maximum length",
    );
  }
  try {
    // 1. Decode base64
    const decoded = Buffer.from(licenseString, "base64").toString("utf-8");
    // Bound the DECODED payload too — a deeply-nested array can fit inside the
    // 10k input bound yet blow the recursion stack in canonicalObject. Real
    // blobs are <2KB; 4KB is a generous ceiling that rejects the pathological
    // case before any parse/recurse.
    if (decoded.length > 4096) {
      throw new LicenseVerifyError(
        "TOO_LONG",
        "License verification failed: payload exceeds maximum length",
      );
    }
    const signedLicense = JSON.parse(decoded) as SignedLicense;

    if (!signedLicense.metadata || !signedLicense.signature) {
      throw new LicenseVerifyError(
        "MALFORMED",
        "License verification failed: missing metadata or signature",
      );
    }

    // 2. Verify signature
    const data = Buffer.from(canonicalize(signedLicense.metadata));
    const signature = Buffer.from(signedLicense.signature, "hex");

    const verified = crypto.verify(null, data, TANDEM_PUBLIC_KEY, signature);

    if (!verified) {
      throw new LicenseVerifyError("BAD_SIGNATURE", "License verification failed: bad signature");
    }

    // Brand: this metadata is now signature-verified (run-gate may trust it).
    return signedLicense.metadata as SignatureVerified;
  } catch (error: any) {
    // Preserve an already-classified error rather than re-wrapping it.
    if (error instanceof LicenseVerifyError) throw error;
    // Everything reaching here is a decode/parse failure (bad base64 → garbage
    // UTF-8 → JSON.parse throws) or a malformed hex signature that made
    // crypto.verify throw. Both mean "this isn't a license blob".
    throw new LicenseVerifyError("MALFORMED", `License verification failed: ${error.message}`, {
      cause: error,
    });
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
