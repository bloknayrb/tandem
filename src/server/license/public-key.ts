// Pinned public key for Ed25519 license verification.
// IMPORTANT: The corresponding private key must be stored securely by Bryan Kolb
// (not committed to git). Store as the TANDEM_PRIVATE_KEY environment variable on the
// webhook server. Re-generate with `npx tsx scripts/generate-keys.ts` before first use.
export const TANDEM_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7gm5YEEylcqDgxr1rQ/gA/K8ZzOPfqmvUBtE6CI8QCk=
-----END PUBLIC KEY-----`;
