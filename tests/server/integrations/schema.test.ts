import { describe, expect, it } from "vitest";

import {
  emptyIntegrationsFile,
  INTEGRATIONS_SCHEMA_VERSION,
  IntegrationConfigSchema,
  IntegrationsFileSchema,
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
      schemaVersion: 2,
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
