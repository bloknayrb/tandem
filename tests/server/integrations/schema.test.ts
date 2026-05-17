import { describe, expect, it } from "vitest";

import {
  emptyIntegrationsFile,
  INTEGRATIONS_SCHEMA_VERSION,
  IntegrationConfigSchema,
  IntegrationsFileSchema,
  IntegrationsFileV1Schema,
} from "../../../src/server/integrations/schema.js";

describe("IntegrationConfigSchema", () => {
  it("accepts a valid claude-code integration", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "claude-code",
      id: "cc-1",
      label: "Claude Code",
      configPath: "/home/user/.claude.json",
      transport: "http",
      url: "http://127.0.0.1:3479",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid claude-desktop integration", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "claude-desktop",
      id: "cd-1",
      label: "Claude Desktop",
      configPath: "/Users/user/Library/Application Support/Claude/claude_desktop_config.json",
      transport: "stdio",
    });
    expect(result.success).toBe(true);
  });

  it("accepts claude-desktop with an optional nodeBinary", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "claude-desktop",
      id: "cd-1",
      label: "Claude Desktop",
      configPath: "/etc/claude/desktop.json",
      transport: "stdio",
      nodeBinary: "/usr/local/bin/node",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "lm-studio",
      id: "lm-1",
      label: "LM Studio",
    });
    expect(result.success).toBe(false);
  });

  it("accepts claude-code with an optional tokenSecretRef", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "claude-code",
      id: "cc-1",
      label: "Claude Code",
      configPath: "/home/user/.claude.json",
      transport: "http",
      url: "http://127.0.0.1:3479",
      tokenSecretRef: "abc123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts claude-desktop with an optional tokenSecretRef", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "claude-desktop",
      id: "cd-1",
      label: "Claude Desktop",
      configPath: "/etc/claude/desktop.json",
      transport: "stdio",
      tokenSecretRef: "xyz789",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty tokenSecretRef", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "claude-code",
      id: "cc-1",
      label: "Claude Code",
      configPath: "/home/user/.claude.json",
      transport: "http",
      url: "http://127.0.0.1:3479",
      tokenSecretRef: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an other-mcp http integration", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "other-mcp",
      id: "cursor-1",
      label: "Cursor",
      transport: "http",
      url: "http://127.0.0.1:3479",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an other-mcp stdio integration without url", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "other-mcp",
      id: "continue-1",
      label: "Continue.dev",
      transport: "stdio",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an other-mcp integration with all optional fields", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "other-mcp",
      id: "lm-studio-1",
      label: "LM Studio",
      transport: "http",
      url: "http://127.0.0.1:3479",
      configPath: "/home/user/.config/lm-studio/mcp.json",
      tokenSecretRef: "lm-token-ref",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an other-mcp with an unknown transport", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "other-mcp",
      id: "x",
      label: "X",
      transport: "websocket",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an other-mcp with transport http but no url", () => {
    // Cross-field invariant: http transport requires url. Without this
    // guard, downstream consumers would have to defend against a missing
    // url on an http-transport integration.
    const result = IntegrationConfigSchema.safeParse({
      kind: "other-mcp",
      id: "x",
      label: "X",
      transport: "http",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join(".") === "url")).toBe(true);
    }
  });

  it("rejects an other-mcp with a relative configPath", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "other-mcp",
      id: "x",
      label: "X",
      transport: "http",
      configPath: "./relative/mcp.json",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a relative configPath", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "claude-code",
      id: "cc-1",
      label: "Claude Code",
      configPath: "./relative/.claude.json",
      transport: "http",
      url: "http://127.0.0.1:3479",
    });
    expect(result.success).toBe(false);
  });

  it("rejects claude-code with wrong transport", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "claude-code",
      id: "cc-1",
      label: "Claude Code",
      configPath: "/home/user/.claude.json",
      transport: "stdio",
      url: "http://127.0.0.1:3479",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid URL", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "claude-code",
      id: "cc-1",
      label: "Claude Code",
      configPath: "/home/user/.claude.json",
      transport: "http",
      url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty id and label", () => {
    const result = IntegrationConfigSchema.safeParse({
      kind: "claude-code",
      id: "",
      label: "",
      configPath: "/home/user/.claude.json",
      transport: "http",
      url: "http://127.0.0.1:3479",
    });
    expect(result.success).toBe(false);
  });
});

describe("IntegrationsFileSchema", () => {
  it("accepts an empty integrations file", () => {
    const result = IntegrationsFileSchema.safeParse(emptyIntegrationsFile());
    expect(result.success).toBe(true);
  });

  it("accepts a populated integrations file", () => {
    const result = IntegrationsFileSchema.safeParse({
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
      integrations: [
        {
          kind: "claude-code",
          id: "cc-1",
          label: "Claude Code",
          configPath: "/home/user/.claude.json",
          transport: "http",
          url: "http://127.0.0.1:3479",
        },
      ],
      defaultIntegrationId: "cc-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a wrong schemaVersion", () => {
    const result = IntegrationsFileSchema.safeParse({
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION + 1,
      integrations: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty defaultIntegrationId", () => {
    const result = IntegrationsFileSchema.safeParse({
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
      integrations: [],
      defaultIntegrationId: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("emptyIntegrationsFile", () => {
  it("returns the canonical empty shape", () => {
    expect(emptyIntegrationsFile()).toEqual({
      schemaVersion: INTEGRATIONS_SCHEMA_VERSION,
      integrations: [],
    });
  });
});

describe("IntegrationsFileV1Schema", () => {
  it("accepts a valid v1 file (no tokenSecretRef, no other-mcp)", () => {
    const result = IntegrationsFileV1Schema.safeParse({
      schemaVersion: 1,
      integrations: [
        {
          kind: "claude-code",
          id: "cc-1",
          label: "Claude Code",
          configPath: "/home/user/.claude.json",
          transport: "http",
          url: "http://127.0.0.1:3479",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a v1 file with schemaVersion 2", () => {
    const result = IntegrationsFileV1Schema.safeParse({
      schemaVersion: 2,
      integrations: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a v1 file with an other-mcp kind", () => {
    const result = IntegrationsFileV1Schema.safeParse({
      schemaVersion: 1,
      integrations: [{ kind: "other-mcp", id: "x", label: "X", transport: "http" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a v1 record carrying a v2-only field (tokenSecretRef) via .strict()", () => {
    // A hand-edited v1 file that smuggled `tokenSecretRef` (v2-only) onto a
    // record must fail loudly rather than silently strip the field during
    // migration. The migration's "v1 records are valid v2 records"
    // invariant only holds if v1 strictly forbids v2-exclusive fields.
    const result = IntegrationsFileV1Schema.safeParse({
      schemaVersion: 1,
      integrations: [
        {
          kind: "claude-code",
          id: "cc-1",
          label: "Claude Code",
          configPath: "/home/user/.claude.json",
          transport: "http",
          url: "http://127.0.0.1:3479",
          tokenSecretRef: "smuggled-from-v2",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a v1 file with an extra top-level field via .strict()", () => {
    const result = IntegrationsFileV1Schema.safeParse({
      schemaVersion: 1,
      integrations: [],
      futureField: "v3-only",
    });
    expect(result.success).toBe(false);
  });
});
