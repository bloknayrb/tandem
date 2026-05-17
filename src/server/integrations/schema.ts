/**
 * Tandem `IntegrationConfig` schema.
 *
 * Tandem's integration contract is MCP. Claude (Claude Code + Claude Desktop)
 * is the default integration. See
 * [ADR-038](../../../docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)
 * for the four-term glossary and the canonical policy statement.
 *
 * **Versions:**
 * - v1 (#477 PR 1): `claude-code` + `claude-desktop` kinds, no `tokenSecretRef`.
 * - v2 (#477 PR 3b): adds optional `tokenSecretRef` on every variant; adds
 *   `other-mcp` kind for generic MCP-capable clients (Cursor, Continue.dev,
 *   LM Studio, Ollama, etc.).
 *
 * `tokenSecretRef` is an opaque pointer into the OS keychain — never a
 * secret value. The keychain backend lives in `./keychain.ts`. Future
 * versions bump `INTEGRATIONS_SCHEMA_VERSION` and add a migration in
 * `./migrations.ts`.
 */

import path from "node:path";
import { z } from "zod";

const AbsolutePath = z.string().min(1).refine(path.isAbsolute, {
  message: "configPath must be an absolute path",
});

const ClaudeCodeIntegration = z.object({
  kind: z.literal("claude-code"),
  id: z.string().min(1),
  label: z.string().min(1),
  configPath: AbsolutePath,
  transport: z.literal("http"),
  url: z.string().url(),
  tokenSecretRef: z.string().min(1).optional(),
});

const ClaudeDesktopIntegration = z.object({
  kind: z.literal("claude-desktop"),
  id: z.string().min(1),
  label: z.string().min(1),
  configPath: AbsolutePath,
  transport: z.literal("stdio"),
  nodeBinary: z.string().min(1).optional(),
  tokenSecretRef: z.string().min(1).optional(),
});

/**
 * Generic MCP-capable client (Cursor, Continue.dev, LM Studio, Ollama, etc.).
 * Tandem doesn't auto-configure these — the user wires their client to
 * Tandem's MCP HTTP endpoint or stdio channel shim manually. The record
 * exists so the wizard can surface them in the integrations list and
 * associate an auth token with the client.
 *
 * `url` is the Tandem endpoint the client will connect to; defaults to
 * `http://127.0.0.1:3479` when omitted. `configPath` is optional because
 * many MCP clients have no canonical config file location Tandem can
 * detect.
 */
const OtherMcpIntegration = z.object({
  kind: z.literal("other-mcp"),
  id: z.string().min(1),
  label: z.string().min(1),
  transport: z.union([z.literal("http"), z.literal("stdio")]),
  url: z.string().url().optional(),
  configPath: AbsolutePath.optional(),
  tokenSecretRef: z.string().min(1).optional(),
});

export const IntegrationConfigSchema = z.discriminatedUnion("kind", [
  ClaudeCodeIntegration,
  ClaudeDesktopIntegration,
  OtherMcpIntegration,
]);

export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;

export const INTEGRATIONS_SCHEMA_VERSION = 2 as const;

export const IntegrationsFileSchema = z.object({
  schemaVersion: z.literal(INTEGRATIONS_SCHEMA_VERSION),
  integrations: z.array(IntegrationConfigSchema),
  defaultIntegrationId: z.string().min(1).optional(),
});

export type IntegrationsFile = z.infer<typeof IntegrationsFileSchema>;

export function emptyIntegrationsFile(): IntegrationsFile {
  return {
    schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
    integrations: [],
  };
}

/**
 * v1 input shape for the v1→v2 migration. Exported solely so `migrations.ts`
 * can validate untrusted on-disk v1 input. v1 differs from v2 only in:
 * - `INTEGRATIONS_SCHEMA_VERSION === 1`
 * - No `tokenSecretRef` on any kind (silently ignored if present)
 * - No `other-mcp` variant in the union
 *
 * The migration is a passthrough on the `integrations` array — all v1
 * records are valid v2 records — so the migration only rewrites
 * `schemaVersion`. We still validate the v1 shape strictly to catch
 * corruption that the v2 schema (which is laxer for `other-mcp`) would
 * accept.
 */
const ClaudeCodeIntegrationV1 = z.object({
  kind: z.literal("claude-code"),
  id: z.string().min(1),
  label: z.string().min(1),
  configPath: AbsolutePath,
  transport: z.literal("http"),
  url: z.string().url(),
});

const ClaudeDesktopIntegrationV1 = z.object({
  kind: z.literal("claude-desktop"),
  id: z.string().min(1),
  label: z.string().min(1),
  configPath: AbsolutePath,
  transport: z.literal("stdio"),
  nodeBinary: z.string().min(1).optional(),
});

export const IntegrationsFileV1Schema = z.object({
  schemaVersion: z.literal(1),
  integrations: z.array(
    z.discriminatedUnion("kind", [ClaudeCodeIntegrationV1, ClaudeDesktopIntegrationV1]),
  ),
  defaultIntegrationId: z.string().min(1).optional(),
});
