import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALWAYS_DISABLED_PLUGIN_KEY,
  buildRunMcpConfig,
  buildRunSettings,
  collectTandemPluginKeys,
  ensureLauncherDir,
  loopbackBaseUrl,
  RUN_FILE_SWEEP_AGE_MS,
  type RunFileAcl,
  RunFileError,
  readHostileSettingsKeys,
  realRunFileAcl,
  resetVerifiedLauncherDirsForTests,
  runFileReadsBack,
  runFileText,
  SETTINGS_READ_MAX_BYTES,
  SETTINGS_READ_MAX_KEYS,
  sweepRunFiles,
  writeRunFile,
} from "../../../src/server/launcher/run-files.js";
import { stripComments } from "../../helpers/src-tree.js";

/**
 * The launcher's run files as units (#2358 PR 3a, R1.2–R1.6, R1.9; Rulings
 * D3, D13, D14). The spawn path that uses them is
 * owner-handle-spawn.test.ts. Link cases need `symlink`, which POSIX always
 * allows; on Windows they run in run-files-acl-win.test.ts under the
 * `windows-acl-proof` job, with real ACLs.
 */

const POSIX = process.platform !== "win32";
const NO_ACL: RunFileAcl = {
  assertOwned: async () => {},
  lockDir: async () => {},
  verifyNoBroadAce: async () => {},
};

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "run-files-")));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the run MCP config (R1.2) and settings (R1.3)", () => {
  it("names one server, tandem, with the handle, both URL variables and no token", () => {
    const cfg = buildRunMcpConfig({
      nodePath: "/n/node",
      bridgeScript: "/b/index.js",
      baseUrl: "http://127.0.0.1:4000",
      handle: "th_x",
    });
    expect(Object.keys(cfg.mcpServers)).toEqual(["tandem"]);
    expect(cfg.mcpServers.tandem).toEqual({
      command: "/n/node",
      args: ["/b/index.js"],
      env: {
        TANDEM_OWNER_HANDLE: "th_x",
        TANDEM_OWNER_HANDLE_URL: "http://127.0.0.1:4000",
        TANDEM_URL: "http://127.0.0.1:4000",
        CLAUDE_PLUGIN_OPTION_SERVER_URL: "",
        NODE_OPTIONS: "",
        NODE_DEBUG: "",
      },
    });
    expect(JSON.stringify(cfg)).not.toMatch(/AUTH_TOKEN|Bearer/);
  });

  it("the settings file sets each key false and holds nothing else", () => {
    expect(buildRunSettings(["tandem@a", "tandem@b"])).toEqual({
      enabledPlugins: { "tandem@a": false, "tandem@b": false },
    });
  });

  it("the base URL is the bound loopback literal, IPv6 in brackets, else null (D14)", () => {
    expect(loopbackBaseUrl({ address: "127.0.0.1", port: 41 })).toBe("http://127.0.0.1:41");
    const v6 = loopbackBaseUrl({ address: "::1", port: 42 });
    expect(v6).toBe("http://[::1]:42");
    expect(new URL(`${v6}/mcp`).port).toBe("42");
    expect(loopbackBaseUrl({ address: "0.0.0.0", port: 42 })).toBeNull();
    expect(loopbackBaseUrl({ address: "192.168.1.2", port: 42 })).toBeNull();
    expect(loopbackBaseUrl({ address: "127.0.0.1", port: 0 })).toBeNull();
    expect(loopbackBaseUrl(null)).toBeNull();
  });
});

describe("reading the settings files (R1.4, Ruling D3)", () => {
  function writeSettings(dir: string, name: string, value: unknown) {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    const file = path.join(dir, ".claude", name);
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  }

  it("collects tandem@ keys set true from user, project and local files, plus tandem@tandem-editor", async () => {
    const home = path.join(root, "home");
    const cwd = path.join(root, "doc");
    writeSettings(home, "settings.json", {
      enabledPlugins: { "tandem@synced": true, "tandem@off": false, "other@x": true },
    });
    writeSettings(cwd, "settings.json", { enabledPlugins: { "tandem@proj": true } });
    writeSettings(cwd, "settings.local.json", {
      enabledPlugins: { "tandem@local": true, "tandemx@foo": true },
    });
    const keys = await collectTandemPluginKeys({ env: {}, cwd, home });
    expect(keys).toEqual(
      [ALWAYS_DISABLED_PLUGIN_KEY, "tandem@local", "tandem@proj", "tandem@synced"].sort(),
    );
    const settings = buildRunSettings(keys);
    expect(Object.keys(settings.enabledPlugins)).not.toContain("other@x");
    expect(Object.keys(settings.enabledPlugins)).not.toContain("tandemx@foo");
  });

  it("follows CLAUDE_CONFIG_DIR for the user file when it is set", async () => {
    const cfgDir = path.join(root, "cfg");
    fs.mkdirSync(cfgDir);
    fs.writeFileSync(
      path.join(cfgDir, "settings.json"),
      JSON.stringify({ enabledPlugins: { "tandem@cfg": true } }),
    );
    const home = path.join(root, "home");
    writeSettings(home, "settings.json", { enabledPlugins: { "tandem@home": true } });
    const keys = await collectTandemPluginKeys({
      env: { CLAUDE_CONFIG_DIR: cfgDir },
      cwd: path.join(root, "nowhere"),
      home,
    });
    expect(keys).toEqual([ALWAYS_DISABLED_PLUGIN_KEY, "tandem@cfg"].sort());
  });

  it("drops an oversized file, one with too many keys, and a UNC path; the rest still count", async () => {
    const cwd = path.join(root, "doc");
    const big = {
      enabledPlugins: { "tandem@big": true },
      pad: "x".repeat(SETTINGS_READ_MAX_BYTES),
    };
    writeSettings(cwd, "settings.json", big);
    const many: Record<string, boolean> = { "tandem@many": true };
    for (let i = 0; i < SETTINGS_READ_MAX_KEYS; i++) many[`p${i}@m`] = true;
    writeSettings(cwd, "settings.local.json", { enabledPlugins: many });
    expect(await readHostileSettingsKeys(path.join(cwd, ".claude", "settings.json"))).toEqual([]);
    expect(await readHostileSettingsKeys(path.join(cwd, ".claude", "settings.local.json"))).toEqual(
      [],
    );
    expect(await readHostileSettingsKeys("\\\\server\\share\\.claude\\settings.json")).toEqual([]);
    expect(await readHostileSettingsKeys("//server/share/.claude/settings.json")).toEqual([]);
    expect(await collectTandemPluginKeys({ env: {}, cwd, home: path.join(root, "h") })).toEqual([
      ALWAYS_DISABLED_PLUGIN_KEY,
    ]);
  });

  it("drops malformed JSON and a directory in a file's place", async () => {
    const cwd = path.join(root, "doc");
    const file = writeSettings(cwd, "settings.json", "{not json");
    expect(await readHostileSettingsKeys(file)).toEqual([]);
    fs.mkdirSync(path.join(cwd, ".claude", "settings.local.json"));
    expect(await readHostileSettingsKeys(path.join(cwd, ".claude", "settings.local.json"))).toEqual(
      [],
    );
  });

  it.runIf(POSIX)(
    "never reads through a link: the file, or the .claude folder (POSIX)",
    async () => {
      const real = path.join(root, "real");
      const target = writeSettings(real, "settings.json", { enabledPlugins: { "tandem@l": true } });
      expect(await readHostileSettingsKeys(target)).toEqual(["tandem@l"]);
      const cwd = path.join(root, "doc");
      fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
      fs.symlinkSync(target, path.join(cwd, ".claude", "settings.json"));
      expect(await readHostileSettingsKeys(path.join(cwd, ".claude", "settings.json"))).toEqual([]);
      const cwd2 = path.join(root, "doc2");
      fs.mkdirSync(cwd2);
      fs.symlinkSync(path.join(real, ".claude"), path.join(cwd2, ".claude"));
      expect(await readHostileSettingsKeys(path.join(cwd2, ".claude", "settings.json"))).toEqual(
        [],
      );
    },
  );

  it.runIf(POSIX)("a FIFO in the file's place neither blocks nor counts (POSIX)", async () => {
    const cwd = path.join(root, "doc");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    const fifo = path.join(cwd, ".claude", "settings.json");
    const { execFileSync } = await import("node:child_process");
    execFileSync("mkfifo", [fifo]);
    const started = Date.now();
    expect(await collectTandemPluginKeys({ env: {}, cwd, home: path.join(root, "h") })).toEqual([
      ALWAYS_DISABLED_PLUGIN_KEY,
    ]);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe("writing the run files (R1.6)", () => {
  it("creates launcher/ 0700 and each file 0600 at a random final name", async () => {
    const dir = path.join(root, "launcher");
    expect(await ensureLauncherDir(dir, { create: true, acl: NO_ACL })).toBe(true);
    const a = await writeRunFile(dir, "mcp", { a: 1 }, NO_ACL);
    const b = await writeRunFile(dir, "settings", { b: 2 }, NO_ACL);
    expect(path.basename(a)).toMatch(/^tandem-run-mcp-[0-9a-f]{32}\.json$/);
    expect(path.basename(b)).toMatch(/^tandem-run-settings-[0-9a-f]{32}\.json$/);
    expect(JSON.parse(fs.readFileSync(a, "utf8"))).toEqual({ a: 1 });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    if (POSIX) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(a).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(POSIX)("tightens an existing launcher/ that is too open (POSIX)", async () => {
    const dir = path.join(root, "launcher");
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    await ensureLauncherDir(dir, { create: true, acl: NO_ACL });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.runIf(POSIX)("refuses a launcher/ that is a link (POSIX)", async () => {
    const real = path.join(root, "elsewhere");
    fs.mkdirSync(real);
    const dir = path.join(root, "launcher");
    fs.symlinkSync(real, dir);
    await expect(ensureLauncherDir(dir, { create: true, acl: NO_ACL })).rejects.toMatchObject({
      step: "launcher-dir-is-a-link",
    });
  });

  it("refuses a launcher/ that is a file", async () => {
    const dir = path.join(root, "launcher");
    fs.writeFileSync(dir, "");
    await expect(ensureLauncherDir(dir, { create: true, acl: NO_ACL })).rejects.toBeInstanceOf(
      RunFileError,
    );
  });

  it("refuses when the owner check fails", async () => {
    const dir = path.join(root, "launcher");
    const acl: RunFileAcl = { ...NO_ACL, assertOwned: async () => Promise.reject(new Error("no")) };
    if (POSIX) {
      // POSIX judges by uid; the injected Windows step is not consulted.
      expect(await ensureLauncherDir(dir, { create: true, acl })).toBe(true);
    } else {
      await expect(ensureLauncherDir(dir, { create: true, acl })).rejects.toMatchObject({
        step: "launcher-dir-not-owned",
      });
    }
  });

  it("a write that fails leaves nothing behind", async () => {
    const dir = path.join(root, "launcher");
    await ensureLauncherDir(dir, { create: true, acl: NO_ACL });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(writeRunFile(dir, "mcp", circular, NO_ACL)).rejects.toBeInstanceOf(RunFileError);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

/**
 * The pre-spawn read-back (smoke S1; Bryan's "Guard it before the flip
 * (Recommended)", 2026-11-26). A pair written by `writeRunFile` as the
 * supervisor writes it, then damaged the ways S1 measured. The spawn path's
 * refusal and restart are in owner-handle-spawn.test.ts.
 */
describe("the run files' read-back before the spawn (S1)", () => {
  async function writePair() {
    const dir = path.join(root, "launcher");
    await ensureLauncherDir(dir, { create: true, acl: NO_ACL });
    const mcpValue = buildRunMcpConfig({
      nodePath: "/usr/bin/node",
      bridgeScript: "/opt/tandem/bridge.js",
      baseUrl: "http://127.0.0.1:3479",
      handle: `th_${"A".repeat(32)}`,
    });
    const settingsValue = buildRunSettings([ALWAYS_DISABLED_PLUGIN_KEY, "tandem@other"]);
    return {
      mcp: { file: await writeRunFile(dir, "mcp", mcpValue, NO_ACL), text: runFileText(mcpValue) },
      settings: {
        file: await writeRunFile(dir, "settings", settingsValue, NO_ACL),
        text: runFileText(settingsValue),
      },
    };
  }
  /** Truncated mid-file, as S1 did it: no longer parses. */
  function truncate(file: string) {
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.slice(0, Math.floor(text.length / 2)));
    expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).toThrow();
  }

  it("a valid pair reads back, and what is on disk is exactly the text written", async () => {
    const pair = await writePair();
    expect(runFileReadsBack(pair.mcp.file, pair.mcp.text)).toBe(true);
    expect(runFileReadsBack(pair.settings.file, pair.settings.text)).toBe(true);
    expect(fs.readFileSync(pair.settings.file, "utf8")).toBe(pair.settings.text);
  });

  it("a missing settings file is refused", async () => {
    const pair = await writePair();
    fs.unlinkSync(pair.settings.file);
    expect(runFileReadsBack(pair.settings.file, pair.settings.text)).toBe(false);
    expect(runFileReadsBack(pair.mcp.file, pair.mcp.text)).toBe(true);
  });

  it("a truncated settings file is refused", async () => {
    const pair = await writePair();
    truncate(pair.settings.file);
    expect(runFileReadsBack(pair.settings.file, pair.settings.text)).toBe(false);
  });

  it("a truncated MCP config is refused", async () => {
    const pair = await writePair();
    truncate(pair.mcp.file);
    expect(runFileReadsBack(pair.mcp.file, pair.mcp.text)).toBe(false);
  });

  it("a file of the right length that parses but holds other values is refused", async () => {
    const pair = await writePair();
    // Re-enables a plugin key, at the same length, and still parses.
    const other = pair.settings.text.replace("false", "true ");
    expect(other.length).toBe(pair.settings.text.length);
    expect(() => JSON.parse(other)).not.toThrow();
    fs.writeFileSync(pair.settings.file, other);
    expect(runFileReadsBack(pair.settings.file, pair.settings.text)).toBe(false);
  });

  it.runIf(POSIX)("a link at the name is refused, even to the right text (POSIX)", async () => {
    const pair = await writePair();
    const elsewhere = path.join(root, "elsewhere.json");
    fs.writeFileSync(elsewhere, pair.settings.text);
    fs.unlinkSync(pair.settings.file);
    fs.symlinkSync(elsewhere, pair.settings.file);
    expect(runFileReadsBack(pair.settings.file, pair.settings.text)).toBe(false);
  });
});

/**
 * Runs `fn` with `process.platform` reading `"win32"`, restored in `finally`
 * (precedent: tests/server/file-io/private-dir.test.ts), so the Windows branch
 * of `ensureLauncherDir` and `writeRunFile` runs on Linux with a recording
 * seam. Nothing here reaches acl-win: every ACL step is the seam's.
 */
async function asWin32<T>(fn: () => Promise<T>): Promise<T> {
  const prev = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    return await fn();
  } finally {
    if (prev) Object.defineProperty(process, "platform", prev);
  }
}

describe("the Windows folder check makes one ACL read, the lock's own (#2440)", () => {
  beforeEach(() => resetVerifiedLauncherDirsForTests());
  afterEach(() => resetVerifiedLauncherDirsForTests());

  function recording(lock: () => Promise<void> = async () => {}) {
    const calls: string[] = [];
    const acl: RunFileAcl = {
      assertOwned: async (p) => {
        calls.push(`assertOwned:${p}`);
      },
      lockDir: async (p) => {
        calls.push(`lockDir:${p}`);
        await lock();
      },
      verifyNoBroadAce: async (p) => {
        calls.push(`verifyNoBroadAce:${p}`);
      },
    };
    return { calls, acl };
  }

  it("a passing lock: the owner check then the lock, no separate folder read; cached after", async () => {
    const dir = path.join(root, "launcher");
    const { calls, acl } = recording();
    await asWin32(async () => {
      expect(await ensureLauncherDir(dir, { create: true, acl })).toBe(true);
      expect(calls).toEqual([`assertOwned:${dir}`, `lockDir:${dir}`]);
      expect(await ensureLauncherDir(dir, { create: true, acl })).toBe(true);
    });
    expect(calls).toEqual([`assertOwned:${dir}`, `lockDir:${dir}`]);
  });

  it("a refusing lock: launcher-dir-acl, and nothing is cached", async () => {
    const dir = path.join(root, "launcher");
    const { calls, acl } = recording(async () => Promise.reject(new Error("broad ACE")));
    await asWin32(async () => {
      await expect(ensureLauncherDir(dir, { create: true, acl })).rejects.toMatchObject({
        step: "launcher-dir-acl",
      });
      await expect(ensureLauncherDir(dir, { create: true, acl })).rejects.toMatchObject({
        step: "launcher-dir-acl",
      });
    });
    expect(calls).toEqual([
      `assertOwned:${dir}`,
      `lockDir:${dir}`,
      `assertOwned:${dir}`,
      `lockDir:${dir}`,
    ]);
  });

  it("each run file is checked while still empty, and a refusing check leaves the folder empty", async () => {
    // A regression guard on writeRunFile, which #2440 leaves unchanged: the
    // per-file check still runs before the write.
    const dir = path.join(root, "launcher");
    const sizes: Record<string, number> = {};
    let refuse = false;
    const acl: RunFileAcl = {
      ...NO_ACL,
      verifyNoBroadAce: async (p) => {
        if (!p.endsWith(".json")) return;
        sizes[path.basename(p).startsWith("tandem-run-mcp-") ? "mcp" : "settings"] =
          fs.statSync(p).size;
        if (refuse) throw new Error("broad ACE");
      },
    };
    await asWin32(async () => {
      await ensureLauncherDir(dir, { create: true, acl });
      const a = await writeRunFile(dir, "mcp", { a: 1 }, acl);
      const b = await writeRunFile(dir, "settings", { b: 2 }, acl);
      expect(sizes).toEqual({ mcp: 0, settings: 0 });
      expect(fs.statSync(a).size).toBeGreaterThan(0);
      expect(fs.statSync(b).size).toBeGreaterThan(0);
      fs.rmSync(a);
      fs.rmSync(b);
      refuse = true;
      await expect(writeRunFile(dir, "mcp", { a: 1 }, acl)).rejects.toMatchObject({
        step: "mcp-acl",
      });
      await expect(writeRunFile(dir, "settings", { b: 2 }, acl)).rejects.toMatchObject({
        step: "settings-acl",
      });
    });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("source pin: the real lock is setRestrictiveAcl, which re-reads unconditionally after icacls", () => {
    const runFiles = stripComments(
      fs.readFileSync(path.resolve("src/server/launcher/run-files.ts"), "utf8"),
    );
    const lockDir = /\blockDir:\s*\(p\)\s*=>([\s\S]*?)\bverifyNoBroadAce:/.exec(runFiles)?.[1];
    expect(lockDir, "realRunFileAcl.lockDir not found").toBeDefined();
    // The whole body is the call: no condition can route around it.
    expect(lockDir?.trim()).toMatch(/^setRestrictiveAcl\(p, \{[^}]*\}\),$/);
    expect(realRunFileAcl.lockDir).toBeTypeOf("function");

    const acl = stripComments(
      fs.readFileSync(path.resolve("src/server/integrations/acl-win.ts"), "utf8"),
    );
    const start = acl.indexOf("export async function setRestrictiveAcl(");
    expect(start, "setRestrictiveAcl not found").toBeGreaterThanOrEqual(0);
    // The body: from the first `{` after the parameter list's `)` + `: Promise<void>`.
    const bodyOpen = acl.indexOf("{", acl.indexOf("Promise<void>", start));
    let depth = 0;
    let bodyClose = -1;
    for (let i = bodyOpen; i < acl.length; i++) {
      if (acl[i] === "{") depth++;
      else if (acl[i] === "}" && --depth === 0) {
        bodyClose = i;
        break;
      }
    }
    expect(bodyClose).toBeGreaterThan(bodyOpen);
    const body = acl.slice(bodyOpen + 1, bodyClose);
    const stmt = "await assertNoBroadAce(path, { signal });";
    const at = body.indexOf(stmt);
    expect(at, "the re-read statement is missing").toBeGreaterThanOrEqual(0);
    expect(body.indexOf(stmt, at + 1), "the re-read appears twice").toBe(-1);
    expect(at, "the re-read precedes icacls").toBeGreaterThan(body.indexOf("icacls.exe"));
    // Top level: no open brace, paren or bracket before it within the body.
    let braces = 0;
    let parens = 0;
    for (const ch of body.slice(0, at)) {
      if (ch === "{") braces++;
      else if (ch === "}") braces--;
      else if (ch === "(" || ch === "[") parens++;
      else if (ch === ")" || ch === "]") parens--;
    }
    expect({ braces, parens }).toEqual({ braces: 0, parens: 0 });
    // No early exit at the top level between the platform guard and the
    // re-read (`if (cond) return;` before it would skip it for some callers).
    const guard = 'if (process.platform !== "win32") return;';
    const guardAt = body.indexOf(guard);
    expect(guardAt, "the platform guard moved").toBeGreaterThanOrEqual(0);
    expect(body.slice(guardAt + guard.length, at)).not.toMatch(/\breturn\b/);
    // A whole statement of its own: not the tail of a braceless `if`/`else`.
    const before = body.slice(0, at).trimEnd();
    expect(before.at(-1), "the re-read is not a statement of its own").toMatch(/[;}{]/);
    expect(before).not.toMatch(/\b(?:if|else|while|for)\s*(?:\([^;]*\))?$/);
  });
});

describe("the boot sweep (R1.9, Ruling D13)", () => {
  const OLD = Date.now() - RUN_FILE_SWEEP_AGE_MS - 60_000;
  function age(file: string, at: number) {
    fs.utimesSync(file, at / 1000, at / 1000);
  }

  it("deletes a matching file older than an hour; keeps a young one, a stranger, a subdirectory's", async () => {
    const dir = path.join(root, "launcher");
    fs.mkdirSync(dir, { mode: 0o700 });
    const old = path.join(dir, `tandem-run-mcp-${"a".repeat(32)}.json`);
    const oldSettings = path.join(dir, `tandem-run-settings-${"b".repeat(32)}.json`);
    const young = path.join(dir, `tandem-run-mcp-${"c".repeat(32)}.json`);
    const stranger = path.join(dir, "notes.json");
    const almost = path.join(dir, `tandem-run-mcp-${"d".repeat(31)}.json`);
    fs.mkdirSync(path.join(dir, "sub"));
    const nested = path.join(dir, "sub", `tandem-run-mcp-${"e".repeat(32)}.json`);
    for (const f of [old, oldSettings, young, stranger, almost, nested]) fs.writeFileSync(f, "{}");
    for (const f of [old, oldSettings, stranger, almost, nested]) age(f, OLD);
    expect(await sweepRunFiles(dir, { acl: NO_ACL })).toBe(2);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(oldSettings)).toBe(false);
    for (const f of [young, stranger, almost, nested]) expect(fs.existsSync(f)).toBe(true);
  });

  it("does nothing when launcher/ is absent, and never creates it", async () => {
    const dir = path.join(root, "launcher");
    expect(await sweepRunFiles(dir, { acl: NO_ACL })).toBe(0);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it.runIf(POSIX)("follows no link and refuses a launcher/ that is a link (POSIX)", async () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    const victim = path.join(outside, `tandem-run-mcp-${"f".repeat(32)}.json`);
    fs.writeFileSync(victim, "{}");
    age(victim, OLD);
    const linkedDir = path.join(root, "launcher-link");
    fs.symlinkSync(outside, linkedDir);
    expect(await sweepRunFiles(linkedDir, { acl: NO_ACL })).toBe(0);
    expect(fs.existsSync(victim)).toBe(true);

    const dir = path.join(root, "launcher");
    fs.mkdirSync(dir, { mode: 0o700 });
    const link = path.join(dir, `tandem-run-settings-${"0".repeat(32)}.json`);
    fs.symlinkSync(victim, link);
    expect(await sweepRunFiles(dir, { acl: NO_ACL })).toBe(0);
    expect(fs.existsSync(victim)).toBe(true);
  });
});
