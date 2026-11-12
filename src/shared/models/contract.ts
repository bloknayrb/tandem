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

/**
 * Whether local models may comment on and suggest changes to the document
 * (#1123, ADR-039's opt-in tier). Its own route and its own file
 * (`local-model-settings.json`), never a field of the registry: `POST
 * /api/models` replaces the whole registry from a client projection, so a
 * field there would be erased by any Models write.
 */
export const API_MODELS_LOCAL_SETTINGS = "/api/models/local-settings";

/** `GET /api/models/local-settings`. */
export interface LocalModelSettingsResponse {
  editing: boolean;
}

/**
 * `POST /api/models/local-settings` answer, on success (200) and on a failed
 * write (500) alike. `editing` is what the server is acting on now; `persisted`
 * says whether the disk agrees, i.e. whether it will still hold after a restart.
 */
export interface LocalModelSettingsPostResponse {
  editing: boolean;
  persisted: boolean;
  code?: string;
}

/**
 * Who answers chat: Claude, or the local model (#1123, ADR-039 amendment of
 * 2026-11-12). Its own route and its own file (`chat-answerer.json`). The
 * default is Claude, and saving or changing a model never changes it.
 */
export const API_MODELS_CHAT_ANSWERER = "/api/models/chat-answerer";

/** The switch's two positions. */
export type ChatAnswerer = "claude" | "local";

/** `GET /api/models/chat-answerer`. `localModelResolves` says only whether a
 *  local model would answer now — never which one, or where it points. */
export interface ChatAnswererResponse {
  answerer: ChatAnswerer;
  localModelResolves: boolean;
  /** This server process's run id, for judging a chat row's `localRun`
   *  (`shared/local-run.ts`). Authorises nothing. */
  runGeneration: string;
}

/** `POST /api/models/chat-answerer` answer, on success (200) and on a failed
 *  write (500) alike: `answerer` is what the server is acting on now. */
export interface ChatAnswererPostResponse {
  answerer: ChatAnswerer;
  persisted: boolean;
  code?: string;
}

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
  /**
   * Set by the one-time localStorage→server reconcile, and by nothing else. It
   * only tells the server not to raise the "a different model now answers"
   * info notice for this write (#2404); it grants nothing, and a write that is
   * not from Tandem's own window is announced whatever it says.
   */
  reconcile?: boolean;
}

/** `POST /api/models` success response — the new ETag after the write. */
export interface ModelsPostResponse {
  etag: string;
}

// --- HTTP error codes --------------------------------------------------------

/**
 * Returned (403) by `POST /api/models` and `POST /api/models/local-settings`
 * when the request does not come from Tandem's own window (#2404): the
 * browser-set `Origin` is not exactly one of Tandem's own page origins.
 */
export const ERROR_CODE_OWN_WINDOW_ONLY = "OWN_WINDOW_ONLY";
/** The plain reason that goes with {@link ERROR_CODE_OWN_WINDOW_ONLY}. */
export const OWN_WINDOW_ONLY_MESSAGE =
  "Local-model settings can only be changed in Tandem's own window.";
/** The environment variable that names the one extra origin a development or
 *  test setup may change these settings from. Read by the server at start. */
export const MODELS_DEV_ORIGIN_ENV = "TANDEM_MODELS_DEV_ORIGIN";

const LOOPBACK_DEV_ORIGIN = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;
/**
 * Is `origin` a loopback page origin the server accepts as the value of
 * {@link MODELS_DEV_ORIGIN_ENV}: `http://127.0.0.1:<port>`, an explicit port
 * from 1 to 65535 other than 80 (a browser never writes port 80)? ONE
 * definition, shared: the server validates the variable with it and the
 * client uses it to decide whether to suggest the variable at all, so the
 * client can never suggest a value the server would refuse.
 */
export function isLoopbackDevOrigin(origin: string): boolean {
  const match = LOOPBACK_DEV_ORIGIN.exec(origin);
  if (!match) return false;
  const port = Number(match[1]);
  return port <= 65535 && port !== 80;
}

/** Returned when a POST /api/models body fails Zod validation. */
export const ERROR_CODE_INVALID_MODELS_FILE = "INVALID_MODELS_FILE";
/** Returned when persisting the models registry to disk fails. */
export const ERROR_CODE_MODELS_WRITE_FAILED = "MODELS_WRITE_FAILED";
/** 409 — the client's `ifMatch` ETag is stale; re-GET and reconcile. */
export const ERROR_CODE_MODELS_STALE = "MODELS_STALE";
/** 429 — a concurrent write is in flight; retry. */
export const ERROR_CODE_MODELS_BUSY = "MODELS_BUSY";
/** 400 — a POST /api/models/local-settings body was not `{ editing: boolean }`. */
export const ERROR_CODE_INVALID_LOCAL_MODEL_SETTINGS = "INVALID_LOCAL_MODEL_SETTINGS";
/** 500 — the setting could not be saved; the answer still carries the effective value. */
export const ERROR_CODE_LOCAL_MODEL_SETTINGS_WRITE_FAILED = "LOCAL_MODEL_SETTINGS_WRITE_FAILED";
/** `POST /api/models/chat-answerer` body was not `{ answerer: "claude" | "local" }`. */
export const ERROR_CODE_INVALID_CHAT_ANSWERER = "INVALID_CHAT_ANSWERER";
/** `POST /api/models/chat-answerer`: the switch took effect but did not reach the disk. */
export const ERROR_CODE_CHAT_ANSWERER_WRITE_FAILED = "CHAT_ANSWERER_WRITE_FAILED";
