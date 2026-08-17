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

  it("logs malformed JSON without the parse-error detail (token-bearing files)", async () => {
    // V8 SyntaxError messages embed a source snippet; if that snippet held a
    // bearer token it would land in uninstall.log. The warn line must carry
    // the path only.
    _readFileSpy.mockResolvedValue('{"mcpServers": {"tandem": {"env": {"SECRET_TOKEN_VALUE"');

    const { rewriteJson } = await import("../../src/cli/uninstall-scrub.js");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), close: async () => {} };
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

// ── findCoworkWorkspaces: no-follow descent (#1417) ───────────────────────────

/**
 * These assert the SYSCALL, not the return value.
 *
 * The bug being pinned is that `readdir`/`stat` **follow** reparse points, so a
 * junction planted anywhere on the four-level descent leaked an SMB handshake
 * before `assertSafeWorkspacePath` at the bottom got a say. Here the result is
 * `[]` either way — see `tests/helpers/unc-fixtures.ts` for why that makes the
 * return value worthless as an observable.
 */
describe("findCoworkWorkspaces reparse-point handling", () => {
  // Anchored under the real homedir because `usableLocalAppData` runs the real
  // (unmocked, sync) `assertPathSafe`, which requires containment there. No
  // directory has to exist: that guard walks up to the first existing ancestor.
  const FAKE_LAD = path.join(homedir(), "AppData", "Local");
  const PACKAGES = path.join(FAKE_LAD, "Packages");
  const SESSIONS = path.join(
    PACKAGES,
    "Claude_abc",
    "LocalCache",
    "Roaming",
    "Claude",
    "local-agent-mode-sessions",
  );
  const WS = path.join(SESSIONS, "ws1");
  const VM = path.join(WS, "vm1");

  const dir = () => ({ isSymbolicLink: () => false, isDirectory: () => true });
  const junction = () => ({ isSymbolicLink: () => true, isDirectory: () => false });

  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    for (const spy of [_readdirSpy, _lstatSpy, _realpathSpy, _statSpy]) spy.mockReset();
    vi.stubEnv("LOCALAPPDATA", FAKE_LAD);
    _realpathSpy.mockImplementation(async (p: string) => p);
    _readdirSpy.mockImplementation(async (p: string) => {
      if (p === PACKAGES) return ["Claude_abc"];
      if (p === SESSIONS) return ["ws1"];
      if (p === WS) return ["vm1"];
      return [];
    });
    logger = { info: vi.fn(), warn: vi.fn() };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Every path is a plain directory except `plantedAt`, which is a junction. */
  function plantJunction(plantedAt: string | null): void {
    _lstatSpy.mockImplementation(async (p: string) => (p === plantedAt ? junction() : dir()));
  }

  it.each(
    NETWORK_PATHS,
  )("refuses a UNC %%LOCALAPPDATA%% (%s) without reading anything", async (_label, hostile) => {
    // The screen the file's own docblock calls the consequential one: every
    // path here is a `path.join` off this value, and the scrub runs during an
    // MSIX uninstall that can be elevated. Nothing covered it, and deleting
    // `usableLocalAppData`'s `assertPathSafe` left the whole suite green.
    plantJunction(null);
    vi.stubEnv("LOCALAPPDATA", hostile);
    const { findCoworkWorkspaces } = await import("../../src/cli/uninstall-scrub.js");

    expect(await findCoworkWorkspaces(logger as never)).toEqual([]);
    expect(_readdirSpy).not.toHaveBeenCalled();
    expect(_lstatSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("LOCALAPPDATA"));
  });

  it("descends a clean chain and returns the validated workspace", async () => {
    plantJunction(null);
    const { findCoworkWorkspaces } = await import("../../src/cli/uninstall-scrub.js");

    expect(await findCoworkWorkspaces(logger as never)).toEqual([VM]);
  });

  it.each([
    ["the Packages dir", PACKAGES],
    ["a Claude_* sessions root", SESSIONS],
    ["a workspace dir", WS],
  ])("refuses to readdir through a junction at %s", async (_label, planted) => {
    plantJunction(planted);
    const { findCoworkWorkspaces } = await import("../../src/cli/uninstall-scrub.js");

    expect(await findCoworkWorkspaces(logger as never)).toEqual([]);
    // The load-bearing assertion: the following call never happened.
    expect(_readdirSpy).not.toHaveBeenCalledWith(planted);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("reparse point"));
  });

  it.each([
    ["a Claude_* package root", `${PACKAGES}\\Claude_abc`],
    ["LocalCache", `${PACKAGES}\\Claude_abc\\LocalCache`],
    ["Roaming", `${PACKAGES}\\Claude_abc\\LocalCache\\Roaming`],
    ["Claude", `${PACKAGES}\\Claude_abc\\LocalCache\\Roaming\\Claude`],
  ])("refuses to traverse a junction at %s, mid-join", async (_label, planted) => {
    // `lstat` declines to follow only the FINAL component, so screening the
    // assembled six-segment `sessionsRoot` checked one level and traversed
    // these four. All are user-writable and all sit inside the tree the
    // reachable instance of #1417 lived in.
    plantJunction(planted.replace(/\//g, "\\"));
    const { findCoworkWorkspaces } = await import("../../src/cli/uninstall-scrub.js");

    expect(await findCoworkWorkspaces(logger as never)).toEqual([]);
    expect(_readdirSpy).not.toHaveBeenCalledWith(SESSIONS);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("reparse point"));
  });

  it("refuses to stat a junction at the vm level", async () => {
    plantJunction(VM);
    const { findCoworkWorkspaces } = await import("../../src/cli/uninstall-scrub.js");

    expect(await findCoworkWorkspaces(logger as never)).toEqual([]);
    // `stat` follows; the fix is that only `lstat` ever sees this path.
    expect(_statSpy).not.toHaveBeenCalled();
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
