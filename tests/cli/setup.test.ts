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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSetup } from "../../src/cli/setup.js";
// These helpers moved to src/server/integrations/apply.ts in #477 PR 3c-ii-a;
// the back-compat re-export from src/cli/setup.ts was dropped in PR 3c-ii-c.
import {
  _resetStdioFallbackWarningForTests,
  applyConfig,
  applyConfigWithToken,
  applyOpsForCli,
  buildMcpEntries,
  detectTargets,
  installSkill,
  resolveCliVersion,
  shouldRegisterChannelShim,
  validateChannelShimPrereq,
} from "../../src/server/integrations/apply.js";
import { DEFAULT_MCP_PORT } from "../../src/shared/constants.js";
import { targetPushSupport } from "../../src/shared/integrations/contract.js";
import { isValidNodeBinary } from "../../src/shared/integrations/node-binary-name.js";

describe("buildMcpEntries", () => {
  it("returns only the tandem HTTP entry by default (plugin handles channel)", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js");
    expect(entries.tandem).toEqual({
      type: "http",
      url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`,
    });
    expect(entries["tandem-channel"]).toBeUndefined();
  });

  // The default was a bare `"node"` until it was found failing in the field two
  // different ways, both silent: Node absent from the client's PATH (the shim
  // never starts), and Node resolving under the session's cwd (Claude Code's
  // anti-PATH-hijack guard refuses it). Both are fixed by an absolute path, so
  // the default is now `process.execPath` — the Node already running Tandem,
  // which is the bundled sidecar in the desktop app.
  //
  // Pin the SOURCE, not just shape. `isAbsolute` + `isValidNodeBinary` are both
  // satisfied by `resolveNodeBinary("node")`, which returns `<cwd>/node` — a
  // path under the session's cwd, i.e. failure mode 2 exactly. A regression
  // that degraded the default to a bare or relative name would have passed a
  // properties-only assertion. `toBe(process.execPath)` pins where the value
  // comes from without pinning a machine-specific literal, and `existsSync`
  // pins the property that actually makes the shim start.
  it("defaults tandem-channel to the running Node's absolute path", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
      withChannelShim: true,
    });
    const command = entries["tandem-channel"]?.command ?? "";
    expect(command).toBe(process.execPath);
    expect(isAbsolute(command)).toBe(true);
    expect(existsSync(command)).toBe(true);
    expect(isValidNodeBinary(command)).toBe(true);
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
    expect(entries.tandem.url).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
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
    expect(entries["tandem-channel"]?.env?.TANDEM_URL).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}`);
  });

  it("omits TANDEM_AUTH_TOKEN from shim env when no token", () => {
    const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
      withChannelShim: true,
    });
    expect(entries["tandem-channel"]?.env?.TANDEM_AUTH_TOKEN).toBeUndefined();
    expect(entries["tandem-channel"]?.env?.TANDEM_URL).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}`);
  });

  // The `tandem` stdio entry is an absolute pair when one can be built and the
  // historical npx tuple when it cannot — see `buildStdioTandemEntry`. The
  // fallback IS the bug: a bare command word is resolved through the MCP
  // client's PATH at spawn time, and a GUI-launched client's PATH routinely
  // holds no Node at all.
  describe("claude-desktop stdio entry: absolute pair, else npx", () => {
    const NPX_ARGS = ["-y", `tandem-editor@${resolveCliVersion()}`, "mcp-stdio"];

    beforeEach(() => {
      // The "one cause deserves one warning" memo is module-scoped, so a prior
      // test's fallback would silence the next one's assertion.
      _resetStdioFallbackWarningForTests();
    });

    it("tier 1: absolute Node + absolute bridge when both resolve", () => {
      const bridge = join(tmpdir(), `tandem-bridge-${process.pid}.js`);
      writeFileSync(bridge, "// stub\n");
      try {
        const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
          targetKind: "claude-desktop",
          stdioBridgePath: bridge,
        });
        // No PATH lookup is needed to spawn either half of this.
        expect(entries.tandem.command).toBe(process.execPath);
        // Exactly ONE arg. Two would leave `validateTandemEntry`'s Node branch
        // and be reported `invalid-args`, which the wizard turns into
        // `apply: "skip"` — Tandem refusing to write its own correct entry.
        expect(entries.tandem.args).toEqual([bridge]);
        expect(entries.tandem.env?.TANDEM_URL).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}`);
        expect(entries.tandem.type).toBeUndefined();
        expect(entries.tandem.url).toBeUndefined();
      } finally {
        rmSync(bridge, { force: true });
      }
    });

    it("falls back to the BARE pinned npx tuple when the bridge is missing", () => {
      const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
        targetKind: "claude-desktop",
        stdioBridgePath: join(tmpdir(), "definitely-not-here-stdio-bridge.js"),
      });
      // The npx spec stays pinned to this build's version so `npm exec` bypasses
      // any stale global tandem-editor. `resolveCliVersion()` is the same source
      // the code uses, so this tracks releases without rotting.
      expect(entries.tandem.args).toEqual(NPX_ARGS);
      // BARE, on every host — even one with npx sitting on this process's PATH.
      // Embedding the absolute npx looks like a free improvement and is not:
      // `npx` is a `#!/usr/bin/env node` script, so an absolute path still
      // resolves `node` through the CLIENT's PATH and fails exactly where the
      // bare name does. This assertion is what keeps it from coming back.
      expect(entries.tandem.command).toBe("npx");
      expect(entries.tandem.env?.TANDEM_URL).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}`);
    });

    it("never emits a bare `node` when no absolute Node can be resolved", () => {
      const bridge = join(tmpdir(), `tandem-bridge-bare-${process.pid}.js`);
      writeFileSync(bridge, "// stub\n");
      try {
        const entries = buildMcpEntries("/abs/path/to/dist/channel/index.js", {
          targetKind: "claude-desktop",
          stdioBridgePath: bridge,
          nodeBinary: "node", // i.e. BARE_NODE — what resolveNodeBinary returns on a
          // Debian-lineage `nodejs` basename, a `..` in HOME, or a UNC path.
        });
        // A bare `node` has exactly the PATH problem this whole change fixes,
        // and unlike `npx` it is not even the shape clients have tolerated.
        expect(entries.tandem.command).not.toBe("node");
        expect(entries.tandem.args).toEqual(NPX_ARGS);
      } finally {
        rmSync(bridge, { force: true });
      }
    });

    it("warns once per cause, not once per target", () => {
      const errors: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
        errors.push(a.join(" "));
      });
      try {
        const missing = join(tmpdir(), "definitely-not-here-stdio-bridge.js");
        for (let i = 0; i < 3; i++) {
          buildMcpEntries("/abs/path/to/dist/channel/index.js", {
            targetKind: "claude-desktop",
            stdioBridgePath: missing,
          });
        }
        // `writeTargets` / `applyConfigWithToken` loop over every detected
        // target, so a per-call warning prints the same paragraph three times
        // for one cause.
        const warnings = errors.filter((e) => e.includes("Failed to spawn process"));
        expect(warnings).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });
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
    expect(entries.tandem.url).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
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

describe("shouldRegisterChannelShim", () => {
  let tmpDir: string;
  let realChannel: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tandem-should-shim-"));
    realChannel = join(tmpDir, "index.js");
    writeFileSync(realChannel, "");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Track E (2026-08-07) inverted this. It read "defaults ON for Claude Code
  // when the channel artifact exists (#985)" and was correct for as long as the
  // shim was believed to be the push transport. It is not: `runChannel` starts
  // its event bridge without asking whether the host negotiated
  // `claude/channel`, and delivery to a host that ignores the notification
  // never throws — so the default-on shim sat attached and inert for every
  // user who had run setup, holding the subscriber slot that makes
  // `subscribers === 0` the one sound negative Tandem has. Presence of the
  // build artifact is now irrelevant to the default; only an explicit request
  // registers it.
  it("defaults OFF for Claude Code even when the channel artifact exists", () => {
    expect(shouldRegisterChannelShim("claude-code", realChannel)).toBe(false);
  });

  it("defaults OFF for Claude Code when the artifact is missing", () => {
    expect(shouldRegisterChannelShim("claude-code", join(tmpDir, "missing.js"))).toBe(false);
  });

  it("an explicit opt-in still wins — this is opt-in, not removal", () => {
    // The distinction that makes this a default change rather than a removal:
    // a user who asks for the shim still gets it, and nothing Tandem does at
    // boot takes it away again.
    expect(shouldRegisterChannelShim("claude-code", realChannel, true)).toBe(true);
  });

  it("is always OFF for claude-desktop, even when the artifact exists", () => {
    expect(shouldRegisterChannelShim("claude-desktop", realChannel)).toBe(false);
  });

  it("honors an explicit override either way (bypasses the existence check)", () => {
    expect(shouldRegisterChannelShim("claude-code", join(tmpDir, "missing.js"), true)).toBe(true);
    expect(shouldRegisterChannelShim("claude-code", realChannel, false)).toBe(false);
  });

  it("override does not resurrect the channel for claude-desktop", () => {
    expect(shouldRegisterChannelShim("claude-desktop", realChannel, true)).toBe(false);
  });

  it("refuses the shim for exactly the kinds the shared predicate calls unpushable (#1299)", () => {
    // The wizard renders its "no real-time updates" line off
    // `targetPushSupport`; this gate decides what actually gets written. They
    // were the same fact stated twice — a bare `=== "claude-desktop"` here and
    // nothing at all in the UI — which is how a Claude Desktop user came to be
    // told "AI connected" and then ignored. Pinning the gate to the predicate
    // means a kind added to `"none"` cannot get a shim, and a kind removed
    // from it cannot keep a stale warning.
    for (const kind of ["claude-code", "claude-desktop"] as const) {
      const unpushable = targetPushSupport(kind) === "none";
      // Artifact present AND an explicit opt-in — the most permissive inputs
      // there are. Only the predicate may still say no.
      expect(shouldRegisterChannelShim(kind, realChannel, true)).toBe(!unpushable);
    }
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
    await applyConfig(configPath, applyOpsForCli(entries, { withChannelShim: false }));
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toEqual({
      type: "http",
      url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`,
    });
    expect(written.mcpServers["tandem-channel"]).toBeUndefined();
  });

  // The migration every existing Claude Desktop user goes through exactly once.
  it("rewrites a legacy bare-npx desktop entry, backs it up once, then is idempotent", async () => {
    const configPath = join(tmpDir, "claude_desktop_config.json");
    const bridge = join(tmpDir, "dist", "stdio-bridge", "index.js");
    mkdirSync(dirname(bridge), { recursive: true });
    writeFileSync(bridge, "// stub\n");
    // What every pre-fix install has on disk.
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          tandem: {
            command: "npx",
            args: ["-y", "tandem-editor@0.20.0", "mcp-stdio"],
            env: { TANDEM_URL: `http://127.0.0.1:${DEFAULT_MCP_PORT}` },
          },
        },
      }),
    );

    const backups: string[] = [];
    const build = () =>
      buildMcpEntries("/fake/channel/index.js", {
        targetKind: "claude-desktop",
        stdioBridgePath: bridge,
      });
    const ops = () => ({
      ...applyOpsForCli(build(), { withChannelShim: false }),
      onBackup: (p: string) => backups.push(p),
    });

    await applyConfig(configPath, ops());

    const after = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(after.mcpServers.tandem.command).toBe(process.execPath);
    expect(after.mcpServers.tandem.args).toEqual([bridge]);
    // The user's old entry is recoverable — this is a rewrite of something they
    // may have hand-edited.
    expect(backups).toHaveLength(1);

    // Second apply from the SAME binary must be a byte-level no-op. Without
    // this, every run would churn the file and burn a backup slot (MAX_BACKUPS
    // is 3), eventually evicting the one copy of their original config.
    const before = readFileSync(configPath, "utf-8");
    await applyConfig(configPath, ops());
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(backups).toHaveLength(1);
  });

  it("creates parent directory if it does not exist", async () => {
    const configPath = join(tmpDir, "nested", "dir", ".claude.json");
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, applyOpsForCli(entries, { withChannelShim: false }));
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
    await applyConfig(configPath, applyOpsForCli(entries, { withChannelShim: false }));
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers["my-other-server"]).toEqual({ command: "foo" });
    expect(written.mcpServers.tandem).toBeDefined();
  });

  it("preserves non-mcpServers keys in .claude.json", async () => {
    const configPath = join(tmpDir, ".claude.json");
    writeFileSync(configPath, JSON.stringify({ numStartups: 42, mcpServers: {} }));
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, applyOpsForCli(entries, { withChannelShim: false }));
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
    await applyConfig(configPath, applyOpsForCli(entries, { withChannelShim: false }));
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem.url).toBe(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
  });

  it("removes stale tandem-channel entry left by older installers", async () => {
    const configPath = join(tmpDir, ".claude.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          tandem: { type: "http", url: "http://old:9999/mcp" },
          "tandem-channel": { command: "/app/MacOS/node-sidecar", args: ["/old/channel.js"] },
          "my-other-server": { command: "foo" },
        },
      }),
    );
    const entries = buildMcpEntries("/fake/channel/index.js");
    await applyConfig(configPath, applyOpsForCli(entries, { withChannelShim: false }));
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers["tandem-channel"]).toBeUndefined();
    expect(written.mcpServers["my-other-server"]).toEqual({ command: "foo" });
    expect(written.mcpServers.tandem).toBeDefined();
  });

  it("preserves tandem-channel when explicitly included in entries", async () => {
    const configPath = join(tmpDir, ".claude.json");
    const entries = buildMcpEntries("/fake/channel/index.js", { withChannelShim: true });
    await applyConfig(configPath, applyOpsForCli(entries, { withChannelShim: true }));
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers["tandem-channel"]).toBeDefined();
  });

  it("never removes a key it is also creating — 'create wins' invariant (#985)", async () => {
    // The wizard builds ApplyOps directly from a user-confirmed diff and can
    // list the same key in both create and remove. applyConfig must keep the
    // created entry rather than deleting the channel shim it just registered.
    const configPath = join(tmpDir, ".claude.json");
    const entries = buildMcpEntries("/fake/channel/index.js", { withChannelShim: true });
    await applyConfig(configPath, { create: entries, remove: ["tandem-channel"] });
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers["tandem-channel"]).toBeDefined();
    expect(written.mcpServers["tandem-channel"].args).toEqual(["/fake/channel/index.js"]);
  });

  it("overwrites malformed JSON with fresh config", async () => {
    const configPath = join(tmpDir, ".claude.json");
    writeFileSync(configPath, "{ this is not json }}}");
    const entries = buildMcpEntries("/fake/channel/index.js");
    const prevAppData = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = tmpDir;
    try {
      await applyConfig(configPath, applyOpsForCli(entries, { withChannelShim: false }));
    } finally {
      if (prevAppData === undefined) delete process.env.TANDEM_APP_DATA_DIR;
      else process.env.TANDEM_APP_DATA_DIR = prevAppData;
    }
    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.mcpServers.tandem).toBeDefined();
    expect(Object.keys(written)).toEqual(["mcpServers"]);
  });

  it("backs up malformed .claude.json before overwriting", async () => {
    const configPath = join(tmpDir, ".claude.json");
    const badContent = "{ malformed }";
    writeFileSync(configPath, badContent);
    const entries = buildMcpEntries("/fake/channel/index.js");
    const prevAppData = process.env.TANDEM_APP_DATA_DIR;
    process.env.TANDEM_APP_DATA_DIR = tmpDir;
    try {
      await applyConfig(configPath, applyOpsForCli(entries, { withChannelShim: false }));
    } finally {
      if (prevAppData === undefined) delete process.env.TANDEM_APP_DATA_DIR;
      else process.env.TANDEM_APP_DATA_DIR = prevAppData;
    }

    // 3c-ii-b moved the backup under the Tandem data-dir (with 0o600 on
    // POSIX) so we don't leak the malformed file's contents through a
    // world-readable sibling of ~/.claude.json.
    const backupDir = join(tmpDir, ".broken-backups");
    const backups = readdirSync(backupDir).filter((n) => n.startsWith(".claude.json.broken-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(backupDir, backups[0]!), "utf-8")).toBe(badContent);
  });

  it("propagates permission errors instead of silently swallowing", async () => {
    const configPath = join(tmpDir, ".claude.json");
    mkdirSync(configPath, { recursive: true });
    const entries = buildMcpEntries("/fake/channel/index.js");
    await expect(
      applyConfig(configPath, applyOpsForCli(entries, { withChannelShim: false })),
    ).rejects.toThrow();
  });
});

/**
 * Where `detectTargets` puts the Claude Desktop config under a given home.
 *
 * Mirrors the three platform branches in `detectTargets`. Spelled out rather
 * than imported, because an expectation derived from the code under test
 * cannot fail — but it has to be spelled out for ALL THREE platforms: the
 * first version of the test below hard-coded the win32 path, passed locally,
 * and went red on Linux CI.
 */
function desktopConfigUnder(home: string): string {
  if (process.platform === "win32") {
    return join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "claude", "claude_desktop_config.json");
}

describe("applyConfigWithToken — rotation preserves, it does not re-derive", () => {
  let home: string;

  function writeConfig(servers: Record<string, unknown>): void {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
  }
  function readServers(): Record<string, unknown> {
    const raw = JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    return raw.mcpServers;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tandem-rotate-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // THE regression this file exists to catch. `shouldRegisterChannelShim`
  // answers "what should a FRESH setup write" — since Track E, `false` — and
  // `applyOpsForCli` turns a `false` into an explicit REMOVE. Routing rotation
  // through it made `tandem rotate-token`, whose entire job is to change the
  // token, silently delete a shim the user had opted into. The CHANGELOG
  // promises the opposite in so many words: "nothing changes and nothing is
  // removed".
  it("keeps an opted-in tandem-channel entry when no flag is passed", async () => {
    writeConfig({
      tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
      "tandem-channel": { command: "/usr/bin/node", args: ["/x/channel/index.js"] },
    });

    await applyConfigWithToken("abcdefghijklmnopqrstuvwxyz012345", { homeOverride: home });

    expect(readServers()["tandem-channel"]).toBeDefined();
  });

  it("does not conjure one into a config that never had it", async () => {
    // The other direction, so the fix cannot be "always keep the shim" — that
    // would restore the default-on behaviour Track E removed.
    writeConfig({ tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } });

    await applyConfigWithToken("abcdefghijklmnopqrstuvwxyz012345", { homeOverride: home });

    expect(readServers()["tandem-channel"]).toBeUndefined();
  });

  it("still honours an explicit false — that is a request, not an omission", async () => {
    writeConfig({
      tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
      "tandem-channel": { command: "/usr/bin/node", args: ["/x/channel/index.js"] },
    });

    await applyConfigWithToken("abcdefghijklmnopqrstuvwxyz012345", {
      homeOverride: home,
      withChannelShim: false,
    });

    expect(readServers()["tandem-channel"]).toBeUndefined();
  });

  it("does not conjure a shim into a config that lacks one, on any target kind", async () => {
    // Pins the push-support branch of the resolver against a FIXTURE rather
    // than against whatever Claude Desktop config the developer happens to
    // have — which is how the branch went unexercised while the suite was
    // quietly writing to the real one.
    const desktopPath = desktopConfigUnder(home);
    mkdirSync(dirname(desktopPath), { recursive: true });
    writeFileSync(
      desktopPath,
      JSON.stringify({ mcpServers: { "tandem-channel": { command: "node" } } }),
    );
    writeConfig({ tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" } });

    await applyConfigWithToken("abcdefghijklmnopqrstuvwxyz012345", { homeOverride: home });

    // Claude Desktop has no push transport at all, so a shim there is removed
    // regardless of what the file said (#1299) — and, crucially, the write
    // landed inside the temp home rather than on the real config.
    const desktop = JSON.parse(readFileSync(desktopPath, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(desktop.mcpServers["tandem-channel"]).toBeUndefined();
  });

  it("rewrites the token either way", async () => {
    // Guards against "preserve" being implemented as "skip this target".
    writeConfig({
      tandem: { type: "http", url: "http://127.0.0.1:3479/mcp" },
      "tandem-channel": { command: "/usr/bin/node", args: ["/x/channel/index.js"] },
    });
    const token = "abcdefghijklmnopqrstuvwxyz012345";

    await applyConfigWithToken(token, { homeOverride: home });

    const tandem = readServers().tandem as { headers?: Record<string, string> };
    expect(tandem.headers?.Authorization).toBe(`Bearer ${token}`);
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

  // The guard that was missing on 2026-08-09, when a test using `homeOverride`
  // wrote its fixture token into the developer's LIVE Claude Desktop config.
  // `%APPDATA%` is set on every real Windows box, so reading it first made the
  // override partial — and `assertPathSafe` cannot catch the escape, because it
  // validates against the process's real `homedir()`, which the real APPDATA
  // path sits happily inside. `homeOverride` is a containment boundary; a
  // partial one is worse than none, because callers reasonably trust it.
  it("keeps EVERY detected path under homeOverride, %APPDATA% notwithstanding", () => {
    const targets = detectTargets({ homeOverride: tmpDir, force: true });
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(t.configPath.startsWith(tmpDir), `${t.label} escaped to ${t.configPath}`).toBe(true);
    }
  });

  // `%APPDATA%` exists only on win32, and so does the branch that reads it —
  // elsewhere the Desktop path is derived from `home` alone and the override
  // has nothing to win over. Skipped rather than softened to `if (desktop)`,
  // which is how the first version passed vacuously nowhere and failed on CI.
  it.skipIf(process.platform !== "win32")(
    "lets appDataOverride win over homeOverride for the Desktop target",
    () => {
      const appData = mkdtempSync(join(tmpdir(), "tandem-appdata-"));
      try {
        const targets = detectTargets({
          homeOverride: tmpDir,
          appDataOverride: appData,
          force: true,
        });
        const desktop = targets.find((t) => t.label === "Claude Desktop");
        expect(desktop?.configPath.startsWith(appData)).toBe(true);
      } finally {
        rmSync(appData, { recursive: true, force: true });
      }
    },
  );

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

describe("runSetup — non-interactive (#477 PR 3c-ii-c)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  const stderr = () => errSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? "")).join("\n");

  it("bare `tandem setup` prints wizard-driven guidance and writes nothing", async () => {
    await runSetup();
    const out = stderr();
    expect(out).toContain("wizard-driven");
    expect(out).toContain("tandem setup --apply");
    // The default path must not announce a config write — that's the behavior
    // change: bare `tandem setup` no longer silently configures Claude.
    expect(out).not.toContain("Writing MCP configuration");
  });

  it("`apply: false` is equivalent to no flags (guidance only)", async () => {
    await runSetup({ apply: false, force: true });
    expect(stderr()).toContain("wizard-driven");
  });
});
