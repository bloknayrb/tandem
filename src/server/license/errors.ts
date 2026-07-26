/**
 * License activation error taxonomy.
 *
 * Split into its own module so the copy (`messages.ts`), the CLI, and the HTTP
 * route can all depend on the codes without importing `license-state.ts`'s
 * filesystem machinery.
 */

/**
 * Why an activation attempt failed. `TOO_LONG` / `MALFORMED` / `BAD_SIGNATURE`
 * mirror `LicenseVerifyCode`; the other two are raised by `activateLicense`.
 *
 * `WRITE_FAILED` is the one that mattered most: `atomicWrite` sat inside the
 * same try the route caught, so an EACCES / EROFS / ENOSPC / ENOENT was
 * reported to the buyer as "check that you pasted the full license".
 */
export type LicenseActivationCode =
  | "TOO_LONG"
  | "MALFORMED"
  | "BAD_SIGNATURE"
  | "UNSUPPORTED_VERSION"
  | "WRITE_FAILED";

export class LicenseActivationError extends Error {
  constructor(
    readonly code: LicenseActivationCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LicenseActivationError";
  }
}
