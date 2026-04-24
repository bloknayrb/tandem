import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isValidChannelPath,
  isValidNodeBinary,
  runSetupHandler,
} from "../../src/server/mcp/api-routes.js";

describe("isValidNodeBinary", () => {
  it("accepts absolute path ending in node", () => {
    expect(isValidNodeBinary("/usr/local/bin/node")).toBe(true);
  });

  it("accepts absolute path ending in node.exe", () => {
    expect(isValidNodeBinary("C:\\Program Files\\node.exe")).toBe(true);
  });

  it("accepts path ending in node-sidecar", () => {
    expect(isValidNodeBinary("/Applications/Tandem.app/Contents/MacOS/node-sidecar")).toBe(true);
  });

  it("accepts path ending in node-sidecar.exe", () => {
    expect(isValidNodeBinary("C:\\Program Files\\Tandem\\node-sidecar.exe")).toBe(true);
  });

  it("accepts bare 'node' (dev mode)", () => {
    expect(isValidNodeBinary("node")).toBe(true);
  });

  it("accepts bare 'node.exe' (dev mode)", () => {
    expect(isValidNodeBinary("node.exe")).toBe(true);
  });

  it("rejects arbitrary executables", () => {
    expect(isValidNodeBinary("/usr/bin/python")).toBe(false);
    expect(isValidNodeBinary("calc.exe")).toBe(false);
    expect(isValidNodeBinary("/bin/sh")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidNodeBinary("")).toBe(false);
  });

  it("accepts target-triple sidecar names (release builds)", () => {
    expect(
      isValidNodeBinary("C:\\Program Files\\Tandem\\node-sidecar-x86_64-pc-windows-msvc.exe"),
    ).toBe(true);
    expect(
      isValidNodeBinary(
        "/Applications/Tandem.app/Contents/MacOS/node-sidecar-aarch64-apple-darwin",
      ),
    ).toBe(true);
    expect(isValidNodeBinary("/usr/lib/tandem/node-sidecar-x86_64-unknown-linux-gnu")).toBe(true);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidNodeBinary("../../../bin/sh")).toBe(false);
    expect(isValidNodeBinary("/tmp/evil/node/../../../bin/sh")).toBe(false);
    expect(isValidNodeBinary("../../node")).toBe(false);
  });

  it("rejects UNC paths", () => {
    expect(isValidNodeBinary("\\\\attacker.com\\share\\node.exe")).toBe(false);
    expect(isValidNodeBinary("//attacker.com/share/node.exe")).toBe(false);
  });
});

describe("isValidChannelPath", () => {
  it("accepts absolute path ending in .js", () => {
    expect(isValidChannelPath("/app/Resources/dist/channel/index.js")).toBe(true);
  });

  it("accepts Windows absolute path ending in .js", () => {
    expect(isValidChannelPath("C:\\Program Files\\Tandem\\dist\\channel\\index.js")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidChannelPath("")).toBe(false);
  });

  it("rejects non-.js files", () => {
    expect(isValidChannelPath("/app/channel/index.ts")).toBe(false);
    expect(isValidChannelPath("/app/channel/evil.exe")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isValidChannelPath("/app/../../../etc/evil.js")).toBe(false);
    expect(isValidChannelPath("C:\\app\\..\\..\\evil.js")).toBe(false);
  });

  it("rejects UNC paths (backslash and forward-slash)", () => {
    expect(isValidChannelPath("\\\\server\\share\\evil.js")).toBe(false);
    expect(isValidChannelPath("//attacker.com/share/evil.js")).toBe(false);
  });

  it("accepts bare relative .js path (dev mode)", () => {
    expect(isValidChannelPath("dist/channel/index.js")).toBe(true);
  });
});

describe("runSetupHandler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tandem-setup-api-"));
    // Create ~/.claude dir so detectTargets finds Claude Code
    mkdirSync(join(tmpDir, ".claude"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 400 when nodeBinary is missing", async () => {
    const result = await runSetupHandler({ channelPath: "/fake/channel.js" }, tmpDir);
    expect(result.status).toBe(400);
  });

  it("returns 400 when channelPath is missing", async () => {
    const result = await runSetupHandler({ nodeBinary: "node" }, tmpDir);
    expect(result.status).toBe(400);
  });

  it("returns 400 when nodeBinary fails validation", async () => {
    const result = await runSetupHandler(
      { nodeBinary: "/usr/bin/python", channelPath: "/fake/channel.js" },
      tmpDir,
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("BAD_REQUEST");
  });

  it("returns 400 when channelPath fails validation", async () => {
    const result = await runSetupHandler(
      { nodeBinary: "node", channelPath: "/app/../../../etc/evil.js" },
      tmpDir,
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("BAD_REQUEST");
  });

  it("configures Claude Code when .claude dir exists", async () => {
    const result = await runSetupHandler(
      { nodeBinary: "node", channelPath: "/fake/dist/channel/index.js" },
      tmpDir,
    );
    expect(result.status).toBe(200);
    expect(result.body.data.configured).toContain("Claude Code");

    // Verify the config file was actually written
    const config = JSON.parse(readFileSync(join(tmpDir, ".claude.json"), "utf-8"));
    expect(config.mcpServers.tandem.url).toContain("/mcp");
    expect(config.mcpServers["tandem-channel"]).toBeUndefined();
  });

  it("does not detect Claude Code when .claude dir is absent", async () => {
    // Use a home dir with no .claude — Claude Code target should not appear.
    // Note: Claude Desktop may still be detected via APPDATA/platform paths.
    const emptyHome = mkdtempSync(join(tmpdir(), "tandem-empty-home-"));
    try {
      const result = await runSetupHandler(
        { nodeBinary: "node", channelPath: "/fake/channel.js" },
        emptyHome,
      );
      expect(result.status).toBe(200);
      const labels = result.body.data!.targets.map((t) => t.label);
      expect(labels).not.toContain("Claude Code");
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it("installs the Claude Code skill", async () => {
    const result = await runSetupHandler(
      { nodeBinary: "node", channelPath: "/fake/channel.js" },
      tmpDir,
    );
    expect(result.status).toBe(200);
    expect(result.body.data.skillInstalled).toBe(true);
    const skillPath = join(tmpDir, ".claude", "skills", "tandem", "SKILL.md");
    expect(readFileSync(skillPath, "utf-8")).toContain("name: tandem");
  });

  it("returns 207 on partial failure (some target configs fail, others succeed, skill installs)", async () => {
    // Create a directory at the config path to make applyConfig fail for it.
    // Skill install still succeeds against ~/.claude (writable in beforeEach),
    // and detectTargets may produce additional targets on this platform — which
    // is fine, the handler reports the mix.
    const configPath = join(tmpDir, ".claude.json");
    mkdirSync(configPath, { recursive: true });
    const result = await runSetupHandler(
      { nodeBinary: "node", channelPath: "/fake/channel.js" },
      tmpDir,
    );
    const data = result.body.data!;
    expect(data.skillInstalled).toBe(true);
    expect(data.errors.length).toBeGreaterThan(0);
    expect(data.errors.some((e) => e.includes("Claude Code"))).toBe(true);
    expect(result.status).toBe(207);
  });

  it.skipIf(process.platform === "win32")(
    "returns 207 with Claude Desktop configured and Claude Code errored (mixed-partial)",
    async () => {
      // Set up a valid Claude Desktop config file so that target succeeds.
      // On macOS the path is Library/Application Support/Claude/...; on Linux it's .config/claude/...
      const desktopPath =
        process.platform === "darwin"
          ? join(tmpDir, "Library", "Application Support", "Claude", "claude_desktop_config.json")
          : join(tmpDir, ".config", "claude", "claude_desktop_config.json");
      mkdirSync(dirname(desktopPath), { recursive: true });
      writeFileSync(desktopPath, "{}");

      // Place a directory at .claude.json so applyConfig throws EISDIR for Claude Code.
      const claudeCodeConfigPath = join(tmpDir, ".claude.json");
      mkdirSync(claudeCodeConfigPath, { recursive: true });

      const result = await runSetupHandler(
        { nodeBinary: "node", channelPath: "/fake/dist/channel/index.js" },
        tmpDir,
      );

      expect(result.status).toBe(207);
      const data = result.body.data!;
      expect(data.configured).toContain("Claude Desktop");
      expect(data.configured).not.toContain("Claude Code");
      expect(data.errors.some((e) => e.includes("Claude Code"))).toBe(true);
      expect(data.skillInstalled).toBe(true);
    },
  );

  it("does not write tandem-channel entry (channel shim is Claude Code-only)", async () => {
    const result = await runSetupHandler(
      {
        nodeBinary: "/app/MacOS/node-sidecar",
        channelPath: "/app/Resources/dist/channel/index.js",
      },
      tmpDir,
    );
    expect(result.status).toBe(200);
    const config = JSON.parse(readFileSync(join(tmpDir, ".claude.json"), "utf-8"));
    expect(config.mcpServers["tandem-channel"]).toBeUndefined();
  });

  it("removes pre-existing stale tandem-channel entry from .claude.json", async () => {
    const configPath = join(tmpDir, ".claude.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          "tandem-channel": {
            command: "node",
            args: ["/legacy/path/channel.js"],
          },
          "some-other-server": {
            url: "http://localhost:9999",
          },
        },
      }),
    );

    const result = await runSetupHandler(
      {
        nodeBinary: "/app/MacOS/node-sidecar",
        channelPath: "/app/Resources/dist/channel/index.js",
      },
      tmpDir,
    );
    expect(result.status).toBe(200);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.mcpServers["tandem-channel"]).toBeUndefined();
    expect(config.mcpServers["some-other-server"]).toBeDefined();
    expect(config.mcpServers["some-other-server"].url).toBe("http://localhost:9999");
    // Load-bearing: proves runSetupHandler's merge actually ran, not a silent no-op.
    // Claude Code targets use HTTP format (url), not stdio (command).
    expect(config.mcpServers.tandem).toBeDefined();
    expect(config.mcpServers.tandem.url).toContain("/mcp");
  });
});
