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
import { TANDEM_PURCHASE_URL, TANDEM_SUPPORT_EMAIL } from "./constants.js";

/**
 * The wire discriminant every AI refusal carries (#1521): the `/api` 403 body's
 * `error`, the MCP JSON-RPC error's `data.error`, and the wake socket's close
 * reason. Consumers bundled WITHOUT the licence `define` (the stdio bridge, the
 * channel shim, the plugin monitor, the shared SSE consumer) key on this string
 * alone and never import the server's licence modules.
 */
export const LICENSE_REQUIRED = "LICENSE_REQUIRED";

/**
 * JSON-RPC error code for a licence refusal on `/mcp`. Implementation-defined
 * server-error range (JSON-RPC 2.0 §5.1); unused by the MCP SDK 1.30/1.31.
 */
export const LICENSE_REQUIRED_RPC_CODE = -32003;

/** Why the AI is refused: no licence at all, or a licence on disk that fails to verify. */
export type AiRefusalKind = "unlicensed" | "unverifiable";

/**
 * Refusal copy for a keyless install (trial over, no licence). Carries the
 * purchase URL, because Claude is its first reader and invents a link without one.
 */
export const AI_REFUSAL_UNLICENSED_MESSAGE =
  "Tandem is unlicensed, so its AI features are turned off. Your document is unaffected and " +
  `stays fully editable. Activate a license to turn them back on: ${TANDEM_PURCHASE_URL}`;

/** The local-model loop's stderr line for the same refusal (no document to reassure about). */
export const AI_REFUSAL_LOCAL_MODEL_UNLICENSED_MESSAGE =
  "Tandem is unlicensed, so its AI features are turned off. " +
  `Activate a license to turn them back on: ${TANDEM_PURCHASE_URL}`;

/**
 * Refusal copy for an installed licence that does not verify. **Never carries
 * the purchase URL** (ADR-040 decision 8): this reader most likely already paid,
 * and the remedy is a fix or a reissue, not a purchase. The prefix is what says
 * the AI is off — `unverifiableLicenseMessage` alone does not.
 */
export function aiRefusalUnverifiableMessage(code: LicenseUnverifiableCode): string {
  return (
    "Tandem's AI features are off because your license could not be verified. " +
    unverifiableLicenseMessage(code)
  );
}

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
      // Deliberately names two causes. The writer has no rename retry, so a
      // transient hold (an antivirus scanner, a sync client) surfaces here
      // exactly like a permissions problem — and telling someone to go fix
      // folder permissions when the real answer is "try again" wastes their time.
      return (
        "Your license is valid, but Tandem couldn't save it. Try again — if it keeps " +
        "failing, check that you have permission to write to Tandem's application data folder."
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
