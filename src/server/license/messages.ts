/**
 * User-facing copy for license activation failures.
 *
 * Lives here — not in the HTTP route — so the CLI can share it without pulling
 * Express (and the integrations route module) into the `tandem` bundle. One
 * taxonomy, three transports: `POST /api/license/activate`, `tandem activate`,
 * and the client form that renders whatever the route returns.
 */
import { TANDEM_SUPPORT_EMAIL } from "../../shared/constants.js";
import type { LicenseActivationCode } from "./errors.js";

/**
 * Map an activation failure to copy a buyer can act on.
 *
 * All of these used to collapse into "License could not be verified. Check that
 * you pasted the full license." — including a filesystem write failure, which
 * told someone holding a perfectly good key that their key was bad.
 *
 * The messages are static strings by design: the underlying error can embed blob
 * bytes, so only the code crosses this boundary.
 */
export function activationErrorMessage(code: LicenseActivationCode | "UNKNOWN"): string {
  switch (code) {
    case "TOO_LONG":
      return (
        "That's longer than a license key — it looks like the whole email was pasted. " +
        "Copy just the long block of letters and numbers, or use the attached .license file."
      );
    case "MALFORMED":
      return "That doesn't look like a license key. Copy the whole key, with no text around it.";
    case "BAD_SIGNATURE":
      return (
        "This key wasn't issued for this build of Tandem. If it was issued a long time ago " +
        `it may need to be reissued — email ${TANDEM_SUPPORT_EMAIL}.`
      );
    case "UNSUPPORTED_VERSION":
      return "This license needs a newer version of Tandem. Update Tandem and try again.";
    case "WRITE_FAILED":
      return (
        "Your license is valid, but Tandem couldn't save it — check that you have permission " +
        "to write to Tandem's application data folder, then try again."
      );
    default:
      return `Activation failed unexpectedly. Email ${TANDEM_SUPPORT_EMAIL} and we'll sort it out.`;
  }
}
