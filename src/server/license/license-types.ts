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

/** On-device license state, computed fresh on every read (no cache). */
export type LicenseStatus = "trial" | "licensed" | "restricted";

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

export interface LicenseState {
  gateActive: boolean; // build-flag derived
  status: LicenseStatus;
  trial?: { firstRunAt: string; expiresAt: string; daysRemaining: number };
  license?: LicenseMetadata; // present when status === "licensed"
  updateWindowCurrent: boolean; // license && (expiresAt === null || expiresAt > now)
  licenseId?: string; // opaque UUID for the updater; never PII
}
