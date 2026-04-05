import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MCP_PORT } from "../../src/shared/constants.js";
import { buildMcpEntries, detectTargets, applyConfig, installSkill } from "../../src/cli/setup.js";

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
    // Malformed JSON should result in only tandem entries (no remnants)
    expect(Object.keys(written)).toEqual(["mcpServers"]);
  });

  it("propagates permission errors instead of silently swallowing", async () => {
    const configPath = join(tmpDir, "mcp_settings.json");
    // Create a directory where the file should be — readFileSync will throw EISDIR, not ENOENT
    mkdirSync(configPath, { recursive: true });
    const entries = buildMcpEntries("/fake/channel/index.js");
    await expect(applyConfig(configPath, entries)).rejects.toThrow();
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
    const cc = targets.find((t) => t.label === "Claude Code");
    expect(cc).toBeDefined();
    expect(cc!.configPath).toBe(join(tmpDir, ".claude", "mcp_settings.json"));
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

describe("installSkill", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tandem-skill-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes SKILL.md to ~/.claude/skills/tandem/", async () => {
    await installSkill({ homeOverride: tmpDir });
    const skillPath = join(tmpDir, ".claude", "skills", "tandem", "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("name: tandem");
  });

  it("creates the skills/tandem/ directory if missing", async () => {
    await installSkill({ homeOverride: tmpDir });
    const skillPath = join(tmpDir, ".claude", "skills", "tandem", "SKILL.md");
    expect(readFileSync(skillPath, "utf-8")).toBeTruthy();
  });

  it("overwrites existing file on re-run", async () => {
    const skillPath = join(tmpDir, ".claude", "skills", "tandem", "SKILL.md");
    mkdirSync(join(tmpDir, ".claude", "skills", "tandem"), { recursive: true });
    writeFileSync(skillPath, "old content");
    await installSkill({ homeOverride: tmpDir });
    const content = readFileSync(skillPath, "utf-8");
    expect(content).not.toBe("old content");
    expect(content).toContain("name: tandem");
  });

  it("produces valid YAML frontmatter", async () => {
    await installSkill({ homeOverride: tmpDir });
    const skillPath = join(tmpDir, ".claude", "skills", "tandem", "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    // Frontmatter is delimited by --- lines
    const parts = content.split("---");
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const frontmatter = parts[1];
    expect(frontmatter).toContain("name: tandem");
    expect(frontmatter).toContain("description:");
  });

  it("includes key workflow guidance in the skill body", async () => {
    await installSkill({ homeOverride: tmpDir });
    const skillPath = join(tmpDir, ".claude", "skills", "tandem", "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("tandem_resolveRange");
    expect(content).toContain("tandem_checkInbox");
    expect(content).toContain("Interruption Modes");
    expect(content).toContain("Error Recovery");
    expect(content).toContain("Session Handoff");
  });
});
