/**
 * Shared wire contract for the integration setup wizard (#477 PR 3c-i).
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
/** Server registers as `:ref`; clients fill in the ref. */
export function apiIntegrationsSecretPath(ref: string): string {
  return `/api/integrations/secrets/${encodeURIComponent(ref)}`;
}

// --- Schema version ----------------------------------------------------------

export const INTEGRATIONS_SCHEMA_VERSION = 2 as const;

// --- Integration kinds (mirrors src/server/integrations/schema.ts v2 union) --

export interface ClaudeCodeIntegration {
  kind: "claude-code";
  id: string;
  label: string;
  configPath: string;
  transport: "http";
  url: string;
  tokenSecretRef?: string;
}

export interface ClaudeDesktopIntegration {
  kind: "claude-desktop";
  id: string;
  label: string;
  configPath: string;
  transport: "stdio";
  nodeBinary?: string;
  tokenSecretRef?: string;
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

export interface ExistingMcpInstall {
  target: DetectedTarget;
  status: ExistingConfigReadStatus;
  tandemEntry?: McpEntry;
  channelEntry?: McpEntry;
  errorMessage?: string;
}

// --- HTTP error codes the server can return on integrations routes ----------

/** Returned in JSON body when the wizard should surface env-var fallback UX. */
export const ERROR_CODE_KEYCHAIN_UNAVAILABLE = "KEYCHAIN_UNAVAILABLE";
/** Returned when POST /api/integrations payload fails Zod validation. */
export const ERROR_CODE_INVALID_INTEGRATIONS_FILE = "INVALID_INTEGRATIONS_FILE";
/** Returned when POST /api/integrations/secrets/:ref payload is malformed. */
export const ERROR_CODE_INVALID_SECRET = "INVALID_SECRET";
