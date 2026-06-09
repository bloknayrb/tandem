/**
 * Shared wire contract for the integration setup wizard.
 *
 * Both the client (wizard UI) and the server (`src/server/integrations/`)
 * import from here so:
 *   - The Zod schema on the server (`schema.ts`) and the plain TS types on
 *     the client agree on the wire format.
 *   - API path strings live in one place — rename hits one file.
 *
 * The server's Zod schema is the runtime source of truth; this module
 * contains the type witnesses + constants. A compile-time test in
 * `tests/server/integrations/contract.test.ts` (added in the same PR)
 * asserts that `z.infer<typeof IntegrationsFileSchema>` is assignable to
 * `IntegrationsFile` here, so the two stay in sync.
 */

// --- API paths ---------------------------------------------------------------

export const API_INTEGRATIONS_EXISTING = "/api/integrations/existing";
export const API_INTEGRATIONS = "/api/integrations";
export const API_INTEGRATIONS_APPLY = "/api/integrations/apply";
export const API_INTEGRATIONS_FIRST_RUN = "/api/integrations/first-run-needed";
/** Server registers as `:ref`; clients fill in the ref. */
export function apiIntegrationsSecretPath(ref: string): string {
  return `/api/integrations/secrets/${encodeURIComponent(ref)}`;
}

/** Models registry's keychain secrets path (#659). Separate route, separate
 * keychain service (`tandem-models`), so outbound third-party API keys
 * don't share a namespace with inbound MCP-client tokens. */
export function apiModelsSecretPath(ref: string): string {
  return `/api/models/secrets/${encodeURIComponent(ref)}`;
}

// --- Schema version ----------------------------------------------------------

export const INTEGRATIONS_SCHEMA_VERSION = 3 as const;

// --- Integration kinds (mirrors src/server/integrations/schema.ts v3 union) --

/**
 * Per-integration apply intent (added in v3). Controls whether
 * `POST /api/integrations/apply` writes this entry to Claude's config:
 *   - `"create"` (default for claude-code/desktop): write the entry.
 *   - `"update"`: same as create, but the wizard surfaced a diff against
 *     an existing entry that the user confirmed.
 *   - `"skip"`: persist Tandem's knowledge of the integration but don't
 *     write/overwrite Claude's config (preserves user-edited entries the
 *     wizard couldn't validate, or `other-mcp` entries Tandem can't apply).
 *
 * `other-mcp` integrations are constrained to `"skip"` by the schema —
 * Tandem doesn't know how to write arbitrary third-party MCP configs.
 */
export type ApplyIntent = "create" | "update" | "skip";

export interface ClaudeCodeIntegration {
  kind: "claude-code";
  id: string;
  label: string;
  configPath: string;
  transport: "http";
  url: string;
  tokenSecretRef?: string;
  apply?: ApplyIntent;
  /**
   * Optional cwd for the auto-spawned Claude child (PR #477 PR-4 auto-launcher).
   * Default: user's home directory. Per-integration so users with multiple
   * Claude installations (e.g., one for work, one for personal) can pin each
   * to a different project root. Absolute paths only.
   */
  workingDirectory?: string;
}

export interface ClaudeDesktopIntegration {
  kind: "claude-desktop";
  id: string;
  label: string;
  configPath: string;
  transport: "stdio";
  nodeBinary?: string;
  tokenSecretRef?: string;
  apply?: ApplyIntent;
}

export interface OtherMcpIntegration {
  kind: "other-mcp";
  id: string;
  label: string;
  transport: "http" | "stdio";
  /** Required when `transport === "http"`. */
  url?: string;
  configPath?: string;
  tokenSecretRef?: string;
  /** Constrained to `"skip"` — Tandem cannot apply arbitrary MCP configs. */
  apply?: "skip";
}

export type IntegrationConfig =
  | ClaudeCodeIntegration
  | ClaudeDesktopIntegration
  | OtherMcpIntegration;

export interface IntegrationsFile {
  schemaVersion: typeof INTEGRATIONS_SCHEMA_VERSION;
  integrations: IntegrationConfig[];
  defaultIntegrationId?: string;
}

// --- Existing-entries reader (mirrors src/server/integrations/existing-config.ts) ---

export type ExistingConfigReadStatus = "ok" | "missing" | "malformed" | "error";

export interface DetectedTarget {
  label: string;
  configPath: string;
  kind: "claude-code" | "claude-desktop";
}

/**
 * The MCP entry shape Tandem's auto-config writes today. PR 3a's
 * `existing-config.ts` reads but does not validate field types; consumers
 * MUST treat fields as unknown until they re-validate.
 */
export interface McpEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Per-entry validation outcome. The wizard pre-sets `apply: "skip"` for
 * non-`"valid"` entries so unrecognized commands / non-loopback URLs are
 * never silently re-written by Tandem.
 */
export type EntryValidationStatus =
  | "valid"
  | "invalid-shape"
  | "invalid-url"
  | "invalid-command"
  | "invalid-args";

export interface EntryValidation {
  status: EntryValidationStatus;
  reason?: string;
}

export interface ExistingMcpInstall {
  target: DetectedTarget;
  status: ExistingConfigReadStatus;
  tandemEntry?: McpEntry;
  tandemValidation?: EntryValidation;
  channelEntry?: McpEntry;
  channelValidation?: EntryValidation;
  errorMessage?: string;
}

// --- HTTP error codes the server can return on integrations routes ----------

/** Returned in JSON body when the wizard should surface env-var fallback UX. */
export const ERROR_CODE_KEYCHAIN_UNAVAILABLE = "KEYCHAIN_UNAVAILABLE";
/** Returned when POST /api/integrations payload fails Zod validation. */
export const ERROR_CODE_INVALID_INTEGRATIONS_FILE = "INVALID_INTEGRATIONS_FILE";
/** Returned when POST /api/integrations/secrets/:ref payload is malformed. */
export const ERROR_CODE_INVALID_SECRET = "INVALID_SECRET";
/** Returned by POST /api/integrations/apply when the request body fails validation. */
export const ERROR_CODE_INVALID_APPLY_REQUEST = "INVALID_APPLY_REQUEST";
/** Returned by POST /api/integrations/apply when the persisted file is malformed. */
export const ERROR_CODE_INVALID_PERSISTED_FILE = "INVALID_PERSISTED_FILE";
/** Returned by POST /api/integrations/apply when the confirmation nonce doesn't match. */
export const ERROR_CODE_INVALID_NONCE = "INVALID_NONCE";
/** Returned by POST /api/integrations/apply when Origin header isn't allowlisted. */
export const ERROR_CODE_BAD_ORIGIN = "BAD_ORIGIN";
/** Returned by POST /api/integrations/apply when a concurrent apply is in flight. */
export const ERROR_CODE_APPLY_IN_PROGRESS = "APPLY_IN_PROGRESS";

// --- Apply endpoint response types ------------------------------------------

/** Per-integration outcome from POST /api/integrations/apply. */
export type ApplyItemStatus = "applied" | "skipped" | "error";

export const ERROR_CODE_TARGET_NOT_DETECTED = "TARGET_NOT_DETECTED";
export const ERROR_CODE_SECRET_MISSING = "SECRET_MISSING";
export const ERROR_CODE_OTHER_MCP_NOT_APPLICABLE = "OTHER_MCP_NOT_APPLICABLE";
export const ERROR_CODE_PATH_REJECTED = "PATH_REJECTED";
export const ERROR_CODE_WRITE_FAILED = "WRITE_FAILED";

/** Specific failure codes the wizard can branch on. */
export type ApplyItemErrorCode =
  | typeof ERROR_CODE_TARGET_NOT_DETECTED
  | typeof ERROR_CODE_SECRET_MISSING
  | typeof ERROR_CODE_OTHER_MCP_NOT_APPLICABLE
  | typeof ERROR_CODE_PATH_REJECTED
  | typeof ERROR_CODE_WRITE_FAILED;

export interface ApplyItemResult {
  id: string;
  status: ApplyItemStatus;
  /** Present when status === "error". */
  code?: ApplyItemErrorCode;
  /** Human-readable detail. Never includes tokens or full file contents. */
  message?: string;
}

export interface ApplyResponse {
  /** Per-integration outcome, in the order they appeared in the request `ids`. */
  results: ApplyItemResult[];
  /** Fresh nonce for the next apply (rotates on every successful call). */
  nextNonce: string;
}

export interface FirstRunNeededResponse {
  /** True iff `integrations.json` is empty AND no existing Tandem MCP entry is detected. */
  needed: boolean;
  /** Server `package.json` version — clients key dismissals on this. */
  serverVersion: string;
  /** Required in the body of POST /api/integrations/apply (CSRF mitigation). */
  confirmationNonce: string;
}

// --- Claude CLI install (one-click "Install Claude Code" from the wizard) ----

/** Read-only probe of whether the `claude` CLI binary is present. */
export const API_INTEGRATIONS_CLAUDE_CLI_STATUS = "/api/integrations/claude-cli-status";
/** Mutating: download + execute the official native installer. */
export const API_INTEGRATIONS_INSTALL_CLAUDE_CODE = "/api/integrations/install-claude-code";

/** Returned by POST /api/integrations/install-claude-code while another install is mid-flight. */
export const ERROR_CODE_INSTALL_IN_PROGRESS = "INSTALL_IN_PROGRESS";
/** Returned when the installer exits non-zero or throws. Carries exitCode + stderrTail. */
export const ERROR_CODE_INSTALL_FAILED = "INSTALL_FAILED";
/** Returned when the host OS isn't one the native installer supports. */
export const ERROR_CODE_UNSUPPORTED_PLATFORM = "UNSUPPORTED_PLATFORM";

/**
 * Where the `claude` CLI binary is — independent of any config file.
 *   - `NOT_INSTALLED`: not on PATH and not in the native install location.
 *   - `INSTALLED_ON_PATH`: found on the server process's PATH (ready to use).
 *   - `INSTALLED_NOT_ON_PATH`: present in `~/.local/bin` but not yet on PATH
 *     (the usual immediately-post-install state — user must open a new shell).
 */
export type ClaudeCliPresence = "NOT_INSTALLED" | "INSTALLED_ON_PATH" | "INSTALLED_NOT_ON_PATH";

/**
 * GET /api/integrations/claude-cli-status response.
 *
 * **Enum only — never the resolved binary path or PATH contents.** This route
 * is read-only and LAN-reachable under `TANDEM_ALLOW_UNAUTHENTICATED_LAN`; a
 * path would leak the home-directory layout / username to the network. The
 * type carries no path field by design (F6).
 */
export interface ClaudeCliStatusResponse {
  presence: ClaudeCliPresence;
}

/** POST /api/integrations/install-claude-code success response. */
export interface InstallClaudeCodeResponse {
  ok: true;
  /** Presence re-probed after the installer exits — usually `INSTALLED_NOT_ON_PATH`. */
  presence: ClaudeCliPresence;
}
