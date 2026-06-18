/**
 * Cloudflare KV entitlement writer (#1116, ADR-040 §7) — the bridge from the
 * issuance webhook to the L3 update Worker. After a real purchase the webhook
 * records `KV[licenseId] = { updateWindowEnd, status, version }`; the Worker
 * reads that key to decide whether to serve an update manifest.
 *
 * NON-FATAL by contract: the signed license blob is the source of truth and is
 * always delivered. A KV write failure only means the updater falls back to the
 * public endpoint — it never blocks or fails license delivery. This module
 * therefore never throws; it logs and returns `{ ok }`.
 */

/** What the Worker needs to gate an update check. `updateWindowEnd: null` ⇒ never expires (grandfathered). */
export interface LicenseEntitlement {
  updateWindowEnd: string | null;
  status: string; // license type: "personal" | "commercial" | "grandfathered"
  version: string; // license schema version
}

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
