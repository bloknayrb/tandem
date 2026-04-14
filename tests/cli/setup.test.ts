import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyConfig,
  buildMcpEntries,
  detectTargets,
  installSkill,
  validateChannelShimPrereq,
} from "../../src/cli/setup.js";
import { DEFAULT_MCP_PORT } from "../../src/shared/constants.js";

describe("buildMcpEntries", () => {
  it("returns only the tandem HTTP entry by default (plugin handles channel)", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js");
    expect(entries.tandem).toEqual({
      type: "http",
      url: `http://localhost:${DEFAULT_MCP_PORT}/mcp`,
    });
    expect(entries["tandem-channel"]).toBeUndefined();
  });

  it("includes tandem-channel when withChannelShim: true (legacy opt-in)", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
      withChannelShim: true,
    });
    expect(entries["tandem-channel"]?.command).toBe("node");
    expect(entries["tandem-channel"]?.args).toEqual(["/abs/path/to/dist/channel/index.js"]);
  });

  it("uses custom nodeBinary when provided (Tauri sidecar path)", () => {
    const entries = buildMcpEntries("/app/Resources/dist/channel/index.js", {
      withChannelShim: true,
      nodeBinary: "/app/MacOS/node-sidecar",
    });
    expect(entries["tandem-channel"]?.command).toBe("/app/MacOS/node-sidecar");
  });
});

describe("validateChannelShimPrereq", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tandem-prereq-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when the channel bundle does not exist", () => {
    expect(validateChannelShimPrereq(join(tmpDir, "missing", "channel.js"))).toBe(false);
  });

  it("returns true when the channel bundle exists", () => {
    const p = join(tmpDir, "channel.js");
    writeFileSync(p, "");
    expect(validateChannelShimPrereq(p)).toBe(true);
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
    const configPath = join(tmpDir, ".claude.json");
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toEqual({
      type: "http",
      url: `http://localhost:${DEFAULT_MCP_PORT}/mcp`,
    });
    expect(written.mcpServers["tandem-channel"]).toBeUndefined();
  });

  it("creates parent directory if it does not exist", async () => {
    const configPath = join(tmpDir, "nested", "dir", ".claude.json");
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toBeDefined();
  });

  it("merges with existing config without overwriting other servers", async () => {
    const configPath = join(tmpDir, ".claude.json");
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

  it("preserves non-mcpServers keys in .claude.json", async () => {
    const configPath = join(tmpDir, ".claude.json");
    writeFileSync(configPath, JSON.stringify({ numStartups: 42, mcpServers: {} }));
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.numStartups).toBe(42);
    expect(written.mcpServers.tandem).toBeDefined();
  });

  it("overwrites existing tandem entries", async () => {
    const configPath = join(tmpDir, ".claude.json");
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
    const configPath = join(tmpDir, ".claude.json");
    writeFileSync(configPath, "{ this is not json }}}");
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toBeDefined();
    expect(Object.keys(written)).toEqual(["mcpServers"]);
  });

  it("backs up malformed .claude.json before overwriting", async () => {
    const configPath = join(tmpDir, ".claude.json");
    const badContent = "{ malformed }";
    writeFileSync(configPath, badContent);
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, entries);

    const backups = readdirSync(tmpDir).filter((n) => n.startsWith(".claude.json.broken-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(tmpDir, backups[0]!), "utf-8")).toBe(badContent);
  });

  it("propagates permission errors instead of silently swallowing", async () => {
    const configPath = join(tmpDir, ".claude.json");
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

  it("detects Claude Code when .claude.json exists", async () => {
    writeFileSync(join(tmpDir, ".claude.json"), "{}");
    const targets = detectTargets({ homeOverride: tmpDir });
    const cc = targets.find((t) => t.label === "Claude Code");
    expect(cc).toBeDefined();
    expect(cc!.configPath).toBe(join(tmpDir, ".claude.json"));
  });

  it("detects Claude Code when only ~/.claude directory exists (no .claude.json yet)", async () => {
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
    expect(content).toContain("Collaboration Mode");
    expect(content).toContain("Error Recovery");
    expect(content).toContain("Session Handoff");
  });
});

describe("runSetup plugin instructions", () => {
  it("package .claude-plugin/plugin.json exists at expected path", () => {
    const manifestPath = resolve(import.meta.dirname, "../../.claude-plugin/plugin.json");
    expect(existsSync(manifestPath)).toBe(true);
  });
});
