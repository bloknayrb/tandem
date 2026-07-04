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
 *  2. Standard-Webhooks (svix) signature verification exactly matches Polar's
 *     scheme — including the `whsec_`-prefix base64 decode of the secret, which
 *     is the single most common integration bug.
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
export function base64ToBytes(b64: string): Uint8Array {
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

async function hmacSha256(keyBytes: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
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
// Standard-Webhooks (svix) verification — the scheme Polar uses.
//   signed content = `${id}.${timestamp}.${rawBody}`
//   key            = base64decode(secret without the `whsec_` prefix)
//   expected       = base64( HMAC-SHA256(key, signed) )
//   header value   = space-delimited `v<n>,<b64sig>` list; match any v1 entry.
// Each retry attempt is freshly timestamped+signed with a constant webhook-id,
// so a strict freshness window does not reject legitimate retries.
// ---------------------------------------------------------------------------

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export async function verifyStandardWebhook(
  headers: WebhookHeaders,
  rawBody: string,
  secret: string,
  nowMs: number,
  toleranceS: number,
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  // Strict integer parse — reject NaN/`123abc` outright.
  const tsNum = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum) || String(tsNum) !== timestamp.trim()) return false;
  if (Math.abs(nowMs / 1000 - tsNum) > toleranceS) return false;

  // Strip the `whsec_` prefix, then base64-DECODE the remainder to key bytes.
  // Feeding the raw string (or the whole `whsec_...`) as the key is the classic
  // integration bug — it computes a stable-but-wrong MAC that never matches.
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  } catch {
    return false;
  }

  const signed = textEncoder.encode(`${id}.${timestamp}.${rawBody}`);
  const expected = await hmacSha256(keyBytes, signed);

  // The header may carry multiple space-delimited signatures (key rotation).
  // Decode each `v1,<b64>` entry to raw bytes; skip malformed/wrong-length
  // entries WITHOUT comparing (only fixed-length 32-byte candidates reach the
  // constant-time compare).
  for (const part of signature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma < 0) continue;
    if (part.slice(0, comma) !== "v1") continue;
    const val = part.slice(comma + 1);
    if (!val) continue;
    let candidate: Uint8Array;
    try {
      candidate = base64ToBytes(val);
    } catch {
      continue;
    }
    if (candidate.length !== expected.length) continue;
    if (constantTimeEqual(candidate, expected)) return true;
  }
  return false;
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

/** A function that produces a raw 64-byte Ed25519 signature over `data`. */
export type SignBytes = (data: Uint8Array) => Promise<Uint8Array>;

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
