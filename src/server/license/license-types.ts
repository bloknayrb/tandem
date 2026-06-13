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
