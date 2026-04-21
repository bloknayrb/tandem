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

  it("includes Authorization header in HTTP entry when token is provided", () => {
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", { token });
    expect(entries.tandem.headers?.["Authorization"]).toBe(`Bearer ${token}`);
    expect(entries.tandem.type).toBe("http");
    expect(entries.tandem.url).toBe(`http://localhost:${DEFAULT_MCP_PORT}/mcp`);
  });

  it("omits headers from HTTP entry when no token (backward compat)", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js");
    expect(entries.tandem.headers).toBeUndefined();
  });

  it("includes TANDEM_AUTH_TOKEN in stdio shim env when token and withChannelShim are provided", () => {
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
      withChannelShim: true,
      token,
    });
    expect(entries["tandem-channel"]?.env?.TANDEM_AUTH_TOKEN).toBe(token);
    expect(entries["tandem-channel"]?.env?.TANDEM_URL).toBe(`http://localhost:${DEFAULT_MCP_PORT}`);
  });

  it("omits TANDEM_AUTH_TOKEN from shim env when no token", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
      withChannelShim: true,
    });
    expect(entries["tandem-channel"]?.env?.TANDEM_AUTH_TOKEN).toBeUndefined();
    expect(entries["tandem-channel"]?.env?.TANDEM_URL).toBe(`http://localhost:${DEFAULT_MCP_PORT}`);
  });

  it("generates stdio entry for claude-desktop targets", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
      targetKind: "claude-desktop",
    });
    expect(entries.tandem.command).toBe("npx");
    expect(entries.tandem.args).toEqual(["-y", "tandem-editor", "mcp-stdio"]);
    expect(entries.tandem.env?.TANDEM_URL).toBe(`http://localhost:${DEFAULT_MCP_PORT}`);
    expect(entries.tandem.type).toBeUndefined();
    expect(entries.tandem.url).toBeUndefined();
  });

  it("includes token in stdio entry env for claude-desktop targets", () => {
    const token = "abcdefghijklmnopqrstuvwxyz012345";
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
      targetKind: "claude-desktop",
      token,
    });
    expect(entries.tandem.env?.TANDEM_AUTH_TOKEN).toBe(token);
    expect(entries.tandem.headers).toBeUndefined();
  });

  it("generates HTTP entry for claude-code targets (default)", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
      targetKind: "claude-code",
    });
    expect(entries.tandem.type).toBe("http");
    expect(entries.tandem.url).toBe(`http://localhost:${DEFAULT_MCP_PORT}/mcp`);
    expect(entries.tandem.command).toBeUndefined();
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

  it("sets kind to claude-code for Claude Code targets", () => {
    writeFileSync(join(tmpDir, ".claude.json"), "{}");
    const targets = detectTargets({ homeOverride: tmpDir });
    const cc = targets.find((t) => t.label === "Claude Code");
    expect(cc?.kind).toBe("claude-code");
  });
});

describe.skipIf(process.platform !== "win32")("detectTargets — MSIX", () => {
  let tmpDir: string;
  let localAppData: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tandem-msix-test-"));
    localAppData = join(tmpDir, "LocalAppData");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects MSIX config when Claude_* package dir has config file", () => {
    const msixConfigDir = join(
      localAppData,
      "Packages",
      "Claude_abc123",
      "LocalCache",
      "Roaming",
      "Claude",
    );
    mkdirSync(msixConfigDir, { recursive: true });
    writeFileSync(join(msixConfigDir, "claude_desktop_config.json"), "{}");

    const targets = detectTargets({
      homeOverride: tmpDir,
      localAppDataOverride: localAppData,
    });
    const msix = targets.find((t) => t.label.includes("MSIX"));
    expect(msix).toBeDefined();
    expect(msix!.kind).toBe("claude-desktop");
    expect(msix!.configPath).toContain("Claude_abc123");
  });

  it("skips MSIX when no Claude_* package dirs exist", () => {
    mkdirSync(join(localAppData, "Packages", "SomeOtherApp_xyz"), { recursive: true });

    const targets = detectTargets({
      homeOverride: tmpDir,
      localAppDataOverride: localAppData,
    });
    expect(targets.some((t) => t.label.includes("MSIX"))).toBe(false);
  });

  it("skips MSIX when Packages dir does not exist", () => {
    const targets = detectTargets({
      homeOverride: tmpDir,
      localAppDataOverride: localAppData,
    });
    expect(targets.some((t) => t.label.includes("MSIX"))).toBe(false);
  });

  it("detects multiple MSIX installs and adds suffix", () => {
    for (const pkg of ["Claude_aaa111", "Claude_bbb222"]) {
      const dir = join(localAppData, "Packages", pkg, "LocalCache", "Roaming", "Claude");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "claude_desktop_config.json"), "{}");
    }

    const targets = detectTargets({
      homeOverride: tmpDir,
      localAppDataOverride: localAppData,
    });
    const msixTargets = targets.filter((t) => t.label.includes("MSIX"));
    expect(msixTargets.length).toBe(2);
    expect(msixTargets.every((t) => t.label.includes("…"))).toBe(true);
  });

  it("detects MSIX with --force even when config file is absent", () => {
    const msixDir = join(
      localAppData,
      "Packages",
      "Claude_abc123",
      "LocalCache",
      "Roaming",
      "Claude",
    );
    mkdirSync(msixDir, { recursive: true });

    const targets = detectTargets({
      homeOverride: tmpDir,
      localAppDataOverride: localAppData,
      force: true,
    });
    const msix = targets.find((t) => t.label.includes("MSIX"));
    expect(msix).toBeDefined();
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
