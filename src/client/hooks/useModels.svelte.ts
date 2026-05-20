import { DEFAULT_MCP_PORT } from "../../shared/constants.js";
import type { ModelRegistryEntry, TandemSettingsState } from "./useTandemSettings.svelte.js";

/**
 * Thin CRUD facade over `TandemSettings.models` + `TandemSettings.defaultModelId`
 * (#659).
 *
 * Every mutation routes through `settingsState.updateSettings(...)` so:
 *   - Svelte 5 `$state` notices the change (identity-based; an in-place
 *     `models.push(...)` would not trigger reactivity).
 *   - `mergeAndClampSettings`'s shape filter re-runs.
 *   - The localStorage write goes through the read-only short-circuit
 *     in `createTandemSettings`, so a downgraded client cannot clobber a
 *     newer client's data.
 *
 * **Secrets** for cloud providers travel through this facade as the
 * plaintext `apiKey` parameter to `addModel` / `updateModel`. The facade
 * POSTs the plaintext to `POST /api/models/secrets/:ref` (server stores it
 * in the OS keychain under service `tandem-models`) and persists only the
 * opaque `apiKeyRef` in localStorage. There is no GET counterpart — the
 * plaintext is never readable from the client after persistence.
 *
 * The base URL for the secrets API is loopback only (matches the rest of
 * the client's `fetch` pattern: yjsSync, useNotifications, etc.).
 */
export interface ModelsState {
  readonly models: readonly ModelRegistryEntry[];
  readonly defaultModelId: string | null;
  /**
   * Add a model. When `plaintextApiKey` is provided, the facade stores it
   * in the OS keychain and persists the resulting ref. Returns the new
   * entry's id, or rejects with a typed error if the secret could not be
   * stored (keychain unavailable, etc.).
   */
  addModel: (
    entry: Omit<ModelRegistryEntry, "id" | "apiKeyRef" | "_legacyApiKey">,
    plaintextApiKey?: string,
  ) => Promise<string>;
  /**
   * Update a model. When `plaintextApiKey` is provided, the old ref is
   * deleted server-side, a fresh ref is generated, and the new secret is
   * stored under it. Pass `undefined` (or omit) to leave the existing ref
   * in place.
   */
  updateModel: (
    id: string,
    patch: Partial<Omit<ModelRegistryEntry, "id" | "apiKeyRef" | "_legacyApiKey">>,
    plaintextApiKey?: string,
  ) => Promise<void>;
  /** Delete a model and any associated keychain secret. */
  deleteModel: (id: string) => Promise<void>;
  toggleEnabled: (id: string) => void;
  /** Set the default model. Pass `null` to clear. */
  setDefault: (id: string | null) => void;
  /**
   * One-shot migration helper: for any entry carrying a transient
   * `_legacyApiKey` (set by `parseModels` when loading a pre-v7 blob with
   * plaintext keys), POST the plaintext to the keychain and rewrite the
   * entry with a fresh `apiKeyRef`. No-op when no legacy entries remain.
   * Returns the number of entries successfully migrated.
   */
  migrateLegacyKeys: () => Promise<{ migrated: number; failed: number }>;
  /** True when at least one entry still carries a transient `_legacyApiKey`. */
  readonly hasLegacyKeys: boolean;
}

const SECRETS_BASE = `http://127.0.0.1:${DEFAULT_MCP_PORT}/api/models/secrets`;

/**
 * Generate a fresh, opaque, URL-safe ref (16 bytes = 128 bits of entropy,
 * matching the server-side `generateSecretRef`). The ref is client-chosen
 * but server-validated against `REF_CHAR_CLASS` before storage.
 */
function generateKeyRef(): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return base64UrlEncode(bytes);
  }
  // Fallback for legacy environments — non-cryptographic, never used as a
  // security primitive; only collisions matter and the namespace is per
  // user.
  let s = "";
  for (let i = 0; i < 22; i++) {
    s += "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"[
      Math.floor(Math.random() * 64)
    ];
  }
  return s;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateModelId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Throws when a partial patch carries an invalid `provider`. Strip happens
 * defensively at `mergeAndClampSettings`; inside the facade an invalid
 * patch is a programming bug. The error message MUST NOT include
 * `apiKey` / `endpoint` values from the patch — `tests/client/use-models-no-key-leak.test.ts`
 * pins this invariant.
 */
function assertValidPatch(patch: { provider?: unknown }): void {
  if (patch.provider !== undefined) {
    const valid = ["anthropic", "openai", "gemini", "local-ollama", "local-llamacpp"];
    if (typeof patch.provider !== "string" || !valid.includes(patch.provider)) {
      throw new Error(`Invalid model provider: ${String(patch.provider)}`);
    }
  }
}

/** Store a plaintext secret in the keychain under `ref`. Throws on failure. */
async function storeSecret(ref: string, plaintext: string): Promise<void> {
  const res = await fetch(`${SECRETS_BASE}/${encodeURIComponent(ref)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: plaintext }),
  });
  if (!res.ok) {
    // Hygiene: never include the plaintext in the thrown error.
    const code = res.status === 503 ? "KEYCHAIN_UNAVAILABLE" : `HTTP_${res.status}`;
    throw new Error(`Failed to store model key (${code})`);
  }
}

/** Best-effort secret deletion. Never throws — a missing ref is harmless. */
async function deleteSecret(ref: string): Promise<void> {
  try {
    await fetch(`${SECRETS_BASE}/${encodeURIComponent(ref)}`, { method: "DELETE" });
  } catch {
    // Network error — the entry is gone from settings either way; the
    // orphan keychain entry will be garbage-collected on next migration.
  }
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
        await storeSecret(newRef, plaintextApiKey);
        // Replace the old ref. Delete is best-effort — we proceed regardless
        // so the user isn't blocked by a stale keychain entry.
        if (existing.apiKeyRef) await deleteSecret(existing.apiKeyRef);
      }
      settingsState.updateSettings({
        models: settingsState.settings.models.map((m) =>
          m.id === id ? { ...m, ...patch, ...(newRef ? { apiKeyRef: newRef } : {}) } : m,
        ),
      });
    },
    async deleteModel(id) {
      const entry = settingsState.settings.models.find((m) => m.id === id);
      if (entry?.apiKeyRef) await deleteSecret(entry.apiKeyRef);
      const filtered = settingsState.settings.models.filter((m) => m.id !== id);
      const nextDefault =
        settingsState.settings.defaultModelId === id ? null : settingsState.settings.defaultModelId;
      settingsState.updateSettings({
        models: filtered,
        defaultModelId: nextDefault,
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
      const legacy = entries.filter((m) => typeof m._legacyApiKey === "string");
      if (legacy.length === 0) return { migrated: 0, failed: 0 };
      let migrated = 0;
      let failed = 0;
      const nextById = new Map<string, ModelRegistryEntry>();
      for (const entry of entries) {
        if (typeof entry._legacyApiKey === "string") {
          const ref = generateKeyRef();
          try {
            await storeSecret(ref, entry._legacyApiKey);
            const { _legacyApiKey: _drop, ...rest } = entry;
            nextById.set(entry.id, { ...rest, apiKeyRef: ref });
            migrated++;
          } catch {
            failed++;
            // Keep the legacy field in memory so the user can retry. Note
            // `mergeAndClampSettings` will strip `_legacyApiKey` on persist —
            // so even after a failed migration, a subsequent settings write
            // (e.g. toggling another field) will drop the plaintext. The
            // user should retry before triggering any other settings write.
            nextById.set(entry.id, entry);
          }
        } else {
          nextById.set(entry.id, entry);
        }
      }
      if (migrated > 0) {
        settingsState.updateSettings({
          models: Array.from(nextById.values()),
        });
      }
      return { migrated, failed };
    },
  };
}
