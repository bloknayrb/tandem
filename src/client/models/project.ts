/**
 * Project the client's in-memory registry to the server wire shape (#1123 M2).
 *
 * The client `ModelRegistryEntry` carries a transient `_legacyApiKey` (plaintext,
 * set by `parseModels` for the one-shot keychain migration) and could in theory
 * carry a stray `apiKey`. The server schema is `.strict()` and rejects both, so
 * every write-through and the localStorage→server reconcile funnels through this
 * ONE explicit field-copy projector. Adding a field to the wire contract is a
 * deliberate edit here — nothing crosses by default.
 *
 * Shared by the store write-through (`useModels.svelte.ts`) and the reconcile
 * action (`actions/reconcile-models-registry.ts`); lives in a plain `.ts` module so
 * both a `.svelte.ts` and a `.ts` importer stay free of a Svelte-compilation edge.
 */
import {
  MODELS_SCHEMA_VERSION,
  type ModelsEntry,
  type ModelsFile,
} from "../../shared/models/contract.js";
import type { ModelRegistryEntry } from "../hooks/useTandemSettings.js";

/** Explicit field copy — drops `_legacyApiKey` and any stray key. */
export function projectEntry(entry: ModelRegistryEntry): ModelsEntry {
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

/** Project a whole registry to the persisted `ModelsFile` contract. */
export function projectModelsFile(
  models: readonly ModelRegistryEntry[],
  defaultModelId: string | null,
): ModelsFile {
  return {
    schemaVersion: MODELS_SCHEMA_VERSION,
    models: models.map(projectEntry),
    defaultModelId,
  };
}
