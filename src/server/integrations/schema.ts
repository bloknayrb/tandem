/**
 * Tandem `IntegrationConfig` schema (#477 PR 1).
 *
 * Tandem's integration contract is MCP. Claude (Claude Code + Claude Desktop)
 * is the default integration. See
 * [ADR-038](../../../docs/decisions.md#adr-038-mcp-first-integration-policy-claude-as-default-integration)
 * for the four-term glossary and the canonical policy statement.
 *
 * PR 1 lands two integration kinds — `claude-code` and `claude-desktop`. LM
 * Studio, Ollama, and a generic `other-mcp` are deferred to PR 5+ and arrive
 * via the migration framework (`migrations.ts`). The schema version is bumped
 * each time the union grows so existing on-disk configs migrate explicitly.
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
});

const ClaudeDesktopIntegration = z.object({
  kind: z.literal("claude-desktop"),
  id: z.string().min(1),
  label: z.string().min(1),
  configPath: AbsolutePath,
  transport: z.literal("stdio"),
  nodeBinary: z.string().min(1).optional(),
});

export const IntegrationConfigSchema = z.discriminatedUnion("kind", [
  ClaudeCodeIntegration,
  ClaudeDesktopIntegration,
]);

export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;

export const INTEGRATIONS_SCHEMA_VERSION = 1 as const;

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
