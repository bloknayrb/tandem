/**
 * Grandfather list of known beta users eligible for a free license at v1.0.
 * Ref: ADR-040 §3 ("Existing beta users are grandfathered with a free signed license").
 */
export const GRANDFATHER_EMAILS = new Set([
  "bryan@tandem.chat",
  // Add actual beta-user emails here before v1.0 grandfathering runs.
  // Do not add @example.com placeholders — they will match real webhook events.
]);

/**
 * Checks if a given email address is in the beta grandfather list.
 */
export function isGrandfathered(email: string): boolean {
  if (!email) return false;
  return GRANDFATHER_EMAILS.has(email.toLowerCase().trim());
}
