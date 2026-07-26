/**
 * License failure codes and the copy that explains them.
 *
 * In `shared/` because all three surfaces need it and none of them should reach
 * into another's tree: the HTTP route and `tandem activate` render activation
 * failures, while the client wall, Settings, and `tandem license` render the
 * "installed but unverifiable" case. The alternative was the same paragraph
 * hand-written in three components plus the CLI, which is exactly how the three
 * copies drifted before.
 *
 * Contains no secrets and no I/O — pure string mapping, safe in the browser
 * bundle.
 */
import { TANDEM_SUPPORT_EMAIL } from "./constants.js";

/**
 * Why a signature check failed. Produced by `verifyLicenseSignature`.
 *
 * The distinction is the whole point: a buyer who pasted their entire
 * confirmation email, one holding a license signed by a retired key, and one on
 * a Tandem too old to understand their license used to get one identical
 * "License could not be verified" — and all three read it as "your key is bad".
 */
export type LicenseVerifyCode =
  /** Input longer than any real license — almost always a pasted email body. */
  | "TOO_LONG"
  /** Not base64, not JSON, or missing metadata/signature. */
  | "MALFORMED"
  /** Well-formed, but not signed by the key this build trusts. */
  | "BAD_SIGNATURE";

/**
 * Why an activation attempt failed.
 *
 * Derived from `LicenseVerifyCode` rather than restating its three members —
 * `activateLicense` passes a verifier code straight through, and when these were
 * two hand-written unions that passthrough only typechecked because the string
 * literals happened to agree.
 *
 * `WRITE_FAILED` is the one that mattered most: the persist call sat inside the
 * same try the route caught, so an EACCES / EROFS / ENOSPC / ENOENT was reported
 * to the buyer as "check that you pasted the full license".
 */
export type LicenseActivationCode = LicenseVerifyCode | "UNSUPPORTED_VERSION" | "WRITE_FAILED";

/**
 * Why a license file already on disk doesn't verify. In practice
 * `BAD_SIGNATURE` (issued under a retired key), `MALFORMED` (damaged file), or
 * `UNSUPPORTED_VERSION`; `UNKNOWN` covers a verifier that threw unclassified.
 */
export type LicenseUnverifiableCode = LicenseActivationCode | "UNKNOWN";

/**
 * Copy for a failed ACTIVATION — the user just handed us a key.
 *
 * Static strings by design: the underlying error can embed blob bytes, so only
 * the code crosses this boundary.
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

/**
 * Copy for a license ALREADY INSTALLED that no longer verifies.
 *
 * Different situation, different advice: the user isn't mid-paste, they have a
 * file on disk that stopped working. Carrying the code this far is the point —
 * "have it reissued", "the file is damaged" and "update Tandem" are three
 * different actions, and a boolean forced every surface to hedge across all
 * three in one sentence.
 */
export function unverifiableLicenseMessage(code: LicenseUnverifiableCode): string {
  switch (code) {
    case "BAD_SIGNATURE":
      return (
        "A license is installed on this device, but it wasn't signed for this build of Tandem " +
        `— it most likely predates a signing-key change. Email ${TANDEM_SUPPORT_EMAIL} to have ` +
        "it reissued."
      );
    case "UNSUPPORTED_VERSION":
      return (
        "A license is installed on this device, but it needs a newer version of Tandem. " +
        "Update Tandem to use it."
      );
    default:
      return (
        "A license is installed on this device, but Tandem couldn't read it — the file may be " +
        `damaged. Activate it again from the key you were sent, or email ${TANDEM_SUPPORT_EMAIL}.`
      );
  }
}
