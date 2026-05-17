import type { ModelRegistryEntry, TandemSettingsState } from "./useTandemSettings.svelte.js";

/**
 * Thin CRUD facade over `TandemSettings.models` (#659 Wave 2 PR 8a).
 *
 * Every mutation routes through `settingsState.updateSettings({ models: nextArray })`
 * so:
 *   - Svelte 5 `$state` notices the change (identity-based; an in-place
 *     `models.push(...)` would not trigger reactivity).
 *   - `mergeAndClampSettings`'s shape filter re-runs (defence-in-depth
 *     against a malformed partial update from this surface).
 *   - The localStorage write goes through the read-only short-circuit
 *     in `createTandemSettings`, so a downgraded client cannot clobber a
 *     newer client's data.
 *
 * Wave 6 (`IntegrationConfig`) does NOT replace this hook — `IntegrationConfig`
 * tracks MCP CLIENTS connecting INTO Tandem; the Models registry tracks
 * AI providers Tandem can call OUT to. They are orthogonal.
 */
export interface ModelsState {
  readonly models: readonly ModelRegistryEntry[];
  addModel: (entry: Omit<ModelRegistryEntry, "id">) => string;
  updateModel: (id: string, patch: Partial<Omit<ModelRegistryEntry, "id">>) => void;
  deleteModel: (id: string) => void;
  toggleEnabled: (id: string) => void;
}

/**
 * Generates a stable id for a new model entry. Prefers `crypto.randomUUID`
 * when available; falls back to a timestamp+random combination so we don't
 * crash on legacy environments. The fallback is collision-resistant enough
 * for at-most-50-entries-per-user scope but is not cryptographically
 * unique. We never use this id as a security primitive.
 */
function generateModelId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Throws when a partial patch carries a `provider` value that is not a
 * known `ModelProvider`. We strip rather than throw at the
 * `mergeAndClampSettings` boundary, but inside the CRUD facade an invalid
 * patch is a programming bug — surfacing it loudly catches the call site.
 *
 * **Error-message hygiene:** the error MUST NOT include `apiKey` /
 * `endpoint` values from the patch. `tests/client/use-models-no-key-leak.test.ts`
 * pins this invariant. Logging hygiene applies everywhere in this file.
 */
function assertValidPatch(patch: Partial<Omit<ModelRegistryEntry, "id">>): void {
  if (patch.provider !== undefined) {
    const valid = ["anthropic", "openai", "gemini", "local-ollama", "local-llamacpp"];
    if (!valid.includes(patch.provider)) {
      throw new Error(`Invalid model provider: ${String(patch.provider)}`);
    }
  }
}

export function createModels(settingsState: TandemSettingsState): ModelsState {
  return {
    get models() {
      return settingsState.settings.models;
    },
    addModel(entry) {
      assertValidPatch(entry);
      const id = generateModelId();
      const next: ModelRegistryEntry = { ...entry, id };
      settingsState.updateSettings({
        models: [...settingsState.settings.models, next],
      });
      return id;
    },
    updateModel(id, patch) {
      assertValidPatch(patch);
      settingsState.updateSettings({
        models: settingsState.settings.models.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      });
    },
    deleteModel(id) {
      settingsState.updateSettings({
        models: settingsState.settings.models.filter((m) => m.id !== id),
      });
    },
    toggleEnabled(id) {
      settingsState.updateSettings({
        models: settingsState.settings.models.map((m) =>
          m.id === id ? { ...m, enabled: !m.enabled } : m,
        ),
      });
    },
  };
}
