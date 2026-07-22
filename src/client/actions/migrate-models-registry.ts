/**
 * One-time client→server migration of the Models registry (#1123 M1a).
 *
 * Historically the registry lived only in client localStorage (`tandem:settings`).
 * M1a makes the server authoritative so the local-model loop can resolve config
 * with no browser session. This seeds the server file once from whatever the
 * client already has, then records a flag so it never re-runs.
 *
 * Deliberately minimal (Option B): the full CRUD write-through rewire is M2.
 * This only *seeds*. Constraints baked in from the plan review:
 *  - `_readOnly`-gated (arch Finding 2): a downgraded client must never clobber
 *    a newer client's data — the same guard `updateSettings` enforces locally.
 *  - Once-per-session module guard + a persisted flag → idempotent; a failed
 *    POST leaves the flag unset so it retries next boot.
 *  - No `$state` writes and no component coupling → reactivity- and teardown-safe.
 *  - Drops `_legacyApiKey` (plaintext never crosses; the server schema is
 *    `.strict()` and would reject it anyway).
 */
import {
  API_MODELS,
  MODELS_SCHEMA_VERSION,
  type ModelsEntry,
  type ModelsFile,
} from "../../shared/models/contract.js";
import { loadSettings, type ModelRegistryEntry } from "../hooks/useTandemSettings.js";
import { API_BASE } from "../utils/fileUpload.js";

/** localStorage flag — separate key so it never touches the settings schema. */
export const MODELS_MIGRATED_FLAG_KEY = "tandem:models-migrated-to-server";

let hasRun = false;

function projectEntry(entry: ModelRegistryEntry): ModelsEntry {
  // Explicit field copy — drops the transient `_legacyApiKey` and any stray key.
  const out: ModelsEntry = {
    id: entry.id,
    provider: entry.provider,
    displayName: entry.displayName,
    modelId: entry.modelId,
    enabled: entry.enabled,
  };
  if (entry.apiKeyRef !== undefined) out.apiKeyRef = entry.apiKeyRef;
  if (entry.endpoint !== undefined) out.endpoint = entry.endpoint;
  if (entry.params !== undefined) out.params = entry.params;
  return out;
}

export async function migrateModelsRegistryOnce(): Promise<void> {
  if (hasRun) return;
  hasRun = true;
  try {
    if (localStorage.getItem(MODELS_MIGRATED_FLAG_KEY) === "1") return;
    const settings = loadSettings();
    // Never write on behalf of a downgraded client (see file header).
    if (settings._readOnly) return;
    const models = settings.models ?? [];
    if (models.length === 0) return; // nothing to seed

    const file: ModelsFile = {
      schemaVersion: MODELS_SCHEMA_VERSION,
      models: models.map(projectEntry),
      defaultModelId: settings.defaultModelId ?? null,
    };

    const res = await fetch(`${API_BASE}${API_MODELS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(file),
    });
    if (res.ok) {
      localStorage.setItem(MODELS_MIGRATED_FLAG_KEY, "1");
    }
  } catch {
    // Fire-and-forget: a failed migration leaves the flag unset → retried next
    // boot. localStorage unavailable (incognito) also lands here — harmless.
  }
}

/** Test seam — reset the once-per-session guard. */
export function _resetModelsMigrationGuardForTests(): void {
  hasRun = false;
}
