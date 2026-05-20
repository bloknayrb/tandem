import { DEFAULT_MCP_PORT } from "../../shared/constants.js";
import { apiModelsSecretPath } from "../../shared/integrations/contract.js";
import { createDefaultKeychainBackend } from "../keychain/keychain-backend.js";
import {
  type ModelRegistryEntry,
  type TandemSettingsState,
  VALID_MODEL_PROVIDERS,
} from "./useTandemSettings.svelte.js";

/**
 * CRUD facade over `TandemSettings.models` + `defaultModelId` (#659).
 *
 * Plaintext keys travel through this facade as the `plaintextApiKey`
 * argument and are stored via the OS-keychain abstraction
 * (`createDefaultKeychainBackend`) — on Tauri desktop, direct to Rust;
 * on npm CLI install, loopback HTTP to the Node sidecar. Settings persist
 * only the opaque `apiKeyRef`; there is no client-side read path for
 * the plaintext.
 */
export interface ModelsState {
  readonly models: readonly ModelRegistryEntry[];
  readonly defaultModelId: string | null;
  addModel: (
    entry: Omit<ModelRegistryEntry, "id" | "apiKeyRef" | "_legacyApiKey">,
    plaintextApiKey?: string,
  ) => Promise<string>;
  updateModel: (
    id: string,
    patch: Partial<Omit<ModelRegistryEntry, "id" | "apiKeyRef" | "_legacyApiKey">>,
    plaintextApiKey?: string,
  ) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  toggleEnabled: (id: string) => void;
  setDefault: (id: string | null) => void;
  /**
   * Migrate any entry carrying a transient `_legacyApiKey` (set by
   * `parseModels` when loading a pre-v7 blob with plaintext keys) into a
   * fresh keychain entry. Returns counts; never throws.
   */
  migrateLegacyKeys: () => Promise<{ migrated: number; failed: number }>;
  readonly hasLegacyKeys: boolean;
}

// Vite dev server does not proxy `/api/*` so we hit the backend port directly.
// Matches the pattern in yjsSync / useIntegrationWizard.
const keychain = createDefaultKeychainBackend({
  baseUrl: `http://127.0.0.1:${DEFAULT_MCP_PORT}`,
  pathFor: apiModelsSecretPath,
});

/** Opaque 128-bit URL-safe ref. Matches the server-side ref shape. */
function generateKeyRef(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateModelId(): string {
  return crypto.randomUUID();
}

/**
 * Runtime guard against caller bugs. The error message MUST NOT include
 * `apiKey` / `endpoint` values from the patch —
 * `tests/client/use-models-no-key-leak.test.ts` pins this invariant.
 */
function assertValidPatch(patch: { provider?: unknown }): void {
  if (patch.provider !== undefined && !VALID_MODEL_PROVIDERS.includes(patch.provider as never)) {
    throw new Error(`Invalid model provider: ${String(patch.provider)}`);
  }
}

/** Store a plaintext secret in the keychain. Throws on failure. */
async function storeSecret(ref: string, plaintext: string): Promise<void> {
  const result = await keychain.set(ref, plaintext);
  if (result.status === "ok") return;
  // Hygiene: the result never carries the plaintext, but we double-defend
  // by surfacing only the status code in the thrown error.
  const code = result.status === "unavailable" ? "KEYCHAIN_UNAVAILABLE" : "STORE_FAILED";
  throw new Error(`Failed to store model key (${code})`);
}

export function createModels(settingsState: TandemSettingsState): ModelsState {
  return {
    get models() {
      return settingsState.settings.models;
    },
    get defaultModelId() {
      return settingsState.settings.defaultModelId;
    },
    get hasLegacyKeys() {
      return settingsState.settings.models.some((m) => typeof m._legacyApiKey === "string");
    },
    async addModel(entry, plaintextApiKey) {
      assertValidPatch(entry);
      const id = generateModelId();
      let apiKeyRef: string | undefined;
      if (plaintextApiKey && plaintextApiKey.length > 0) {
        apiKeyRef = generateKeyRef();
        await storeSecret(apiKeyRef, plaintextApiKey);
      }
      const next: ModelRegistryEntry = { ...entry, id, ...(apiKeyRef ? { apiKeyRef } : {}) };
      settingsState.updateSettings({
        models: [...settingsState.settings.models, next],
      });
      return id;
    },
    async updateModel(id, patch, plaintextApiKey) {
      assertValidPatch(patch);
      const existing = settingsState.settings.models.find((m) => m.id === id);
      if (!existing) return;
      let newRef: string | undefined;
      if (plaintextApiKey !== undefined && plaintextApiKey.length > 0) {
        newRef = generateKeyRef();
        // Store the new secret and delete the old in parallel — `keychain.delete`
        // is best-effort and never throws, so it can't fail the store.
        await Promise.all([
          storeSecret(newRef, plaintextApiKey),
          existing.apiKeyRef ? keychain.delete(existing.apiKeyRef) : Promise.resolve(),
        ]);
      }
      settingsState.updateSettings({
        models: settingsState.settings.models.map((m) =>
          m.id === id ? { ...m, ...patch, ...(newRef ? { apiKeyRef: newRef } : {}) } : m,
        ),
      });
    },
    async deleteModel(id) {
      const entry = settingsState.settings.models.find((m) => m.id === id);
      if (entry?.apiKeyRef) await keychain.delete(entry.apiKeyRef);
      settingsState.updateSettings({
        models: settingsState.settings.models.filter((m) => m.id !== id),
        defaultModelId:
          settingsState.settings.defaultModelId === id
            ? null
            : settingsState.settings.defaultModelId,
      });
    },
    toggleEnabled(id) {
      settingsState.updateSettings({
        models: settingsState.settings.models.map((m) =>
          m.id === id ? { ...m, enabled: !m.enabled } : m,
        ),
      });
    },
    setDefault(id) {
      settingsState.updateSettings({ defaultModelId: id });
    },
    async migrateLegacyKeys() {
      const entries = settingsState.settings.models;
      const legacyIndices = entries
        .map((entry, i) => (typeof entry._legacyApiKey === "string" ? i : -1))
        .filter((i) => i >= 0);
      if (legacyIndices.length === 0) return { migrated: 0, failed: 0 };

      // Run stores in parallel; allSettled keeps one failure from poisoning
      // the batch. Each result maps 1:1 back to its legacy entry by index.
      const refs = legacyIndices.map(() => generateKeyRef());
      const results = await Promise.allSettled(
        legacyIndices.map((i, k) => storeSecret(refs[k], entries[i]._legacyApiKey as string)),
      );

      const nextModels = entries.slice();
      let migrated = 0;
      let failed = 0;
      results.forEach((result, k) => {
        const i = legacyIndices[k];
        if (result.status === "fulfilled") {
          const next = { ...entries[i], apiKeyRef: refs[k] };
          delete next._legacyApiKey;
          nextModels[i] = next;
          migrated++;
        } else {
          failed++;
        }
      });

      if (migrated > 0) {
        settingsState.updateSettings({ models: nextModels });
      }
      return { migrated, failed };
    },
  };
}
