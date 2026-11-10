import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetClaudeCodeHttpWarningForTests,
  _setClaudeCodeBridgeForTests,
  _setSweepBeforeCommitForTests,
  applyConfig,
  bridgeScriptVersion,
  buildMcpEntries,
  refreshAllMcpEntryBinaries,
} from "../../../src/server/integrations/apply.js";
import {
  backupDir,
  listBackups,
  MAX_BACKUPS,
  SWEEP_BACKUP_PREFIX,
  writeBackup,
} from "../../../src/server/integrations/backup.js";
import { resolveAppDataDir } from "../../../src/server/platform.js";

/**
 * #2358 PR 2b — Claude Code's `tandem` entry becomes the stdio bridge, and the
 * boot sweep migrates the direct-HTTP entry Tandem wrote. Design:
 * docs/spikes/multi-session-ownership/README.md §3.6.
 *
 * Under vitest the real installed-build gate is a checkout (refused), so every
 * positive case pins the bridge pair with `_setClaudeCodeBridgeForTests`; the
 * "gate refuses" cases pin it to `null`. Every refusal case compares the file's
 * BYTES before and after, and each describe has a positive control in the same
 * run, so a deleted feature cannot pass as a refusal.
 */

const MCP = "http://127.0.0.1:3479";
const TOKEN = "A".repeat(43);

let home: string;
let bin: string;
let node: string;
let script: string;
let errSpy: ReturnType<typeof vi.spyOn>;
const stderr = () => errSpy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");

const claudeJson = () => join(home, ".claude.json");
const writeConfig = (root: unknown) =>
  writeFileSync(claudeJson(), `${JSON.stringify(root, null, 2)}\n`);
const readConfig = () => JSON.parse(readFileSync(claudeJson(), "utf-8"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tandem-cc-migrate-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  bin = join(home, "opt");
  node = join(bin, "node");
  script = join(home, "install", "dist", "stdio-bridge", "index.js");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(script, ".."), { recursive: true });
  writeFileSync(node, "#!/bin/sh\n");
  writeFileSync(script, "// bridge\n");
  _setClaudeCodeBridgeForTests({ command: node, script });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  _setClaudeCodeBridgeForTests(undefined);
  _setSweepBeforeCommitForTests(undefined);
  errSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

describe("the migration matches exactly the HTTP shape Tandem wrote", () => {
  it("migrates the token-less entry onto the bridge", async () => {
    writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } }, other: 1 });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    const after = readConfig();
    expect(after.mcpServers.tandem).toEqual({
      command: node,
      args: [script],
      env: { TANDEM_URL: MCP },
    });
    expect(after.other).toBe(1);
    expect(stderr()).toContain("Switched the tandem entry in Claude Code");
    expect(stderr()).toContain(claudeJson());
  });

  it("moves the bearer token verbatim into env and never logs it", async () => {
    writeConfig({
      mcpServers: {
        tandem: { type: "http", url: `${MCP}/mcp`, headers: { Authorization: `Bearer ${TOKEN}` } },
      },
    });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readConfig().mcpServers.tandem.env).toEqual({
      TANDEM_URL: MCP,
      TANDEM_AUTH_TOKEN: TOKEN,
    });
    // Positive control first: the line WAS logged, so the absence below means something.
    expect(stderr()).toContain("Switched the tandem entry");
    expect(stderr()).not.toContain(TOKEN);
  });

  const refused: [string, unknown][] = [
    ["an extra top-level key", { type: "http", url: `${MCP}/mcp`, timeout: 5 }],
    [
      "an extra header",
      {
        type: "http",
        url: `${MCP}/mcp`,
        headers: { Authorization: `Bearer ${TOKEN}`, "X-Mine": "1" },
      },
    ],
    [
      "a lowercase authorization key",
      { type: "http", url: `${MCP}/mcp`, headers: { authorization: `Bearer ${TOKEN}` } },
    ],
    [
      "a token the bridge would refuse",
      { type: "http", url: `${MCP}/mcp`, headers: { Authorization: "Bearer short" } },
    ],
    [
      "a double space after Bearer",
      { type: "http", url: `${MCP}/mcp`, headers: { Authorization: `Bearer  ${TOKEN}` } },
    ],
    [
      "an over-long token",
      { type: "http", url: `${MCP}/mcp`, headers: { Authorization: `Bearer ${"a".repeat(600)}` } },
    ],
    ["another port", { type: "http", url: "http://127.0.0.1:9999/mcp" }],
    ["localhost", { type: "http", url: "http://localhost:3479/mcp" }],
    ["a trailing slash", { type: "http", url: `${MCP}/mcp/` }],
    ["no type", { url: `${MCP}/mcp` }],
    ["type sse", { type: "sse", url: `${MCP}/mcp` }],
    ["an array", [{ type: "http", url: `${MCP}/mcp` }]],
    ["null", null],
    ["a headers string", { type: "http", url: `${MCP}/mcp`, headers: "x" }],
  ];

  it.each(refused)("leaves %s exactly as found", async (_name, tandem) => {
    writeConfig({ mcpServers: { tandem } });
    const before = readFileSync(claudeJson());

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readFileSync(claudeJson()).equals(before)).toBe(true);
    expect(stderr()).not.toContain("Switched the tandem entry");
  });

  it("never touches a project-scope tandem entry", async () => {
    const projectEntry = { type: "http", url: `${MCP}/mcp` };
    writeConfig({
      mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } },
      projects: { "/p": { mcpServers: { tandem: projectEntry } } },
    });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    const after = readConfig();
    expect(after.mcpServers.tandem.command).toBe(node); // positive control
    expect(after.projects["/p"].mcpServers.tandem).toEqual(projectEntry);
  });

  it("is a no-op on the next boot", async () => {
    writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } } });
    await refreshAllMcpEntryBinaries({ homeOverride: home });
    const once = readFileSync(claudeJson());
    const mtime = statSync(claudeJson()).mtimeMs;
    errSpy.mockClear();

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readFileSync(claudeJson()).equals(once)).toBe(true);
    expect(statSync(claudeJson()).mtimeMs).toBe(mtime);
    expect(stderr()).toBe("");
  });
});

describe("scope and gates", () => {
  it("never migrates a Claude Desktop config, in the same run that migrates Claude Code", async () => {
    const desktop = join(home, ".config", "claude", "claude_desktop_config.json");
    mkdirSync(join(desktop, ".."), { recursive: true });
    const desktopBody = JSON.stringify({
      mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } },
    });
    writeFileSync(desktop, desktopBody);
    writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } } });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readConfig().mcpServers.tandem.command).toBe(node);
    expect(readFileSync(desktop, "utf-8")).toBe(desktopBody);
  });

  it("does nothing when this build cannot write a bridge (a checkout, no durable Node)", async () => {
    _setClaudeCodeBridgeForTests(null);
    _resetClaudeCodeHttpWarningForTests();
    writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } } });
    const before = readFileSync(claudeJson());

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readFileSync(claudeJson()).equals(before)).toBe(true);
    // The reason is logged — the line `tandem doctor`'s "unprobed" remedy
    // points at. (Once per process; the seam above re-arms it.)
    expect(stderr()).toContain("Claude Code's 'tandem' entry stays direct HTTP");
  });

  it("never repoints a bridge entry from a build that cannot write one (no checkout paths)", async () => {
    _setClaudeCodeBridgeForTests(null);
    writeConfig({
      mcpServers: {
        tandem: {
          command: join(home, "gone", "node"),
          args: [join(home, "gone", "dist", "stdio-bridge", "index.js")],
        },
      },
    });
    const before = readFileSync(claudeJson());

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readFileSync(claudeJson()).equals(before)).toBe(true);
  });
});

describe("the pre-rename re-check against Claude Code's own writes", () => {
  // A whole-millisecond mtime, so `utimesSync(Date)` below can restore it
  // EXACTLY: then only the byte comparison can see the same-size rewrite.
  const WHOLE_MS = new Date(1_700_000_000_000);
  const seed = () => {
    writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } }, n: 1 });
    utimesSync(claudeJson(), WHOLE_MS, WHOLE_MS);
  };
  const tempsLeft = () => readdirSync(home).filter((n) => n.startsWith(".tandem-setup-"));

  const sweepBackups = async () => {
    const dir = backupDir(resolveAppDataDir());
    return existsSync(dir) ? await listBackups(dir, SWEEP_BACKUP_PREFIX) : [];
  };

  const fillBackupCap = async () => {
    const dir = backupDir(resolveAppDataDir());
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    while ((await sweepBackups()).length < MAX_BACKUPS) {
      await writeBackup(dir, Buffer.from("{}\n"), SWEEP_BACKUP_PREFIX);
    }
  };

  it("abandons a write when the file changed size, and retries it from a fresh read", async () => {
    seed();
    await fillBackupCap();
    const backupsBefore = new Set(await sweepBackups());
    let tries = 0;
    _setSweepBeforeCommitForTests(async () => {
      // Claude Code's write lands during the FIRST try only.
      if (++tries === 1) {
        writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } }, n: 12345 });
      }
    });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(tries).toBe(2);
    // Claude Code's write survives (the retry re-read it), and the switch lands.
    expect(readConfig().n).toBe(12345);
    expect(readConfig().mcpServers.tandem.command).toBe(node);
    expect(stderr()).toContain("Switched the tandem entry");
    expect(stderr()).toContain("trying again (2 of 3)");
    expect(stderr()).not.toContain("left as found");
    expect(tempsLeft()).toEqual([]);
    // One backup: the landed write's pre-image. The abandoned try's is gone.
    const added = (await sweepBackups()).filter((n) => !backupsBefore.has(n));
    expect(added).toHaveLength(1);
    const backup = JSON.parse(
      readFileSync(join(backupDir(resolveAppDataDir()), added[0] as string), "utf-8"),
    ) as { n: number };
    expect(backup.n).toBe(12345);
    // The cap is applied once the write has landed, keeping the new one.
    expect(await sweepBackups()).toHaveLength(MAX_BACKUPS);
  });

  it("gives up after three tries within a boot, leaves the file as found, and keeps no backup", async () => {
    seed();
    // A full cap: an abandoned try must not evict any of these.
    await fillBackupCap();
    const backupsBefore = await sweepBackups();
    let tries = 0;
    _setSweepBeforeCommitForTests(async () => {
      tries++;
      writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } }, n: 1000 + tries });
    });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(tries).toBe(3);
    expect(readConfig().n).toBe(1003);
    expect(readConfig().mcpServers.tandem.type).toBe("http");
    expect(stderr()).toContain("changed each of the 3 times Tandem tried to update it");
    expect(stderr()).toContain("left as found — Tandem will try again at its next start");
    // A write that was abandoned is never also reported as made.
    expect(stderr()).not.toContain("Switched the tandem entry");
    expect(tempsLeft()).toEqual([]);
    // Every abandoned try's backup was removed (hardware smoke, P16), and each
    // removal is named, so a smoke run can see it rather than infer it.
    expect(await sweepBackups()).toEqual(backupsBefore);
    const removed = stderr().match(
      /Removed backup sweep-claude-json-\S+\.json, taken for a write/g,
    );
    expect(removed).toHaveLength(3);
  });

  it("catches a same-size rewrite with the mtime put back, so the retry keeps it", async () => {
    seed();
    const before = statSync(claudeJson(), { bigint: true });
    let tries = 0;
    _setSweepBeforeCommitForTests(async () => {
      if (++tries > 1) return;
      writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } }, n: 2 });
      utimesSync(claudeJson(), WHOLE_MS, WHOLE_MS);
      const after = statSync(claudeJson(), { bigint: true });
      // Metadata identical: size, mtime to the nanosecond, and (an in-place
      // write) the inode. Only the bytes differ.
      expect(after.size).toBe(before.size);
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.ino).toBe(before.ino);
    });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    // Had the byte comparison missed it, the first try would have written its
    // stale copy (n: 1) over Claude Code's change.
    expect(tries).toBe(2);
    expect(readConfig().n).toBe(2);
    expect(readConfig().mcpServers.tandem.command).toBe(node);
    expect(tempsLeft()).toEqual([]);
  });

  it("writes when nothing changed (control)", async () => {
    seed();
    _setSweepBeforeCommitForTests(async () => {});

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readConfig().mcpServers.tandem.command).toBe(node);
  });
});

describe("the sweep backs up Claude Code's config before rewriting it", () => {
  const dir = () => backupDir(resolveAppDataDir());
  const names = async () =>
    existsSync(dir()) ? await listBackups(dir(), SWEEP_BACKUP_PREFIX) : [];

  it("writes the exact pre-image as a backup, then switches the entry", async () => {
    writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } }, keep: "me" });
    const preImage = readFileSync(claudeJson());
    const before = new Set(await names());

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readConfig().mcpServers.tandem.command).toBe(node);
    const added = (await names()).filter((n) => !before.has(n));
    expect(added).toHaveLength(1);
    const backup = readFileSync(join(dir(), added[0] as string));
    expect(backup.equals(preImage)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(dir(), added[0] as string)).mode & 0o777).toBe(0o600);
    }
  });

  it("takes no backup when nothing is written (a healthy boot)", async () => {
    writeConfig({ mcpServers: { tandem: { command: node, args: [script], env: {} } } });
    const before = await names();
    await refreshAllMcpEntryBinaries({ homeOverride: home });
    expect(await names()).toEqual(before);
  });

  it("no backup, no write: a backup that fails leaves the config byte-identical", async () => {
    writeConfig({ mcpServers: { tandem: { type: "http", url: `${MCP}/mcp` } } });
    const preImage = readFileSync(claudeJson());
    // Put a FILE where the backup directory goes, so the backup cannot land.
    const aside = `${dir()}.aside-${process.pid}`;
    const hadDir = existsSync(dir());
    if (hadDir) renameSync(dir(), aside);
    mkdirSync(join(dir(), ".."), { recursive: true });
    writeFileSync(dir(), "not a directory");
    try {
      await refreshAllMcpEntryBinaries({ homeOverride: home });
    } finally {
      rmSync(dir(), { force: true });
      if (hadDir) renameSync(aside, dir());
    }
    expect(readFileSync(claudeJson()).equals(preImage)).toBe(true);
    expect(stderr()).toContain("could not back it up first");
    expect(stderr()).not.toContain("Switched the tandem entry");
  });
});

describe("re-picking the Node of a Tandem-written bridge entry", () => {
  it("repoints a dead Node to the current pick", async () => {
    writeConfig({
      mcpServers: { tandem: { command: join(home, "gone", "node"), args: [script], env: {} } },
    });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readConfig().mcpServers.tandem.command).toBe(node);
  });

  it("repoints a dead script to the current one, keeping a live Node", async () => {
    const dead = join(home, "gone", "dist", "stdio-bridge", "index.js");
    writeConfig({ mcpServers: { tandem: { command: node, args: [dead], env: {} } } });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readConfig().mcpServers.tandem).toMatchObject({ command: node, args: [script] });
    expect(stderr()).toContain("Repaired the tandem entry");
  });

  it("moves the desktop's bundled Node to a system Node once one qualifies", async () => {
    const sidecar = join(home, "app", "node-sidecar-x86_64-unknown-linux-gnu");
    mkdirSync(join(sidecar, ".."), { recursive: true });
    writeFileSync(sidecar, "");
    writeConfig({ mcpServers: { tandem: { command: sidecar, args: [script], env: {} } } });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readConfig().mcpServers.tandem.command).toBe(node);
  });

  it("never moves a live system Node, so two launch environments cannot flip it", async () => {
    const other = join(home, "other", "node");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, "");
    writeConfig({ mcpServers: { tandem: { command: other, args: [script], env: {} } } });
    const before = readFileSync(claudeJson());

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readFileSync(claudeJson()).equals(before)).toBe(true);
  });

  it("never moves a system Node back onto the bundled one", async () => {
    const sidecar = join(home, "app", "node-sidecar-x86_64-unknown-linux-gnu");
    mkdirSync(join(sidecar, ".."), { recursive: true });
    writeFileSync(sidecar, "");
    _setClaudeCodeBridgeForTests({ command: sidecar, script });
    writeConfig({ mcpServers: { tandem: { command: node, args: [script], env: {} } } });
    const before = readFileSync(claudeJson());

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readFileSync(claudeJson()).equals(before)).toBe(true);
  });
});

describe("the writer", () => {
  it("writes the bridge for Claude Code when both halves are durable", () => {
    const entries = buildMcpEntries("/c", { targetKind: "claude-code", token: TOKEN });
    expect(entries.tandem).toEqual({
      command: node,
      args: [script],
      env: { TANDEM_URL: MCP, TANDEM_AUTH_TOKEN: TOKEN },
    });
  });

  it("keeps direct HTTP, never npx, when no bridge can be built", () => {
    _setClaudeCodeBridgeForTests(null);
    const entries = buildMcpEntries("/c", { targetKind: "claude-code", token: TOKEN });
    expect(entries.tandem).toEqual({
      type: "http",
      url: `${MCP}/mcp`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(JSON.stringify(entries.tandem)).not.toContain("npx");
  });
});

describe("applyConfig never downgrades a working bridge to HTTP", () => {
  const httpPlan = (token?: string) => {
    _setClaudeCodeBridgeForTests(null); // this run cannot build a bridge
    return {
      create: { tandem: buildMcpEntries("/c", { targetKind: "claude-code", token }).tandem },
      remove: [] as [],
    };
  };

  it("keeps a live Tandem bridge and only updates its env (npx rotate-token)", async () => {
    writeConfig({
      mcpServers: { tandem: { command: node, args: [script], env: { TANDEM_URL: MCP } } },
    });

    await applyConfig(claudeJson(), httpPlan(TOKEN));

    expect(readConfig().mcpServers.tandem).toEqual({
      command: node,
      args: [script],
      env: { TANDEM_URL: MCP, TANDEM_AUTH_TOKEN: TOKEN },
    });
  });

  it("writes the planned HTTP entry over a dead bridge", async () => {
    writeConfig({
      mcpServers: {
        tandem: { command: join(home, "gone", "node"), args: [script], env: { TANDEM_URL: MCP } },
      },
    });

    await applyConfig(claudeJson(), httpPlan(TOKEN));

    expect(readConfig().mcpServers.tandem.type).toBe("http");
  });

  it("writes the planned HTTP entry over a foreign stdio entry", async () => {
    const mine = join(home, "mine.js");
    writeFileSync(mine, "");
    writeConfig({ mcpServers: { tandem: { command: node, args: [mine] } } });

    await applyConfig(claudeJson(), httpPlan());

    expect(readConfig().mcpServers.tandem.type).toBe("http");
    expect(existsSync(mine)).toBe(true);
  });
});

describe("an older install's bridge script moves forward (nvm: the old prefix stays on disk)", () => {
  /** An npm package prefix holding `tandem-editor@<version>`'s bridge. */
  const prefix = (name: string, version: string, pkgName = "tandem-editor") => {
    const pkg = join(home, name, "lib", "node_modules", "tandem-editor");
    const s = join(pkg, "dist", "stdio-bridge", "index.js");
    mkdirSync(join(s, ".."), { recursive: true });
    writeFileSync(s, "// bridge\n");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: pkgName, version }));
    const n = join(home, name, "bin", "node");
    mkdirSync(join(n, ".."), { recursive: true });
    writeFileSync(n, "#!/bin/sh\n");
    return { script: s, node: n };
  };

  it("repoints an older prefix's entry to this install's whole pair", async () => {
    const old = prefix("v22", "0.30.0");
    const cur = prefix("v24", "0.31.0");
    _setClaudeCodeBridgeForTests({ command: cur.node, script: cur.script });
    writeConfig({ mcpServers: { tandem: { command: old.node, args: [old.script], env: {} } } });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readConfig().mcpServers.tandem).toMatchObject({
      command: cur.node,
      args: [cur.script],
    });
    expect(stderr()).toContain("Repaired the tandem entry");
  });

  it("moves forward to a desktop bundle with no package.json, by this build's own version", async () => {
    // The real desktop case: its resource dir ships no package.json, so the
    // current side's version is this build's (`CLI_VERSION`), and the bundled
    // Node does not displace a live system Node.
    const old = prefix("v22", "0.0.1");
    const desktopScript = join(home, "Desktop", "dist", "stdio-bridge", "index.js");
    mkdirSync(join(desktopScript, ".."), { recursive: true });
    writeFileSync(desktopScript, "// bridge\n");
    const bundled = join(home, "Desktop", "node-sidecar-x86_64-pc-windows-msvc.exe");
    writeFileSync(bundled, "");
    _setClaudeCodeBridgeForTests({ command: bundled, script: desktopScript });
    writeConfig({ mcpServers: { tandem: { command: old.node, args: [old.script], env: {} } } });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readConfig().mcpServers.tandem).toMatchObject({
      command: old.node,
      args: [desktopScript],
    });
  });

  it("a forward move never trades a live system Node for the desktop's bundled one", async () => {
    const old = prefix("v22", "0.30.0");
    const desktop = prefix("Tandem", "0.31.0");
    const bundled = join(home, "Tandem", "node-sidecar-aarch64-apple-darwin");
    writeFileSync(bundled, "");
    _setClaudeCodeBridgeForTests({ command: bundled, script: desktop.script });
    writeConfig({ mcpServers: { tandem: { command: old.node, args: [old.script], env: {} } } });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    // The script moves forward; the live system Node stays.
    expect(readConfig().mcpServers.tandem).toMatchObject({
      command: old.node,
      args: [desktop.script],
    });
  });

  it.each([
    ["a NEWER install's script (never backwards)", "0.32.0", "tandem-editor"],
    ["a package.json that is not Tandem's", "0.1.0", "some-other-package"],
  ])("leaves %s alone, byte for byte", async (_label, version, pkgName) => {
    const rec = prefix("v22", version, pkgName);
    const cur = prefix("v24", "0.31.0");
    _setClaudeCodeBridgeForTests({ command: cur.node, script: cur.script });
    writeConfig({ mcpServers: { tandem: { command: rec.node, args: [rec.script], env: {} } } });
    const before = readFileSync(claudeJson());

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readFileSync(claudeJson()).equals(before)).toBe(true);
  });

  it("refuses a script with a dot segment before deriving a path from it (UNC by normalisation)", () => {
    const cur = prefix("v24", "0.31.0");
    expect(bridgeScriptVersion(cur.script)).toBe("0.31.0");
    // On Windows, `posix.join` of this would come out as `/\\evil.example/share/...`.
    expect(bridgeScriptVersion("/./\\evil.example/share/x/dist/stdio-bridge/index.js")).toBeNull();
    if (process.platform !== "win32") {
      // A Windows-shaped path on POSIX never reads the working directory's file.
      expect(bridgeScriptVersion("C:\\tandem\\dist\\stdio-bridge\\index.js")).toBeNull();
    }
    expect(
      bridgeScriptVersion(
        `${home}/x/../v24/lib/node_modules/tandem-editor/dist/stdio-bridge/index.js`,
      ),
    ).toBeNull();
  });

  it("leaves a script whose version cannot be told alone (the desktop bundle ships no package.json)", async () => {
    const desktop = join(home, "Tandem", "dist", "stdio-bridge", "index.js");
    mkdirSync(join(desktop, ".."), { recursive: true });
    writeFileSync(desktop, "// bridge\n");
    const cur = prefix("v24", "0.31.0");
    _setClaudeCodeBridgeForTests({ command: cur.node, script: cur.script });
    writeConfig({ mcpServers: { tandem: { command: node, args: [desktop], env: {} } } });
    const before = readFileSync(claudeJson());

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readFileSync(claudeJson()).equals(before)).toBe(true);
  });
});

describe("the Linux AppImage's bridge copies", () => {
  const appData = () => process.env.TANDEM_APP_DATA_DIR as string;
  const copy = (v: string) => join(appData(), "bin", v, "dist", "stdio-bridge", "index.js");
  const makeCopy = (v: string) => {
    mkdirSync(join(copy(v), ".."), { recursive: true });
    writeFileSync(copy(v), "// copy\n");
  };

  it("moves an entry FORWARD from an older version's copy to this version's", async () => {
    makeCopy("0.31.0");
    makeCopy("0.32.0");
    _setClaudeCodeBridgeForTests({ command: node, script: copy("0.32.0") });
    writeConfig({ mcpServers: { tandem: { command: node, args: [copy("0.31.0")] } } });

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readConfig().mcpServers.tandem.args).toEqual([copy("0.32.0")]);
  });

  it("never moves an entry BACK onto an older version's copy (two AppImages side by side)", async () => {
    makeCopy("0.32.0");
    makeCopy("0.33.0");
    _setClaudeCodeBridgeForTests({ command: node, script: copy("0.32.0") });
    writeConfig({ mcpServers: { tandem: { command: node, args: [copy("0.33.0")] } } });
    const before = readFileSync(claudeJson());

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readFileSync(claudeJson()).equals(before)).toBe(true);
  });
});

describe("the bridge repair leaves a hand-copied bridge alone", () => {
  it.each([
    ["an extra arg", { args: ["SCRIPT", "--x"] }],
    ["its own env key", { args: ["SCRIPT"], env: { NODE_OPTIONS: "--x" } }],
  ])("%s", async (_name, over) => {
    const entry = {
      command: join(home, "gone", "node"),
      ...over,
      args: (over.args as string[]).map((a) => (a === "SCRIPT" ? script : a)),
    };
    writeConfig({ mcpServers: { tandem: entry } });
    const before = readFileSync(claudeJson());

    await refreshAllMcpEntryBinaries({ homeOverride: home });

    expect(readFileSync(claudeJson()).equals(before)).toBe(true);
  });
});
