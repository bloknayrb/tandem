/**
 * Cloudflare KV entitlement writer (#1116, ADR-040 §7) — the bridge to the L3
 * update Worker. `KV[licenseId] = { updateWindowEnd, status, version }`; the
 * Worker reads that key to decide whether to serve an update manifest.
 *
 * Two writers exist, and they are NOT interchangeable:
 *  - The **paid** path writes its own entitlement inside the Cloudflare issuance
 *    Worker (`infra/license-issuance-worker/`), using its native KV binding.
 *  - This module is the **out-of-band** path: `scripts/sign-license.ts`, which
 *    runs on the operator's machine and so must reach KV over the REST API.
 *
 * Never throws — it logs and returns `{ ok }` — but do NOT read that as
 * "failure is harmless". The caller must treat `!ok` as fatal: a license with
 * no entitlement is served `204` by the update Worker, which the desktop app
 * reports to the user as **"You're up to date."** forever. The public manifest
 * is not a fallback (`build_updater()` REPLACES the endpoint list), so a missed
 * write is a permanently and silently un-updatable install.
 */
import type { LicenseEntitlement } from "./license-types.js";

export interface KvConfig {
  accountId: string;
  namespaceId: string;
  apiToken: string;
}

/**
 * Read the Cloudflare KV config from env. Returns null when any var is unset —
 * in which case entitlement writes are skipped (a self-host without the update
 * endpoint, or local dev, runs fine; the updater just uses the public endpoint).
 */
export function readKvConfig(env: Record<string, string | undefined>): KvConfig | null {
  const accountId = env.TANDEM_CF_ACCOUNT_ID;
  const namespaceId = env.TANDEM_CF_KV_NAMESPACE_ID;
  const apiToken = env.TANDEM_CF_KV_API_TOKEN;
  if (!accountId || !namespaceId || !apiToken) return null;
  return { accountId, namespaceId, apiToken };
}

/** Build the Cloudflare KV REST PUT URL for a key. */
export function kvValueUrl(config: KvConfig, key: string): string {
  return (
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}` +
    `/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(key)}`
  );
}

/**
 * Persist a license entitlement to Cloudflare KV via the REST API. Never throws.
 * Skips (and says so) when KV isn't configured. The licenseId is the opaque KV
 * key (a UUID), so the value carries no PII and the key is unguessable.
 */
export async function writeLicenseEntitlement(
  licenseId: string,
  entry: LicenseEntitlement,
  deps: { config?: KvConfig | null; fetchFn?: typeof fetch } = {},
): Promise<{ ok: boolean; skipped?: boolean }> {
  const config = deps.config ?? readKvConfig(process.env);
  const fetchFn = deps.fetchFn ?? fetch;
  if (!config) {
    console.error(
      "[license] Cloudflare KV not configured (TANDEM_CF_* unset) — skipping entitlement write",
    );
    return { ok: false, skipped: true };
  }
  try {
    const resp = await fetchFn(kvValueUrl(config, licenseId), {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(entry),
    });
    if (!resp.ok) {
      // Log id only — never the email (§12 L1). The id is opaque.
      console.error(
        `[license] KV entitlement write failed (HTTP ${resp.status}) for license ${licenseId}`,
      );
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.error(
      `[license] KV entitlement write error for license ${licenseId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false };
  }
}
