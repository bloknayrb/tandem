/**
 * Grandfather list of known beta users eligible for a free license at v1.0.
 * Ref: ADR-040 §3 ("Existing beta users are grandfathered with a free signed license").
 */
export const GRANDFATHER_EMAILS = new Set([
  "bryan@tandem.chat",
  "bryan.kolb@example.com",
  "beta-tester-1@example.com",
  "beta-tester-2@example.com",
  "early-adopter@example.com",
]);

/**
 * Checks if a given email address is in the beta grandfather list.
 */
export function isGrandfathered(email: string): boolean {
  if (!email) return false;
  return GRANDFATHER_EMAILS.has(email.toLowerCase().trim());
}
