import { describe, expect, it } from "vitest";

import { migrateUp } from "../../../src/server/integrations/migrations.js";
import { INTEGRATIONS_SCHEMA_VERSION } from "../../../src/server/integrations/schema.js";

describe("migrateUp", () => {
  it("is a no-op when fromVersion === toVersion", () => {
    const input = { schemaVersion: 1, integrations: [] };
    expect(migrateUp(input, 1, 1)).toBe(input);
  });

  it("throws when toVersion < fromVersion", () => {
    expect(() => migrateUp({}, 2, 1)).toThrow(/Cannot migrate down/);
  });

  it("throws when no migration is registered for a step beyond the current chain", () => {
    expect(() =>
      migrateUp({}, INTEGRATIONS_SCHEMA_VERSION, INTEGRATIONS_SCHEMA_VERSION + 1),
    ).toThrow(/No migration registered/);
  });

  describe("v1 → v2", () => {
    it("bumps schemaVersion and preserves an empty integrations array", () => {
      const v1 = { schemaVersion: 1, integrations: [] };
      expect(migrateUp(v1, 1, 2)).toEqual({ schemaVersion: 2, integrations: [] });
    });

    it("preserves a claude-code integration record verbatim", () => {
      const v1 = {
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
      };
      expect(migrateUp(v1, 1, 2)).toEqual({
        schemaVersion: 2,
        integrations: v1.integrations,
      });
    });

    it("preserves defaultIntegrationId when present", () => {
      const v1 = {
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
        defaultIntegrationId: "cc-1",
      };
      const v2 = migrateUp(v1, 1, 2) as { defaultIntegrationId?: string };
      expect(v2.defaultIntegrationId).toBe("cc-1");
    });

    it("omits defaultIntegrationId when absent (does not stamp undefined)", () => {
      const v1 = { schemaVersion: 1, integrations: [] };
      const v2 = migrateUp(v1, 1, 2) as Record<string, unknown>;
      expect("defaultIntegrationId" in v2).toBe(false);
    });

    it("rejects a v1 file with a malformed integration record", () => {
      // claude-desktop requires `transport: "stdio"` — `"http"` should fail.
      const v1 = {
        schemaVersion: 1,
        integrations: [
          {
            kind: "claude-desktop",
            id: "cd-1",
            label: "Claude Desktop",
            configPath: "/home/user/Library/Application Support/Claude/claude_desktop_config.json",
            transport: "http",
          },
        ],
      };
      expect(() => migrateUp(v1, 1, 2)).toThrow();
    });

    it("rejects a hand-edited file claiming v1 but containing a v2-only kind", () => {
      const bogus = {
        schemaVersion: 1,
        integrations: [{ kind: "other-mcp", id: "x", label: "X", transport: "http" }],
      };
      expect(() => migrateUp(bogus, 1, 2)).toThrow();
    });
  });
});
