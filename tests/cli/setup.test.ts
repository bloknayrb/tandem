import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MCP_PORT } from "../../src/shared/constants.js";
import { buildMcpEntries, detectTargets, applyConfig } from "../../src/cli/setup.js";

describe("buildMcpEntries", () => {
  it("returns tandem HTTP entry and channel node entry", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js");
    expect(entries.tandem).toEqual({
      type: "http",
      url: `http://localhost:${DEFAULT_MCP_PORT}/mcp`,
    });
    expect(entries["tandem-channel"].command).toBe("node");
    expect(entries["tandem-channel"].args).toEqual(["/abs/path/to/dist/channel/index.js"]);
    expect(entries["tandem-channel"].env).toEqual({
      TANDEM_URL: `http://localhost:${DEFAULT_MCP_PORT}`,
    });
  });
});

describe("applyConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tandem-setup-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates config file with tandem entries when file does not exist", async () => {
    const configPath = join(tmpDir, "mcp_settings.json");
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toEqual({
      type: "http",
      url: `http://localhost:${DEFAULT_MCP_PORT}/mcp`,
    });
    expect(written.mcpServers["tandem-channel"].command).toBe("node");
  });

  it("creates parent directory if it does not exist", async () => {
    const configPath = join(tmpDir, "nested", "dir", "mcp_settings.json");
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toBeDefined();
  });

  it("merges with existing config without overwriting other servers", async () => {
    const configPath = join(tmpDir, "mcp_settings.json");
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { "my-other-server": { command: "foo" } } }),
    );
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers["my-other-server"]).toEqual({ command: "foo" });
    expect(written.mcpServers.tandem).toBeDefined();
  });

  it("overwrites existing tandem entries", async () => {
    const configPath = join(tmpDir, "mcp_settings.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { tandem: { type: "http", url: "http://old:9999/mcp" } },
      }),
    );
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem.url).toBe(`http://localhost:${DEFAULT_MCP_PORT}/mcp`);
  });

  it("overwrites malformed JSON with fresh config", async () => {
    const configPath = join(tmpDir, "mcp_settings.json");
    writeFileSync(configPath, "{ this is not json }}}");
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toBeDefined();
  });
});

describe("detectTargets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tandem-home-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects Claude Code when mcp_settings.json exists", async () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    writeFileSync(join(tmpDir, ".claude", "mcp_settings.json"), "{}");
    const targets = detectTargets({ homeOverride: tmpDir });
    expect(targets.some((t) => t.label === "Claude Code")).toBe(true);
  });

  it("detects Claude Code when only ~/.claude directory exists (no mcp_settings.json yet)", async () => {
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
    const targets = detectTargets({ homeOverride: tmpDir });
    expect(targets.some((t) => t.label === "Claude Code")).toBe(true);
  });

  it("does not detect Claude Code when ~/.claude does not exist", async () => {
    const targets = detectTargets({ homeOverride: tmpDir });
    expect(targets.some((t) => t.label === "Claude Code")).toBe(false);
  });

  it("detects Claude Code with --force even when ~/.claude is absent", async () => {
    const targets = detectTargets({ homeOverride: tmpDir, force: true });
    expect(targets.some((t) => t.label === "Claude Code")).toBe(true);
  });
});
