import { API_LICENSE_ACTIVATE, API_LICENSE_STATUS } from "../../shared/api-paths";
import { API_BASE } from "../utils/fileUpload";
import type { LicenseStatusResponse } from "../utils/license-ui";

/**
 * Pure license HTTP helpers (no runes) — testable in a Node environment.
 * The `.svelte.ts` store polls `fetchLicenseStatus`; the activation surfaces
 * call `activateLicenseClient`.
 */

/** Fetch `GET /api/license/status`. Throws on network error or non-ok status. */
export async function fetchLicenseStatus(signal?: AbortSignal): Promise<LicenseStatusResponse> {
  const resp = await fetch(`${API_BASE}${API_LICENSE_STATUS}`, { signal });
  if (!resp.ok) {
    throw new Error(`${API_LICENSE_STATUS} responded ${resp.status} ${resp.statusText}`);
  }
  return (await resp.json()) as LicenseStatusResponse;
}

export type ActivateResult =
  | { ok: true; state: LicenseStatusResponse }
  | { ok: false; error: string };

/**
 * POST a signed license blob to `/api/license/activate`. Returns the new state
 * on success or a user-facing message on failure (the server never echoes the
 * blob bytes). Never throws — a transport failure becomes `{ ok: false }`.
 */
export async function activateLicenseClient(license: string): Promise<ActivateResult> {
  try {
    const resp = await fetch(`${API_BASE}${API_LICENSE_ACTIVATE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license }),
    });
    const json = (await resp.json().catch(() => ({}))) as Partial<LicenseStatusResponse> & {
      message?: string;
    };
    if (!resp.ok) {
      return { ok: false, error: json.message ?? "Activation failed." };
    }
    return { ok: true, state: json as LicenseStatusResponse };
  } catch {
    return { ok: false, error: "Server unavailable." };
  }
}
