// Pinned public keys for Ed25519 license verification.
//
// The private keys must never be committed (`keys/` is gitignored). The active
// one lives in the issuance Worker as the `TANDEM_PRIVATE_KEY` secret
// (`npx wrangler secret put TANDEM_PRIVATE_KEY`) and in the operator's own
// offline copies. `wrangler secret put` is WRITE-ONLY — you cannot read a secret
// back out — so it is NOT a backup. Keep two independent offline copies in
// different physical locations.
//
// Every license carries a `keyId` naming the key that signed it, and the id IS
// that key's fingerprint (`keyIdForPublicKey`): signers derive it from the key
// they sign with, so a license can never claim a key other than its signer's.
// A license with no `keyId` is refused as an unknown key: the only key that
// signed without ids (`79c10e75fb8cfa46`) was lost and retired before any
// license was issued with it (docs/licensing-operations.md §0).
//
// Rotation (docs/licensing-operations.md §0 has the full procedure): add the new
// PEM here AND its id to the issuance Worker's `TRUSTED_KEY_IDS` in one commit,
// release it, let builds adopt it, then switch the Worker secret. Removing a key
// drops every license it signed to `restricted`; after a leak, that is the point.
//
// Every entry is pinned by `tests/server/license.test.ts`: a change here fails
// CI until the expected fingerprints are updated in the same commit. A duplicate
// id throws at module load, which ends the server's boot; that is intended, and
// CI imports this module, so it cannot reach a release.
import crypto from "node:crypto";

export const TRUSTED_PUBLIC_KEYS: readonly string[] = Object.freeze([
  // c24dd9f66f449a56, generated at the 2026-10-20 ceremony.
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZI8LvFVXCim5r2o/RFfNdbeZPyP0mbw92Jta8DS67fw=
-----END PUBLIC KEY-----`,
]);

/** A key id is 16 lowercase hex characters. Anything else is malformed. */
export const KEY_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * The key id of an Ed25519 public key: lowercase hex of the first 8 bytes of
 * SHA-256 over its raw 32-byte value (the JWK `x`, base64url-decoded). The
 * issuance Worker computes the same thing with WebCrypto.
 */
export function keyIdForPublicKey(key: string | crypto.KeyObject): string {
  const keyObject = typeof key === "string" ? crypto.createPublicKey(key) : key;
  const { x } = keyObject.export({ format: "jwk" });
  if (typeof x !== "string") throw new Error("not an Ed25519 public key");
  const raw = Buffer.from(x, "base64url");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Index PEMs by key id: a frozen, null-prototype object, so no inherited name
 * (`__proto__`, `constructor`) can resolve to a key. Exported so tests build
 * their maps exactly the way production does.
 */
export function buildKeyMap(pems: readonly string[]): Readonly<Record<string, string>> {
  const map: Record<string, string> = Object.create(null);
  for (const pem of pems) {
    const id = keyIdForPublicKey(pem);
    if (Object.hasOwn(map, id)) throw new Error(`duplicate license key id ${id}`);
    map[id] = pem;
  }
  return Object.freeze(map);
}

export const KEYS_BY_ID = buildKeyMap(TRUSTED_PUBLIC_KEYS);
