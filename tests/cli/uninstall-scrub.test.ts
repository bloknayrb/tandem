/**
 * Tests for `uninstall-scrub` CLI module and `win-path-guard`.
 *
 * vi.mock calls are hoisted to file top by Vitest — factories cannot reference
 * variables. We use module-level vi.fn() stubs that beforeEach reconfigures
 * via .mockResolvedValue / .mockReturnValue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Top-level stubs (referenced by vi.mock factories) ────────────────────────

const _readdirSpy = vi.fn();
const _readFileSpy = vi.fn();
const _writeFileSpy = vi.fn().mockResolvedValue(undefined);
const _renameSpy = vi.fn().mockResolvedValue(undefined);
const _unlinkSpy = vi.fn().mockResolvedValue(undefined);
const _lstatSpy = vi.fn();
const _realpathSpy = vi.fn();
const _statSpy = vi.fn();

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
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
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: async () => {} };
    const result = await rewriteJson("/fake/path.json", () => true, logger);
    expect(result).toBe(false);
    expect(_writeFileSpy).not.toHaveBeenCalled();
  });

  it("writes and renames when mutate returns true", async () => {
    const initial = JSON.stringify({ mcpServers: { tandem: {} } });
    _readFileSpy.mockResolvedValue(initial);

    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: async () => {} };
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

  it("accepts a valid path inside LOCALAPPDATA", async () => {
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

  it("rejects a path outside LOCALAPPDATA", async () => {
    const outsidePath = "C:\\Users\\test\\AppData\\Roaming\\evil\\ws\\vm";
    _lstatSpy.mockResolvedValue(notSymlink());
    _realpathSpy.mockResolvedValue(outsidePath);

    const logger = { warn: vi.fn() };
    const { assertSafeWorkspacePath } = await import("../../src/cli/win-path-guard.js");
    const result = await assertSafeWorkspacePath(outsidePath, FAKE_LAD, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("outside %LOCALAPPDATA%"));
  });
});
