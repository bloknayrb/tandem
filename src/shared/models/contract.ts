/**
 * Shared wire contract for the server-relocated Models registry (#1123 M1a).
 *
 * Both the client (registry CRUD / one-time migration) and the server
 * (`src/server/models/`) import from here so the persisted shape, the API
 * path, and the provider enum live in one place. The server's Zod schema
 * (`src/server/models/schema.ts`) is the runtime source of truth; this module
 * holds the type witnesses + constants. A compile-time test
 * (`tests/shared/models-contract.test.ts`) asserts `z.infer<ModelsFileSchema>`
 * is assignable to `ModelsFile` here, mirroring the integrations-contract
 * precedent (`src/shared/integrations/contract.ts`).
 *
 * This is orthogonal to `IntegrationConfig`: the Models registry tracks AI
 * providers Tandem calls OUT to; `IntegrationConfig` tracks MCP clients that
 * connect IN. The two don't compete (see #659).
 */

// --- API path ----------------------------------------------------------------

/** Whole-file replace of the server-side models registry (#1123 M1a). */
export const API_MODELS = "/api/models";

// --- Schema version ----------------------------------------------------------

/** On-disk `models.json` schema version. Net-new at M1a; no migrations yet. */
export const MODELS_SCHEMA_VERSION = 1 as const;

// --- Provider kinds ----------------------------------------------------------

/**
 * Provider tag for registry entries (#659). Source of truth — the client
 * (`useTandemSettings.ts`) re-exports these so every existing import path
 * still resolves.
 */
export type ModelProvider = "anthropic" | "openai" | "gemini" | "local-ollama" | "local-llamacpp";

export const VALID_MODEL_PROVIDERS: readonly ModelProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "local-ollama",
  "local-llamacpp",
];

/**
 * Local providers drive an OpenAI-compatible loopback endpoint and carry no
 * key material. The local-model collaborator loop (#1123, ADR-039) only
 * resolves a config when the default entry is one of these; a cloud default
 * leaves the loop inert (cloud BYO keys are v1.1).
 */
export const LOCAL_MODEL_PROVIDERS: readonly ModelProvider[] = ["local-ollama", "local-llamacpp"];

export function isLocalProvider(provider: ModelProvider): boolean {
  return LOCAL_MODEL_PROVIDERS.includes(provider);
}

// --- Persisted shape ---------------------------------------------------------

/** Per-file cap so a corrupt or hand-edited registry can't run costs up. */
export const MODELS_ENTRY_MAX = 50;

/**
 * The persisted registry entry — the client `ModelRegistryEntry` minus the
 * transient `_legacyApiKey` (plaintext, never persisted) and any plaintext
 * `apiKey` (lives in the OS keychain, service `tandem-models`; only the opaque
 * `apiKeyRef` crosses the wire). The server schema is `.strict()`, so a stray
 * plaintext key on a request body is rejected, never silently stored.
 */
export interface ModelsEntry {
  /** Stable identifier (client `crypto.randomUUID()`). */
  id: string;
  provider: ModelProvider;
  displayName: string;
  modelId: string;
  /** Opaque keychain reference (base64url, ≤64). Cloud providers only. */
  apiKeyRef?: string;
  /** Loopback endpoint URL. Local providers only. Validated at resolve time. */
  endpoint?: string;
  enabled: boolean;
  params?: Record<string, number | string | boolean>;
}

export interface ModelsFile {
  schemaVersion: typeof MODELS_SCHEMA_VERSION;
  models: ModelsEntry[];
  /** Id of the default entry, or null. */
  defaultModelId: string | null;
}

// --- HTTP envelopes (#1123 M2) -----------------------------------------------

/**
 * `GET /api/models` response. `etag` is a content hash of the current registry
 * (see `getModelsEtag`); the client echoes it as `ifMatch` on the next write so
 * a stale write is rejected (409) rather than clobbering. For a non-loopback
 * (LAN) caller, `file`'s entries are allowlist-scrubbed — `endpoint`/`apiKeyRef`
 * (and any non-safe field) are omitted — so `file` is still a structurally
 * valid `ModelsFile` (those fields are optional), just less disclosed.
 */
export interface ModelsGetResponse {
  file: ModelsFile;
  etag: string;
}

/**
 * `POST /api/models` request body (#1123 M2). `ifMatch` is the ETag the client
 * last saw from `GET`; the server rejects the write (409) if it no longer
 * matches, so a stale writer reconciles instead of clobbering. `ifMatch` is a
 * sibling of `file` on the envelope — never a field on the persisted
 * `.strict()` `ModelsFile`.
 */
export interface ModelsPostBody {
  file: ModelsFile;
  ifMatch: string;
}

/** `POST /api/models` success response — the new ETag after the write. */
export interface ModelsPostResponse {
  etag: string;
}

// --- HTTP error codes --------------------------------------------------------

/** Returned when a POST /api/models body fails Zod validation. */
export const ERROR_CODE_INVALID_MODELS_FILE = "INVALID_MODELS_FILE";
/** Returned when persisting the models registry to disk fails. */
export const ERROR_CODE_MODELS_WRITE_FAILED = "MODELS_WRITE_FAILED";
/** 409 — the client's `ifMatch` ETag is stale; re-GET and reconcile. */
export const ERROR_CODE_MODELS_STALE = "MODELS_STALE";
/** 429 — a concurrent write is in flight; retry. */
export const ERROR_CODE_MODELS_BUSY = "MODELS_BUSY";
