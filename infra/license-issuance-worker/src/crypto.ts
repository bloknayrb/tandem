/**
 * Crypto primitives for the license-issuance Worker. Pure, runtime-agnostic:
 * everything here runs unchanged on the Cloudflare Workers runtime AND under
 * vitest on Node 22, because both are V8 and both expose the same
 * `globalThis.crypto.subtle`, `atob`, `btoa`, and `TextEncoder`.
 *
 * The two hard requirements this module satisfies:
 *  1. `canonicalize` is a BYTE-FOR-BYTE copy of the server verifier's
 *     (`src/server/license/verifier.ts`) so a blob signed here verifies there.
 *     A parity test asserts this against the real verifier.
 *  2. Paddle Billing's `Paddle-Signature` scheme (ts + h1 HMAC-SHA256 hex).
 */

// ---------------------------------------------------------------------------
// Encoding helpers (standard base64 + hex). btoa/atob operate on binary
// strings; we chunk to stay well under any argument-count limit even though
// our inputs (a 64-byte sig, a <1KB blob) are tiny.
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode standard base64 to bytes. Throws on invalid input (callers catch). */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex;
}

// ---------------------------------------------------------------------------
// Canonical JSON — MUST stay byte-identical to src/server/license/verifier.ts.
// Null-prototype accumulator so a `__proto__` own-key is canonicalized as a
// normal key instead of mutating the prototype. See verifier.ts for the why.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canonicalObject(obj: any): any {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(canonicalObject);
  const sortedKeys = Object.keys(obj).sort();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sortedObj: any = Object.create(null);
  for (const key of sortedKeys) sortedObj[key] = canonicalObject(obj[key]);
  return sortedObj;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canonicalize(obj: any): string {
  return JSON.stringify(canonicalObject(obj));
}

// ---------------------------------------------------------------------------
// Constant-time compare. Prefers the Workers-native
// `crypto.subtle.timingSafeEqual` (Rust, truly constant-time); falls back to a
// length-guarded XOR accumulate under Node/vitest where the native extension is
// absent. Length mismatch → false WITHOUT touching the native fn (it throws on
// unequal lengths). Never early-returns inside the compare loop.
// ---------------------------------------------------------------------------

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const native = (globalThis.crypto?.subtle as any)?.timingSafeEqual;
  if (typeof native === "function") {
    try {
      return native.call(globalThis.crypto.subtle, a, b) as boolean;
    } catch {
      return false;
    }
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 via WebCrypto (works on Workers + Node 22).
// ---------------------------------------------------------------------------

async function hmacSha256(
  keyBytes: Uint8Array<ArrayBuffer>,
  msg: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, msg);
  return new Uint8Array(sig);
}

// ---------------------------------------------------------------------------
// Paddle Billing webhook verification.
//   header   = `Paddle-Signature: ts=<unix>;h1=<hex>[;h1=<hex>...]`
//   signed   = `${ts}:${rawBody}`
//   key      = UTF-8 bytes of the destination secret, used AS IS (inferred; the
//              SDK test vector settles it)
//   expected = hex( HMAC-SHA256(key, signed) ); match any h1 entry.
// ---------------------------------------------------------------------------

/** Most `h1` entries a header may carry. Paddle sends more than one only during
 * a secret rotation; an attacker-supplied header with hundreds of entries would
 * otherwise buy that many compares for free. */
export const MAX_H1_ENTRIES = 8;

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** Decode lowercase/uppercase hex to bytes. Throws on odd length or a non-hex
 * character (callers pre-validate with a strict regex). */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function verifyPaddleSignature(
  header: string | null,
  rawBody: string,
  secret: string,
  nowMs: number,
  toleranceS: number,
): Promise<boolean> {
  if (!header || !secret) return false;
  let ts: string | null = null;
  const h1s: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "ts") {
      if (ts !== null) return false; // a second ts is ambiguous: refuse
      ts = v;
    } else if (k === "h1") {
      h1s.push(v);
      if (h1s.length > MAX_H1_ENTRIES) return false;
    }
  }
  if (ts === null || h1s.length === 0) return false;
  if (!/^\d+$/.test(ts)) return false;
  const tsNum = Number(ts);
  if (!Number.isSafeInteger(tsNum)) return false;
  if (Math.abs(nowMs / 1000 - tsNum) > toleranceS) return false;

  const expected = await hmacSha256(
    textEncoder.encode(secret),
    textEncoder.encode(`${ts}:${rawBody}`),
  );
  let matched = false;
  for (const h of h1s) {
    if (!HEX_SHA256.test(h)) continue;
    if (constantTimeEqual(hexToBytes(h), expected)) matched = true;
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Ed25519 signing. Node's `crypto.sign(null, data, key)` and WebCrypto's
// `subtle.sign("Ed25519", key, data)` both emit the raw 64-byte signature, so
// the hex encoding below verifies under the server's `crypto.verify(null, ...)`.
// ---------------------------------------------------------------------------

/** PEM (PKCS#8) → CryptoKey for Ed25519 signing. Throws on malformed input. */
export async function importPkcs8Ed25519(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const der = base64ToBytes(b64);
  return globalThis.crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
}

/** Decode base64url (RFC 4648 §5, unpadded as JWK emits it) to bytes. */
export function base64UrlToBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytes(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "="));
}

/**
 * The key id of a PKCS#8 Ed25519 private key: lowercase hex of the first 8
 * bytes of SHA-256 over its raw 32-byte public value. Must equal the server's
 * `keyIdForPublicKey` (src/server/license/public-key.ts) for the same key pair.
 *
 * The public value is the JWK `x`, which WebCrypto exposes only for a key
 * imported as extractable, so this import is separate from the signing import
 * above, which stays non-extractable. `x` is base64url: plain `atob` throws on
 * its `-`/`_`, and today's production key contains `_`.
 */
export async function keyIdOfPkcs8Ed25519(pem: string): Promise<string> {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const key = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    base64ToBytes(b64),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", key);
  if (typeof jwk.x !== "string") throw new Error("Ed25519 JWK export has no public value");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", base64UrlToBytes(jwk.x));
  return bytesToHex(new Uint8Array(digest).subarray(0, 8));
}

/**
 * A function that produces a raw 64-byte Ed25519 signature over `data`.
 *
 * The asymmetry between the two `Uint8Array` positions is deliberate. The
 * parameter is narrowed to `Uint8Array<ArrayBuffer>` because every implementer
 * hands it to `crypto.subtle.sign`, whose `BufferSource` rejects the
 * `ArrayBufferLike` default under TS 5.7 -- a `SharedArrayBuffer`-backed view
 * is assignable to the wide type and not to `BufferSource`. The return is left
 * wide: return position is covariant, so narrowing it constrains every
 * implementer of an exported type rather than the caller, and would reject the
 * natural Node signer `async (d) => crypto.sign(null, Buffer.from(d), key)`,
 * whose `Buffer` is `Uint8Array<ArrayBufferLike>`. Consumers only read the
 * bytes.
 */
export type SignBytes = (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

/** Production signer bound to an imported Ed25519 CryptoKey. */
export function webCryptoSigner(key: CryptoKey): SignBytes {
  return async (data) => new Uint8Array(await globalThis.crypto.subtle.sign("Ed25519", key, data));
}

/**
 * Sign license metadata and return the base64 SignedLicense blob the on-device
 * `verifyLicenseSignature` accepts: base64( JSON({ metadata, signature: hex }) ),
 * where the signature is over the UTF-8 bytes of `canonicalize(metadata)`.
 */
export async function signLicense(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any,
  signBytes: SignBytes,
): Promise<string> {
  const data = textEncoder.encode(canonicalize(metadata));
  const sig = await signBytes(data);
  const signedLicense = { metadata, signature: bytesToHex(sig) };
  return bytesToBase64(textEncoder.encode(JSON.stringify(signedLicense)));
}
