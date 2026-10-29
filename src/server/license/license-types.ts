import type { LicenseUnverifiableCode } from "../../shared/license-copy.js";

export interface LicenseMetadata {
  id: string; // Unique ID (e.g. UUID)
  // No `name`: the buyer is identified by email alone, so a key carries no
  // more PII than it needs (docs/licensing-operations.md §0, decision 2).
  email: string;
  type: "personal" | "commercial" | "grandfathered";
  createdAt: string; // ISO string
  expiresAt: string | null; // ISO string or null for never (end of update window)
  version: string; // "1.0"
  /**
   * The signing key's id (`keyIdForPublicKey`). Required: the only key that
   * ever signed without one was retired (docs/licensing-operations.md §0), so
   * a keyless license names no key this build trusts and is refused.
   */
  keyId: string;
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

/**
 * On-device license state, computed fresh on every read (no cache).
 *
 * `grace` (#2231) is the one non-licensed status that ADMITS by design: an
 * installed licence failed its check less than `LICENSE_GRACE_DAYS` ago.
 * `restricted` stays the only refusing literal, everywhere — `aiRefusalFor`,
 * and the desktop updater's `update_route`, which withholds by that name only.
 */
export type LicenseStatus = "trial" | "licensed" | "restricted" | "grace";

/** Trial-clock subset surfaced in `LicenseState` (trial arm) and the status wire. */
export interface TrialInfo {
  firstRunAt: string;
  expiresAt: string;
  daysRemaining: number;
}

/** The grace subset surfaced in `LicenseState` (grace arm) and the status wire (#2231). */
export interface GraceInfo {
  /** When this licence file first failed its check (ISO). */
  firstFailedAt: string;
  /** When the AI features turn off unless the licence is fixed (ISO). */
  endsAt: string;
  /** Whole days left, clamped to `[0, LICENSE_GRACE_DAYS]`. */
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
 *
 * `licenseUnverifiable` marks the trial/restricted arms reached DESPITE a
 * `license.json` being present, and carries WHY (bad signature, unknown schema,
 * corrupt file). It changes no enforcement — an unverified license must not
 * unlock — but every user-facing surface needs it, or someone holding a license
 * is told their trial ended. Only ever set on the non-licensed arms; the
 * licensed arm is by construction verified.
 *
 * `licenseUnverifiable` is deliberately NOT a status of its own: diagnosis and
 * entitlement are orthogonal axes. `ai-refusal.ts` decides on
 * `status === "restricted"`, so any new status fails OPEN at every AI
 * admission point — which is why a status is added only when admitting is the
 * point.
 *
 *  - grace (#2231, ADR-040 amendment 2026-10-28) — the one status added that
 *    way: a licence file is installed, fails its check, and first failed less
 *    than `LICENSE_GRACE_DAYS` ago. The AI stays on, updates keep flowing
 *    (`update_route` withholds by the name `restricted` only), and every
 *    human-facing surface shows a notice to contact support. It always carries
 *    `licenseUnverifiable` (required, not optional) and never a licence, and
 *    `updateWindowCurrent` is `false` as on the other non-licensed arms.
 */
export type LicenseState =
  | { gateActive: false }
  | {
      gateActive: true;
      status: "trial";
      trial: TrialInfo;
      updateWindowCurrent: false;
      licenseUnverifiable?: LicenseUnverifiableCode;
    }
  | {
      gateActive: true;
      status: "restricted";
      updateWindowCurrent: false;
      licenseUnverifiable?: LicenseUnverifiableCode;
    }
  | {
      gateActive: true;
      status: "grace";
      grace: GraceInfo;
      updateWindowCurrent: false;
      licenseUnverifiable: LicenseUnverifiableCode;
    }
  | {
      gateActive: true;
      status: "licensed";
      license: LicenseMetadata;
      licenseId: string; // opaque UUID for the updater; never PII
      updateWindowCurrent: boolean; // expiresAt === null || expiresAt > now
    };

/**
 * What the Worker needs to gate an update check, written to Cloudflare KV by the
 * issuance Worker (paid path) or `scripts/sign-license.ts` via `kv-store.ts`
 * (out-of-band path). Canonical shape shared by the REST writer; the
 * update Worker (`infra/license-update-worker/`) keeps a structurally-identical
 * local copy (separate Cloudflare build) kept in lockstep by a parity test.
 * `updateWindowEnd: null` ⇒ never expires — every issued key, paid or
 * grandfathered, since every key includes all future updates (ADR-040,
 * 2026-10-09). A date appears only on a key hand-signed with `--expires`.
 */
export interface LicenseEntitlement {
  updateWindowEnd: string | null;
  status: LicenseMetadata["type"]; // "personal" | "commercial" | "grandfathered"
  version: string; // license schema version
}
