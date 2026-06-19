export interface LicenseMetadata {
  id: string; // Unique ID (e.g. UUID)
  name: string;
  email: string;
  type: "personal" | "commercial" | "grandfathered";
  createdAt: string; // ISO string
  expiresAt: string | null; // ISO string or null for never (end of update window)
  version: string; // "1.0"
}

export interface SignedLicense {
  metadata: LicenseMetadata;
  signature: string; // Hex signature
}

/**
 * Ed25519-signature-VERIFIED license metadata. A phantom string-literal brand
 * (compile-time only — no runtime field) so the run-gate seam can demand a
 * signature-checked value: the ONLY way to obtain one is through
 * `verifyLicenseSignature`. This makes wiring the stricter, expiry-checking
 * `verifyLicense` into the run gate a COMPILE ERROR — that swap would silently
 * drop a paid user to `restricted` past their update window (run-forever is the
 * contract; expiry governs only updates). String-literal brand (not `unique
 * symbol`) for TS-version portability.
 */
export type SignatureVerified = LicenseMetadata & { readonly __runGateChecked: "signature" };

/** On-device license state, computed fresh on every read (no cache). */
export type LicenseStatus = "trial" | "licensed" | "restricted";

/** Trial-clock subset surfaced in `LicenseState` (trial arm) and the status wire. */
export interface TrialInfo {
  firstRunAt: string;
  expiresAt: string;
  daysRemaining: number;
}

/** `{APP_DATA}/trial.json` — the soft on-device trial clock. */
export interface TrialFile {
  version: 1;
  firstRunAt: string; // ISO string
}

/** `{APP_DATA}/license.json` — the activated signed-license blob. */
export interface LicenseFile {
  version: 1;
  blob: string; // base64 SignedLicense
}

/**
 * On-device license state — a discriminated union so illegal combinations are
 * unrepresentable (you can't construct `{status:"restricted", license}` or a
 * trial with a `license`). Narrow on `gateActive` first, then `status`.
 *
 *  - `{ gateActive: false }` — dark build / pre-v1.0. NO status: the synthetic
 *    "licensed" sentinel is gone; consumers must narrow before reading `status`.
 *    (The status WIRE keeps emitting a back-compat shape — see routes/license.ts.)
 *  - trial / restricted — `updateWindowCurrent` is always `false`.
 *  - licensed — carries the signature-verified `license` + opaque `licenseId`;
 *    `updateWindowCurrent` governs ONLY the update window (run-forever otherwise).
 */
export type LicenseState =
  | { gateActive: false }
  | { gateActive: true; status: "trial"; trial: TrialInfo; updateWindowCurrent: false }
  | { gateActive: true; status: "restricted"; updateWindowCurrent: false }
  | {
      gateActive: true;
      status: "licensed";
      license: LicenseMetadata;
      licenseId: string; // opaque UUID for the updater; never PII
      updateWindowCurrent: boolean; // expiresAt === null || expiresAt > now
    };

/**
 * What the Worker needs to gate an update check, written to Cloudflare KV by the
 * issuance webhook. Canonical shape shared by the writer (`kv-store.ts`); the
 * update Worker (`infra/license-update-worker/`) keeps a structurally-identical
 * local copy (separate Cloudflare build) kept in lockstep by a parity test.
 * `updateWindowEnd: null` ⇒ never expires (grandfathered).
 */
export interface LicenseEntitlement {
  updateWindowEnd: string | null;
  status: LicenseMetadata["type"]; // "personal" | "commercial" | "grandfathered"
  version: string; // license schema version
}
