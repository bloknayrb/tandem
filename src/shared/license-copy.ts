/**
 * License failure codes and the copy that explains them.
 *
 * In `shared/` because all three surfaces need it and none of them should reach
 * into another's tree: the HTTP route and `tandem activate` render activation
 * failures, while the client's AI-off notice, Settings, and `tandem license` render the
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
 * The first sentence of each refusal message, without its full stop. The shipped
 * skill tells Claude which remedy to give by which of these a message starts
 * with, so every message below is composed from them and a copy change here
 * reaches the skill's contract test instead of silently de-keying it.
 */
export const AI_REFUSAL_UNLICENSED_OPENING =
  "Tandem is unlicensed, so its AI features are turned off";
export const AI_REFUSAL_UNVERIFIABLE_OPENING =
  "Tandem's AI features are off because your license could not be verified";

/**
 * Refusal copy for a keyless install (trial over, no licence). Carries the
 * purchase URL, because Claude is its first reader and invents a link without one.
 */
export const AI_REFUSAL_UNLICENSED_MESSAGE =
  `${AI_REFUSAL_UNLICENSED_OPENING}. Your document is unaffected and ` +
  `stays fully editable. Activate a license to turn them back on: ${TANDEM_PURCHASE_URL}`;

/**
 * Appended only to a refused `initialize`. Claude Code marks the server failed
 * after one (measured over HTTP and the stdio bridge, 2026-10-12), and whether
 * any host handshakes again by itself is unmeasured, so activating alone may
 * not bring the AI back.
 * A refusal mid-session needs no hint: the next call heals on its own.
 */
export const AI_REFUSAL_RECONNECT_HINT =
  "Once that is done, reconnect Tandem in your AI client (in Claude Code, run /mcp).";

/**
 * The local-model loop's stderr line for the unlicensed refusal. Its own copy
 * because the shared one reassures about "your document", which reads wrong in
 * a server log with no document in view.
 */
export const AI_REFUSAL_LOCAL_MODEL_UNLICENSED_MESSAGE =
  `${AI_REFUSAL_UNLICENSED_OPENING}. ` +
  `Activate a license to turn them back on: ${TANDEM_PURCHASE_URL}`;

/**
 * Refusal copy for an installed licence that does not verify. **Never carries
 * the purchase URL** (ADR-040 decision 8): this reader most likely already paid,
 * and the remedy is a fix or a reissue, not a purchase. The prefix is what says
 * the AI is off — `unverifiableLicenseMessage` alone does not.
 */
export function aiRefusalUnverifiableMessage(code: LicenseUnverifiableCode): string {
  return `${AI_REFUSAL_UNVERIFIABLE_OPENING}. ` + unverifiableLicenseMessage(code);
}

/**
 * The opening of the fail-closed copy (#2206). Deliberately starts with neither
 * opening above, so the shipped skill routes it to its "any other message" arm
 * (say only that AI is off; do not guess a remedy), and names no licence: it is
 * never the copy for a licence file that is present but fails to verify.
 */
export const AI_REFUSAL_STATE_UNREADABLE_OPENING =
  "Tandem's AI features are off because Tandem could not read its license state";

/**
 * Refusal copy for `aiRefusal()`'s catch arm (#2206): resolving the state threw
 * (a corrupt `trial.json`, say), so Tandem cannot tell a keyless user from a
 * licensed one. The kind stays `unverifiable`, but the copy must not claim a
 * licence is installed (the reader may hold none) and **never carries the
 * purchase URL** or talks of activating a key or buying (the reader may have
 * paid). The remedy is a restart, then support.
 */
export const AI_REFUSAL_STATE_UNREADABLE_MESSAGE =
  `${AI_REFUSAL_STATE_UNREADABLE_OPENING}. Your document is unaffected and ` +
  `stays fully editable. Restart Tandem; if this keeps happening, email ${TANDEM_SUPPORT_EMAIL}.`;

/**
 * The activate route's error code and copy when the key WAS saved but
 * re-reading the licence state afterwards threw (a corrupt `trial.json`, say). Not a refusal:
 * `tandem activate` reports the key as installed and prints this line, and the
 * Settings form shows it. The remedy is a restart, then support.
 */
export const LICENSE_SAVED_STATE_UNREADABLE = "LICENSE_SAVED_STATE_UNREADABLE";
export const LICENSE_SAVED_STATE_UNREADABLE_MESSAGE =
  "Your license was saved, but Tandem couldn't read its license state back. " +
  `Restart Tandem to finish; if it still doesn't show as licensed, email ${TANDEM_SUPPORT_EMAIL}.`;

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
  /**
   * Well-formed, but not signed by any key this build trusts: a bad signature,
   * or a key id this build does not carry (a retired or newer signing key).
   */
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

/**
 * A grace end date as the reader's own calendar date, `YYYY-MM-DD` (#2231).
 * Local, not `iso.slice(0, 10)` (a UTC date), so the CLI, doctor and the
 * editor print the same day on the same machine. `""` for an unparseable value.
 */
export function formatGraceEndDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The full grace-period copy (#2231): Settings → License and `tandem license`.
 * The code-specific remedy first, then the promise. **Never carries the
 * purchase URL** (ADR-040 decision 8): this reader most likely paid. Every code
 * ends up naming the support address — `UNSUPPORTED_VERSION`'s remedy ("update
 * Tandem") is the one that does not on its own.
 */
export function licenseGraceMessage(code: LicenseUnverifiableCode, endsOn: string): string {
  const support =
    code === "UNSUPPORTED_VERSION" ? ` If that doesn't fix it, email ${TANDEM_SUPPORT_EMAIL}.` : "";
  return (
    `${unverifiableLicenseMessage(code)}${support} Tandem is keeping its AI features on until ` +
    `${endsOn} while this is sorted out.`
  );
}

/**
 * The activity-tray notice for the grace period (#2231). A `warning`, which
 * persists in the tray, so it follows that severity's tense convention: the
 * observation in the past tense, the promise in the future. Short, because the
 * full remedy is one click away in Settings → License. No purchase URL.
 */
export function licenseGraceNoticeMessage(endsOn: string): string {
  return (
    "Tandem couldn't verify the license installed on this device. Its AI features will " +
    `stay on until ${endsOn} — email ${TANDEM_SUPPORT_EMAIL} to get it sorted. ` +
    "Details are in Settings → License."
  );
}

/** The deactivate route's error code when `license.json` could not be deleted (#1943). */
export const LICENSE_REMOVE_FAILED = "LICENSE_REMOVE_FAILED";
export const LICENSE_REMOVE_FAILED_MESSAGE =
  "Tandem couldn't remove the license file. Try again — if it keeps failing, close anything " +
  "that may have it open (a sync client or antivirus scan) and check that you can write to " +
  "Tandem's application data folder.";

/**
 * Can the key behind this state be activated again on this build, from the
 * email it came in? Activation re-runs the same signature and schema checks,
 * so a key installed but failing `BAD_SIGNATURE` or `UNSUPPORTED_VERSION` is
 * refused again (#1943 review): removing it is not reversible here. A damaged
 * file (`MALFORMED`) or an unreadable one (`UNKNOWN`) says nothing about the
 * key itself, so the emailed copy still activates.
 */
export function licenseKeyReactivatable(code: LicenseUnverifiableCode | undefined): boolean {
  return code !== "BAD_SIGNATURE" && code !== "UNSUPPORTED_VERSION";
}

/**
 * What removing this device's licence will do (#1943), for Settings' confirm
 * step. Branches on the two facts that change the answer: whether the gate is
 * on in this build, and whether the installed key could be activated again.
 * Never carries the purchase URL.
 */
export function licenseRemovalConsequence(input: {
  gateActive: boolean;
  licenseUnverifiable?: LicenseUnverifiableCode;
  /** Dark build only: the file on disk would not verify once the gate is on. */
  darkFileUnverifiable?: boolean;
}): string {
  if (!input.gateActive && input.darkFileUnverifiable) {
    // No purchase URL: the reader most likely paid (decision 8).
    return (
      "Licensing isn't enforced in this version, so nothing changes now. This license file " +
      "doesn't pass Tandem's check, so it wouldn't work at v1.0 as it is. If you were sent a " +
      `newer key, activate that one; otherwise email ${TANDEM_SUPPORT_EMAIL}.`
    );
  }
  if (!input.gateActive) {
    return (
      "Licensing isn't enforced in this version, so nothing changes now — but this key will " +
      "be needed at v1.0. Keep the email it came in so you can activate it again."
    );
  }
  if (!licenseKeyReactivatable(input.licenseUnverifiable)) {
    const why =
      input.licenseUnverifiable === "UNSUPPORTED_VERSION"
        ? "This key can't be activated again until Tandem is updated"
        : "This key can't be activated again on this version of Tandem";
    return (
      `${why}, so removing it turns Tandem's AI features off now unless your trial is still ` +
      `running. The editor is unaffected. If you're not sure, email ${TANDEM_SUPPORT_EMAIL} first.`
    );
  }
  return (
    "Tandem's AI features will turn off unless your trial is still running. The editor is " +
    "unaffected. You can activate the same key again any time from the email it came in."
  );
}

/**
 * The line `tandem deactivate` prints after removing a licence (#1943), chosen
 * by what the removed file was. Past tense: the removal has happened.
 */
export function licenseRemovedMessage(
  wasUnverifiable: LicenseUnverifiableCode | undefined,
): string {
  if (wasUnverifiable === "UNSUPPORTED_VERSION") {
    return (
      "The removed key needs a newer version of Tandem, so it can be activated again only " +
      `after Tandem is updated. Email ${TANDEM_SUPPORT_EMAIL} if you need a hand.`
    );
  }
  if (wasUnverifiable === "BAD_SIGNATURE") {
    return (
      "The removed key failed its check on this version of Tandem, so activating it again " +
      `will be refused here. Email ${TANDEM_SUPPORT_EMAIL} to have it reissued.`
    );
  }
  return "Activate the same key again any time (keep the email it came in).";
}
