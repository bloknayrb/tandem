// Pinned public key for Ed25519 license verification.
//
// The corresponding private key must never be committed (`keys/` is gitignored).
// It lives in the issuance Worker as the `TANDEM_PRIVATE_KEY` secret
// (`npx wrangler secret put TANDEM_PRIVATE_KEY`) and in the operator's own
// offline copies. `wrangler secret put` is WRITE-ONLY — you cannot read a secret
// back out — so it is NOT a backup. Keep two independent offline copies in
// different physical locations.
//
// THIS KEY IS NOT ROTATABLE TODAY. There is one const and no `keyId`, so
// replacing it drops every existing customer to `restricted` — mid-session,
// clamping their open documents read-only via `connection-gate.ts`. If a
// rotation story is ever needed, the cheap version is to accept an ARRAY of
// public keys here (a few lines, and it makes rotation routine). Adding a
// `keyId` to the signed metadata instead would change the signed bytes, so it
// has to happen before the first sale or not at all.
//
// Its fingerprint is pinned by `tests/server/license.test.ts` — a change here
// fails CI until the expected SHA-256 is updated in the same commit.
// Re-generate with `npx tsx scripts/generate-keys.ts` before first use.
export const TANDEM_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7gm5YEEylcqDgxr1rQ/gA/K8ZzOPfqmvUBtE6CI8QCk=
-----END PUBLIC KEY-----`;
