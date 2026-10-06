/**
 * Tests for `uninstall-scrub` CLI module and `win-path-guard`.
 *
 * vi.mock calls are hoisted to file top by Vitest — factories cannot reference
 * variables. We use module-level vi.fn() stubs that beforeEach reconfigures
 * via .mockResolvedValue / .mockReturnValue.
 */

import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_PATHS } from "../helpers/unc-fixtures.js";

// ── Top-level stubs (referenced by vi.mock factories) ────────────────────────

const _readdirSpy = vi.fn();
const _readFileSpy = vi.fn();
const _writeFileSpy = vi.fn().mockResolvedValue(undefined);
const _renameSpy = vi.fn().mockResolvedValue(undefined);
const _unlinkSpy = vi.fn().mockResolvedValue(undefined);
const _lstatSpy = vi.fn();
const _realpathSpy = vi.fn();
const _statSpy = vi.fn();
const _closeSpy = vi.fn().mockResolvedValue(undefined);
const _openSpy = vi.fn().mockResolvedValue({ close: _closeSpy });

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal<typeof import("node:fs")>()) as typeof import("node:fs");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: _readdirSpy,
      readFile: _readFileSpy,
      writeFile: _writeFileSpy,
      rename: _renameSpy,
      unlink: _unlinkSpy,
      lstat: _lstatSpy,
      realpath: _realpathSpy,
      stat: _statSpy,
      open: _openSpy,
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNotFoundError(): NodeJS.ErrnoException {
  const e = Object.assign(new Error("ENOENT: no such file or directory"), {
    code: "ENOENT",
  }) as NodeJS.ErrnoException;
  return e;
}

function notSymlink() {
  return { isSymbolicLink: () => false };
}

// ── removeInstalledPlugins ────────────────────────────────────────────────────

describe("removeInstalledPlugins", () => {
  it("removes only mcpServers.tandem and leaves context7 intact", async () => {
    const { removeInstalledPlugins } = await import("../../src/cli/uninstall-scrub.js");

    const obj = {
      mcpServers: {
        context7: { type: "stdio" },
        tandem: { type: "stdio" },
      },
    } as Record<string, unknown>;

    const changed = removeInstalledPlugins(obj);
    expect(changed).toBe(true);

    const servers = obj.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("context7");
    expect(servers).not.toHaveProperty("tandem");
  });

  it("returns false when tandem entry is absent", async () => {
    const { removeInstalledPlugins } = await import("../../src/cli/uninstall-scrub.js");

    const obj = { mcpServers: { context7: { type: "stdio" } } } as Record<string, unknown>;
    const changed = removeInstalledPlugins(obj);
    expect(changed).toBe(false);
  });
});

// ── removeKnownMarketplaces ───────────────────────────────────────────────────

describe("removeKnownMarketplaces", () => {
  it("removes marketplaces.tandem and leaves others intact", async () => {
    const { removeKnownMarketplaces } = await import("../../src/cli/uninstall-scrub.js");

    const obj = {
      marketplaces: {
        tandem: { id: "tandem" },
        other: { id: "other" },
      },
    } as Record<string, unknown>;

    const changed = removeKnownMarketplaces(obj);
    expect(changed).toBe(true);

    const mp = obj.marketplaces as Record<string, unknown>;
    expect(mp).toHaveProperty("other");
    expect(mp).not.toHaveProperty("tandem");
  });
});

// ── removeCoworkSettings ──────────────────────────────────────────────────────

describe("removeCoworkSettings", () => {
  it("removes tandem@tandem from array form of enabledPlugins", async () => {
    const { removeCoworkSettings } = await import("../../src/cli/uninstall-scrub.js");

    const obj = {
      enabledPlugins: ["context7@context7", "tandem@tandem"],
    } as Record<string, unknown>;
    const changed = removeCoworkSettings(obj);
    expect(changed).toBe(true);
    expect(obj.enabledPlugins).toEqual(["context7@context7"]);
  });

  it("removes tandem@tandem from object form of enabledPlugins", async () => {
    const { removeCoworkSettings } = await import("../../src/cli/uninstall-scrub.js");

    const obj = {
      enabledPlugins: { "context7@context7": true, "tandem@tandem": true },
    } as Record<string, unknown>;
    const changed = removeCoworkSettings(obj);
    expect(changed).toBe(true);
    const ep = obj.enabledPlugins as Record<string, unknown>;
    expect(ep).toHaveProperty("context7@context7");
    expect(ep).not.toHaveProperty("tandem@tandem");
  });
});

// ── rewriteJson ───────────────────────────────────────────────────────────────

describe("rewriteJson", () => {
  beforeEach(() => {
    _readFileSpy.mockReset();
    _writeFileSpy.mockReset().mockResolvedValue(undefined);
    _renameSpy.mockReset().mockResolvedValue(undefined);
    _unlinkSpy.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false on ENOENT (file absent)", async () => {
    _readFileSpy.mockRejectedValue(makeNotFoundError());

    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      warnings: vi.fn(() => 0),
      close: async () => {},
    };
    const result = await rewriteJson("/fake/path.json", () => true, logger);
    expect(result).toBe(false);
    expect(_writeFileSpy).not.toHaveBeenCalled();
  });

  it("logs malformed JSON without the parse-error detail (token-bearing files)", async () => {
    // V8 SyntaxError messages embed a source snippet; if that snippet held a
    // bearer token it would land in uninstall.log. The warn line must carry
    // the path only.
    _readFileSpy.mockResolvedValue('{"mcpServers": {"tandem": {"env": {"SECRET_TOKEN_VALUE"');

    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      warnings: vi.fn(() => 0),
      close: async () => {},
    };
    const result = await rewriteJson("/fake/installed_plugins.json", () => true, logger);
    expect(result).toBe(false);
    expect(_writeFileSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    const line = logger.warn.mock.calls[0][0] as string;
    expect(line).toContain("/fake/installed_plugins.json");
    expect(line).not.toContain("SECRET_TOKEN_VALUE");
    expect(line).not.toContain("Unexpected");
  });

  it("writes and renames when mutate returns true", async () => {
    const initial = JSON.stringify({ mcpServers: { tandem: {} } });
    _readFileSpy.mockResolvedValue(initial);

    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      warnings: vi.fn(() => 0),
      close: async () => {},
    };
    const result = await rewriteJson(
      "/fake/installed_plugins.json",
      (obj) => {
        delete (obj.mcpServers as Record<string, unknown>).tandem;
        return true;
      },
      logger,
    );
    expect(result).toBe(true);
    expect(_writeFileSpy).toHaveBeenCalledOnce();
    expect(_renameSpy).toHaveBeenCalledOnce();
  });
});

// ── rewriteJson: the cross-language Cowork lock (#1600) ─────────────────────

/**
 * Every Rust writer of the three Cowork files takes `with_locked_json`'s lock on
 * a sibling `.<file>.tandem-lock`; the npm scrub was the one writer that did
 * not. These pin the Node half against mocks. The real interop — that libuv's
 * `UV_FS_O_EXLOCK` (`0x10000000`) open actually excludes fs2 and vice versa — is
 * `src-tauri/src/cowork_atomic_json.rs`'s `lock_interop_tests`, on the windows
 * `rust-test` leg.
 */
describe("rewriteJson — takes the Cowork lock (#1600)", () => {
  const FILE = "/fake/installed_plugins.json";
  const LOCK = path.join("/fake", ".installed_plugins.json.tandem-lock");
  const UV_FS_O_EXLOCK = 0x10000000;
  const withTandem = JSON.stringify({ mcpServers: { tandem: {} } });

  const makeLogger = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    warnings: vi.fn(() => 0),
    close: async () => {},
  });
  const dropTandem = (obj: Record<string, unknown>) => {
    const servers = obj.mcpServers as Record<string, unknown> | undefined;
    if (!servers || !("tandem" in servers)) return false;
    delete servers.tandem;
    return true;
  };
  const errno = (code: string) => Object.assign(new Error(code), { code });

  let fsConstants: typeof import("node:fs").constants;

  beforeEach(async () => {
    fsConstants = (await vi.importActual<typeof import("node:fs")>("node:fs")).constants;
    _readFileSpy.mockReset().mockResolvedValue(withTandem);
    _writeFileSpy.mockReset().mockResolvedValue(undefined);
    _renameSpy.mockReset().mockResolvedValue(undefined);
    _unlinkSpy.mockReset().mockResolvedValue(undefined);
    _closeSpy.mockReset().mockResolvedValue(undefined);
    _openSpy.mockReset().mockResolvedValue({ close: _closeSpy });
  });

  it("opens the sibling lockfile with share-mode-0 flags", async () => {
    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    await rewriteJson(FILE, dropTandem, makeLogger(), { sleep: vi.fn() });
    expect(_openSpy).toHaveBeenCalledOnce();
    expect(_openSpy).toHaveBeenCalledWith(
      LOCK,
      fsConstants.O_RDWR | fsConstants.O_CREAT | UV_FS_O_EXLOCK,
    );
  });

  it("pre-checks unlocked, then re-reads and writes under the lock", async () => {
    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    expect(await rewriteJson(FILE, dropTandem, makeLogger(), { sleep: vi.fn() })).toBe(true);
    expect(_readFileSpy).toHaveBeenCalledTimes(2);
    const [preRead, lockedRead] = _readFileSpy.mock.invocationCallOrder;
    const order = [
      preRead,
      _openSpy.mock.invocationCallOrder[0],
      lockedRead,
      _writeFileSpy.mock.invocationCallOrder[0],
      _renameSpy.mock.invocationCallOrder[0],
      _closeSpy.mock.invocationCallOrder[0],
    ];
    expect(order.every((n) => typeof n === "number")).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("waits on Rust's backoff schedule while the lockfile is busy", async () => {
    _openSpy
      .mockRejectedValueOnce(errno("EBUSY"))
      .mockRejectedValueOnce(errno("EBUSY"))
      .mockResolvedValueOnce({ close: _closeSpy });
    const sleep = vi.fn();
    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    expect(await rewriteJson(FILE, dropTandem, makeLogger(), { sleep })).toBe(true);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([200, 500]);
    expect(_writeFileSpy).toHaveBeenCalledOnce();
  });

  it("gives up with a thrown, path-only error when the lock stays busy", async () => {
    _openSpy.mockRejectedValue(errno("EBUSY"));
    const sleep = vi.fn();
    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    await expect(rewriteJson(FILE, dropTandem, makeLogger(), { sleep })).rejects.toThrow(FILE);
    expect(_readFileSpy).toHaveBeenCalledOnce();
    expect(_writeFileSpy).not.toHaveBeenCalled();
    expect(_renameSpy).not.toHaveBeenCalled();
    const total = sleep.mock.calls.reduce((sum, c) => sum + (c[0] as number), 0);
    expect(total).toBeGreaterThanOrEqual(30_000);
  });

  it("never writes without the lock when the lock open fails otherwise", async () => {
    _openSpy.mockRejectedValueOnce(errno("EPERM"));
    const sleep = vi.fn();
    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    await expect(rewriteJson(FILE, dropTandem, makeLogger(), { sleep })).rejects.toThrow(FILE);
    expect(_readFileSpy).toHaveBeenCalledOnce();
    expect(_writeFileSpy).not.toHaveBeenCalled();
    expect(_renameSpy).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns false silently when the directory vanished before the lock", async () => {
    _openSpy.mockRejectedValueOnce(errno("ENOENT"));
    const logger = makeLogger();
    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    expect(await rewriteJson(FILE, dropTandem, logger, { sleep: vi.fn() })).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(_writeFileSpy).not.toHaveBeenCalled();
    expect(_renameSpy).not.toHaveBeenCalled();
  });

  it("creates no lockfile when the data file is absent", async () => {
    _readFileSpy.mockReset().mockRejectedValue(makeNotFoundError());
    const logger = makeLogger();
    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    expect(await rewriteJson(FILE, dropTandem, logger, { sleep: vi.fn() })).toBe(false);
    expect(_openSpy).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("creates no lockfile when there is no Tandem entry to remove", async () => {
    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    expect(await rewriteJson(FILE, () => false, makeLogger(), { sleep: vi.fn() })).toBe(false);
    expect(_openSpy).not.toHaveBeenCalled();
  });
});

// ── scrubCoworkWorkspace: what the log says per workspace ─────────────────────

describe("scrubCoworkWorkspace", () => {
  const WS = path.join("/fake", "ws", "vm");
  const file = (name: string) => path.join(WS, "cowork_plugins", name);

  /** A logger that counts warnings, as the real one does. */
  function countingLogger() {
    let warns = 0;
    return {
      info: vi.fn(),
      warn: vi.fn(() => {
        warns++;
      }),
      error: vi.fn(),
      warnings: () => warns,
      close: async () => {},
    };
  }

  /** `readFile` content by file name; anything unlisted is ENOENT. */
  function withFiles(contents: Record<string, string>): void {
    _readFileSpy.mockImplementation(async (p: string) => {
      const name = path.basename(p);
      if (name in contents) return contents[name];
      throw makeNotFoundError();
    });
  }

  beforeEach(() => {
    _readFileSpy.mockReset();
    _writeFileSpy.mockReset().mockResolvedValue(undefined);
    _renameSpy.mockReset().mockResolvedValue(undefined);
    _openSpy.mockReset().mockResolvedValue({ close: _closeSpy });
  });

  it("names the files it removed Tandem entries from", async () => {
    withFiles({
      "installed_plugins.json": JSON.stringify({ mcpServers: { tandem: {} } }),
      "cowork_settings.json": JSON.stringify({ enabledPlugins: ["tandem@tandem"] }),
    });
    const logger = countingLogger();
    const { scrubCoworkWorkspace } = await import("../../src/cli/uninstall-scrub.js");

    expect(await scrubCoworkWorkspace(WS, logger)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      `removed Tandem entries from installed_plugins.json, cowork_settings.json in ${WS}`,
    );
  });

  it("says 'no Tandem entries' only when every file was actually checked", async () => {
    withFiles({ "installed_plugins.json": JSON.stringify({ mcpServers: {} }) });
    const logger = countingLogger();
    const { scrubCoworkWorkspace } = await import("../../src/cli/uninstall-scrub.js");

    expect(await scrubCoworkWorkspace(WS, logger)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(`no Tandem entries in ${WS}`);
  });

  it("does not claim 'no Tandem entries' for a file it could not parse", async () => {
    // `rewriteJson` returns false for an unreadable file as well as for a clean
    // one; the warning above is the truth, and the summary must not contradict it.
    withFiles({ "installed_plugins.json": '{"mcpServers": {"tandem"' });
    const logger = countingLogger();
    const { scrubCoworkWorkspace } = await import("../../src/cli/uninstall-scrub.js");

    expect(await scrubCoworkWorkspace(WS, logger)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(file("installed_plugins.json")),
    );
    expect(logger.info).not.toHaveBeenCalledWith(`no Tandem entries in ${WS}`);
  });

  it("still reports what it removed when a later file fails", async () => {
    withFiles({
      "installed_plugins.json": JSON.stringify({ mcpServers: { tandem: {} } }),
      "known_marketplaces.json": JSON.stringify({ marketplaces: { tandem: {} } }),
    });
    _openSpy.mockReset();
    _openSpy
      .mockResolvedValueOnce({ close: _closeSpy })
      .mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const logger = countingLogger();
    const { scrubCoworkWorkspace } = await import("../../src/cli/uninstall-scrub.js");

    expect(await scrubCoworkWorkspace(WS, logger)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`scrub failed for ${WS}`));
    expect(logger.info).toHaveBeenCalledWith(
      `removed Tandem entries from installed_plugins.json in ${WS}`,
    );
  });
});

// ── findCoworkWorkspaces: both roots, no-follow descent (#1417, #2136) ────────

/**
 * The descent rows assert the SYSCALL, not just the return value.
 *
 * The bug those pin is that `readdir`/`stat` **follow** reparse points, so a
 * junction planted anywhere on the descent leaked an SMB handshake before
 * `assertSafeWorkspacePath` at the bottom got a say. There the result is `[]`
 * either way — see `tests/helpers/unc-fixtures.ts` for why that makes the
 * return value worthless as an observable. The #2136 rows are the opposite
 * case: the return value IS the bug (a root never scanned), so they assert it.
 */
describe("findCoworkWorkspaces", () => {
  // Anchored under the real homedir because `usableEnvDir` runs the real
  // (unmocked, sync) `assertPathSafe`, which requires containment there. No
  // directory has to exist: that guard walks up to the first existing ancestor.
  const FAKE_LAD = path.join(homedir(), "AppData", "Local");
  const FAKE_APPDATA = path.join(homedir(), "AppData", "Roaming");
  const PACKAGES = path.join(FAKE_LAD, "Packages");
  const msixSessions = (pkg: string) =>
    path.join(PACKAGES, pkg, "LocalCache", "Roaming", "Claude", "local-agent-mode-sessions");
  const SESSIONS = msixSessions("Claude_abc");
  const WS = path.join(SESSIONS, "ws1");
  const VM = path.join(WS, "vm1");

  // Root B, the direct-install layout. UUID names because that is the observed
  // shape there; the scan does not depend on it.
  const ROAMING_CLAUDE = path.join(FAKE_APPDATA, "Claude");
  const SESSIONS_B = path.join(ROAMING_CLAUDE, "local-agent-mode-sessions");
  const WS_B = path.join(SESSIONS_B, "0c2a7e52-1f3b-4c8d-9e0a-5b6c7d8e9f01");
  const VM_B = path.join(WS_B, "7d1e4b2a-6c3f-4a9e-8b0d-2f1e3c4b5a69");

  const dir = () => ({ isSymbolicLink: () => false, isDirectory: () => true });
  const junction = () => ({ isSymbolicLink: () => true, isDirectory: () => false });

  /** `readdir` results by path; anything unlisted reads as empty. */
  let tree: Record<string, string[]>;
  /** Paths that `lstat` as a junction. */
  let planted: Set<string>;
  /** Paths that `lstat` as ENOENT. Everything else is a plain directory. */
  let absent: Set<string>;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    for (const spy of [_readdirSpy, _lstatSpy, _realpathSpy, _statSpy]) spy.mockReset();
    // Both stubbed, always: an unstubbed `%APPDATA%` is the host's real one on
    // a Windows box and unset on Linux CI, so the same row would scan a
    // different set of roots depending on where it ran.
    vi.stubEnv("LOCALAPPDATA", FAKE_LAD);
    vi.stubEnv("APPDATA", FAKE_APPDATA);
    tree = {
      [PACKAGES]: ["Claude_abc"],
      [SESSIONS]: ["ws1"],
      [WS]: ["vm1"],
    };
    planted = new Set();
    // Root B absent unless a row calls `withRootB()`.
    absent = new Set([ROAMING_CLAUDE]);
    _realpathSpy.mockImplementation(async (p: string) => p);
    _readdirSpy.mockImplementation(async (p: string) => tree[p] ?? []);
    _lstatSpy.mockImplementation(async (p: string) => {
      if (planted.has(p)) return junction();
      if (absent.has(p)) throw makeNotFoundError();
      return dir();
    });
    logger = { info: vi.fn(), warn: vi.fn() };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function withRootB(): void {
    absent.delete(ROAMING_CLAUDE);
    tree[SESSIONS_B] = [path.basename(WS_B)];
    tree[WS_B] = [path.basename(VM_B)];
  }

  /** No readdir/lstat/realpath call named anything containing `fragment`.
   *  Matched by substring, because posix `path.join` normalises `//attacker/x`
   *  to `/attacker/x`, which a `startsWith(hostile)` check would miss. */
  function expectNoSyscallNaming(fragment: string): void {
    for (const spy of [_readdirSpy, _lstatSpy, _realpathSpy]) {
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining(fragment));
    }
  }

  async function scan(): Promise<string[]> {
    const { findCoworkWorkspaces } = await import("../../src/cli/uninstall-scrub.js");
    return findCoworkWorkspaces(logger as never);
  }

  // ── Which roots are scanned (#2136) ──

  it("descends a clean chain and returns the validated workspace", async () => {
    expect(await scan()).toEqual([VM]);
  });

  it("scans %APPDATA%\\Claude when no Claude package exists — the reported bug", async () => {
    tree[PACKAGES] = [];
    withRootB();

    expect(await scan()).toEqual([VM_B]);
    // The package-family line no longer ends the scan, and the log names the
    // root it went on to read.
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("no Claude package directory read"),
    );
    expect(logger.info).toHaveBeenCalledWith(`scanning ${SESSIONS_B}`);
    expect(logger.info).toHaveBeenCalledWith("found 1 workspace(s) in 1 sessions root(s)");
  });

  it("scans both roots when both exist", async () => {
    withRootB();

    expect(await scan()).toEqual([VM, VM_B]);
  });

  it("scans an AnthropicPBC.Claude* package as well as Claude_*", async () => {
    const pkgSessions = msixSessions("AnthropicPBC.Claude_x");
    tree[PACKAGES] = ["AnthropicPBC.Claude_x"];
    tree[pkgSessions] = ["ws1"];
    tree[path.join(pkgSessions, "ws1")] = ["vm1"];

    expect(await scan()).toEqual([path.join(pkgSessions, "ws1", "vm1")]);
  });

  it("never descends into a package that only contains 'Claude'", async () => {
    // Publisher-anchored on purpose: a foreign package could stage the
    // sessions layout inside its own container and be handed the scrub.
    tree[PACKAGES] = ["EvilCorp.TotallyClaude_x", "Claude_abc"];

    // Positive control: the real package is still scanned.
    expect(await scan()).toEqual([VM]);
    expectNoSyscallNaming("EvilCorp");
  });

  // ── Which vm dirs count ──

  it("returns a skills-plugin sibling that holds a cowork_plugins dir", async () => {
    // Measured on a past enabler's machine (2026-10-05): this sibling's
    // `cowork_plugins` held Tandem entries in all three files. A UUID-pair
    // filter, as the Rust scan's first branch is, would leave them behind.
    const skillsVm = path.join(SESSIONS, "skills-plugin", "ca28ad17-dcdb-4ea1-8178-8a8861613939");
    tree[SESSIONS] = ["ws1", "skills-plugin"];
    tree[path.join(SESSIONS, "skills-plugin")] = [path.basename(skillsVm)];

    expect(await scan()).toEqual([VM, skillsVm]);
  });

  it("skips a vm dir with no cowork_plugins dir, counted in one line", async () => {
    const marker = path.join(VM, "cowork_plugins");
    absent.add(marker);

    expect(await scan()).toEqual([]);
    // One summary line, not one per sibling: a root can hold many.
    expect(logger.info).toHaveBeenCalledWith(
      "skipped 1 dir(s) with no usable cowork_plugins folder",
    );
    for (const spy of [logger.info, logger.warn]) {
      expect(spy).not.toHaveBeenCalledWith(expect.stringContaining(marker));
    }
  });

  it("warns, not just notes, when a folder exists but cannot be read", async () => {
    // Absent is `info`; a permission-denied or locked folder leaves entries
    // behind, so it must reach the summary's warning count.
    _lstatSpy.mockImplementation(async (p: string) => {
      if (p === SESSIONS) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      if (absent.has(p)) throw makeNotFoundError();
      return dir();
    });

    expect(await scan()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`cannot read ${SESSIONS}`));
    // Absence alone stays below a warning.
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining(ROAMING_CLAUDE));
  });

  it("warns when a folder lstats as a directory but cannot be listed", async () => {
    _readdirSpy.mockImplementation(async (p: string) => {
      if (p === SESSIONS) {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
      return tree[p] ?? [];
    });

    expect(await scan()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`cannot read ${SESSIONS}`));
  });

  it("refuses a junction planted as cowork_plugins", async () => {
    // `rewriteJson` reads and locks files inside this dir, and `readFile` /
    // `open` follow a junction there. Screening it here is what stops that.
    const marker = path.join(VM, "cowork_plugins");
    planted.add(marker);

    expect(await scan()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(`refusing to descend into reparse point: ${marker}`);
  });

  // ── Screening the env vars (#1417) ──

  it.each(NETWORK_PATHS)(
    "refuses a UNC LOCALAPPDATA (%s) without reading anything derived from it",
    async (_label, hostile) => {
      // Every root-A path is a `path.join` off this value. Nothing covered it,
      // and deleting the `assertPathSafe` screen left the whole suite green.
      withRootB();
      vi.stubEnv("LOCALAPPDATA", hostile);

      // Positive control, and the #2136 half: an unusable %LOCALAPPDATA% must
      // not end the scan before %APPDATA% is read.
      expect(await scan()).toEqual([VM_B]);
      expectNoSyscallNaming("attacker");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("%LOCALAPPDATA%"));
    },
  );

  it.each(NETWORK_PATHS)(
    "refuses a UNC APPDATA (%s) without reading anything derived from it",
    async (_label, hostile) => {
      vi.stubEnv("APPDATA", hostile);

      // Positive control: root A is still scanned.
      expect(await scan()).toEqual([VM]);
      expectNoSyscallNaming("attacker");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("%APPDATA%"));
    },
  );

  it("refuses a local APPDATA outside the user folder, not just a UNC one", async () => {
    // `assertPathSafe` rather than a bare UNC test is the whole reason
    // `usableEnvDir` exists; a local path outside home is what tells them apart.
    const outside = path.join(path.parse(homedir()).root, "tandem-outside-home-fixture", "x");
    vi.stubEnv("APPDATA", outside);

    expect(await scan()).toEqual([VM]);
    expectNoSyscallNaming("tandem-outside-home-fixture");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("%APPDATA% rejected"));
  });

  // ── No-follow descent ──

  it.each([
    ["the Packages dir", PACKAGES],
    ["a Claude_* sessions root", SESSIONS],
    ["a workspace dir", WS],
  ])("refuses to readdir through a junction at %s", async (_label, at) => {
    planted.add(at);

    expect(await scan()).toEqual([]);
    // The load-bearing assertion: the following call never happened.
    expect(_readdirSpy).not.toHaveBeenCalledWith(at);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("reparse point"));
  });

  // **`path.join`, not a hardcoded separator**, and this is a correctness
  // requirement rather than tidiness. `planted` matches by string equality
  // against the path `descendNoFollow` builds — with `path.join`. A backslash
  // literal here matches on win32 and matches NOTHING on posix, so the junction
  // is never planted, the descent runs clean, and the test asserts the guard
  // works while never having exercised it. The first version of these rows was
  // written that way; it passed on Windows and CI caught it.
  //
  // `lstat` declines to follow only the FINAL component, so screening an
  // assembled sessions root checks one level and traverses the rest. All of
  // these are user-writable. Each table keeps the OTHER root present as its
  // positive control: a junction refuses one root and must not end the scan.
  it.each([
    ["a Claude_* package root", path.join(PACKAGES, "Claude_abc")],
    ["LocalCache", path.join(PACKAGES, "Claude_abc", "LocalCache")],
    ["Roaming", path.join(PACKAGES, "Claude_abc", "LocalCache", "Roaming")],
    ["Claude", path.join(PACKAGES, "Claude_abc", "LocalCache", "Roaming", "Claude")],
  ])("refuses to traverse a junction at the MSIX root's %s", async (_label, at) => {
    withRootB();
    planted.add(at);

    expect(await scan()).toEqual([VM_B]);
    expect(_readdirSpy).not.toHaveBeenCalledWith(SESSIONS);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("reparse point"));
  });

  it.each([
    ["Claude dir", ROAMING_CLAUDE],
    ["sessions root", SESSIONS_B],
  ])("refuses to traverse a junction at the APPDATA root's %s", async (_label, at) => {
    withRootB();
    planted.add(at);

    expect(await scan()).toEqual([VM]);
    expect(_readdirSpy).not.toHaveBeenCalledWith(SESSIONS_B);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("reparse point"));
  });

  it("refuses to stat a junction at the vm level", async () => {
    planted.add(VM);

    expect(await scan()).toEqual([]);
    // `stat` follows; the fix is that only `lstat` ever sees this path.
    expect(_statSpy).not.toHaveBeenCalled();
    // And the vm is screened BEFORE its `cowork_plugins`: checking the marker
    // first (the Rust order) would `lstat` through the junction.
    expect(_lstatSpy).not.toHaveBeenCalledWith(path.join(VM, "cowork_plugins"));
  });

  // ── Containment ──

  it("rejects a workspace that resolves outside its own sessions root", async () => {
    // Inside %APPDATA% but outside the sessions root: only a sessions-root
    // containment base rejects this. An env-var base would accept it.
    withRootB();
    tree[PACKAGES] = [];
    const elsewhere = path.join(ROAMING_CLAUDE, "elsewhere", "a", "b");
    _realpathSpy.mockImplementation(async (p: string) => (p === VM_B ? elsewhere : p));

    expect(await scan()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("outside the scan root"));
  });

  it("contains each workspace under the RESOLVED sessions root and returns resolved paths", async () => {
    // An env var spelled with 8.3 short names, say: the sessions root resolves
    // to a different string than the one the descent built. Containment must
    // use the resolved one, or every resolved workspace reads as "outside" and
    // the scrub leaves the token behind. Identity realpath in every other row
    // could not tell `root.real` from `root.path`.
    const resolvedSessions = path.join(homedir(), "AppData", "Local", "resolved-spelling", "s");
    const resolvedVm = path.join(resolvedSessions, "ws1", "vm1");
    _realpathSpy.mockImplementation(async (p: string) => {
      if (p === SESSIONS) return resolvedSessions;
      if (p === VM) return resolvedVm;
      return p;
    });

    expect(await scan()).toEqual([resolvedVm]);
  });

  it("skips a sessions root whose realpath fails rather than using it unresolved", async () => {
    withRootB();
    tree[PACKAGES] = [];
    _realpathSpy.mockImplementation(async (p: string) => {
      if (p === SESSIONS_B) throw makeNotFoundError();
      return p;
    });

    expect(await scan()).toEqual([]);
    expect(_readdirSpy).not.toHaveBeenCalledWith(SESSIONS_B);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cannot resolve"));
  });
});

// ── win-path-guard ────────────────────────────────────────────────────────────

describe("assertSafeWorkspacePath", () => {
  const FAKE_LAD = "C:\\Users\\test\\AppData\\Local";
  const VALID_PATH = `${FAKE_LAD}\\Packages\\Claude_123\\ws\\vm`;

  beforeEach(() => {
    _lstatSpy.mockReset();
    _realpathSpy.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid path inside the scan root", async () => {
    // lstat returns non-symlink for all components.
    _lstatSpy.mockResolvedValue(notSymlink());
    _realpathSpy.mockResolvedValue(VALID_PATH);

    const { assertSafeWorkspacePath } = await import("../../src/cli/win-path-guard.js");
    const result = await assertSafeWorkspacePath(VALID_PATH, FAKE_LAD);
    expect(result).toBe(VALID_PATH);
  });

  it("rejects a UNC path", async () => {
    const unc = "\\\\server\\share\\ws\\vm";
    _lstatSpy.mockResolvedValue(notSymlink());
    _realpathSpy.mockResolvedValue(unc);

    const logger = { warn: vi.fn() };
    const { assertSafeWorkspacePath } = await import("../../src/cli/win-path-guard.js");
    const result = await assertSafeWorkspacePath(unc, FAKE_LAD, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("UNC"));
  });

  it("rejects a path with a symlink component", async () => {
    // First lstat call (the candidate itself) returns isSymbolicLink=true.
    _lstatSpy.mockResolvedValueOnce({ isSymbolicLink: () => true });

    const logger = { warn: vi.fn() };
    const { assertSafeWorkspacePath } = await import("../../src/cli/win-path-guard.js");
    const result = await assertSafeWorkspacePath(VALID_PATH, FAKE_LAD, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("symlink/reparse point"));
  });

  it("rejects a path outside the scan root", async () => {
    const outsidePath = "C:\\Users\\test\\AppData\\Roaming\\evil\\ws\\vm";
    _lstatSpy.mockResolvedValue(notSymlink());
    _realpathSpy.mockResolvedValue(outsidePath);

    const logger = { warn: vi.fn() };
    const { assertSafeWorkspacePath } = await import("../../src/cli/win-path-guard.js");
    const result = await assertSafeWorkspacePath(outsidePath, FAKE_LAD, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("outside the scan root"));
  });
});
