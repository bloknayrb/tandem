import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  detectCodexTargets,
  readExistingCodexEntry,
} from "../../../src/server/integrations/codex-config.js";

describe("Codex integration configuration", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-codex-config-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("detects an existing CODEX_HOME without executing Codex", () => {
    const codexHome = join(root, "custom-codex");
    mkdirSync(codexHome);
    expect(
      detectCodexTargets({
        homeOverride: root,
        codexHomeOverride: codexHome,
        pathOverride: join(root, "empty"),
      }),
    ).toEqual([{ kind: "codex", label: "Codex", configPath: join(codexHome, "config.toml") }]);
  });

  it("maps Codex's JSON MCP description to the redacted wizard shape", async () => {
    const target = {
      kind: "codex" as const,
      label: "Codex",
      configPath: join(root, "config.toml"),
    };
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({
        name: "tandem",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "tandem-editor@0.19.0", "mcp-stdio"],
          env: { SECRET: "must-not-leak" },
        },
      }),
      stderr: "",
    }));
    const result = await readExistingCodexEntry(target, run);
    expect(result.tandemEntry).toEqual({
      command: "npx",
      args: ["-y", "tandem-editor@0.19.0", "mcp-stdio"],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });
});
