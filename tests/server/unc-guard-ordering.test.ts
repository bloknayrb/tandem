import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPathSafe,
  detectionRefusal,
  detectTargets,
} from "../../src/server/integrations/apply.js";
import { sourceFileChanged } from "../../src/server/session/manager.js";
import type { SessionData } from "../../src/shared/types.js";
import { LOCAL_EXTENDED_PATHS, NETWORK_PATHS } from "../helpers/unc-fixtures.js";

/**
 * `existsSync`, observable. It delegates to the real implementation, so nothing
 * else changes — the point is only to assert a call did NOT happen.
 * `vi.spyOn(fs, …)` cannot: an ESM module namespace is not configurable.
 */
const { _existsSyncSpy } = vi.hoisted(() => ({ _existsSyncSpy: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  _existsSyncSpy.mockImplementation(actual.existsSync as never);
  return { ...actual, existsSync: _existsSyncSpy };
});

/**
 * #1417, the ordering half: guards that ran their check *after* a syscall had
 * already performed the SMB handshake. The static detector in
 * `tests/shared/unc-check-duplication.test.ts` catches duplicated checks and
 * cannot see ordering, so ordering is pinned here, per site.
 */

describe("assertPathSafe rejects UNC before any filesystem call (#1417)", () => {
  it.each([...NETWORK_PATHS, ...LOCAL_EXTENDED_PATHS])("%s", (_label, target) => {
    _existsSyncSpy.mockClear();

    // Two assertions, and the second is the one that matters. The reason code
    // pins that a UNC check EXISTS; it survives the check being moved back
    // below the `existsSync`/`lstatSync` ancestor walk, which is precisely the
    // regression this file is named for. That was not hypothetical — this test
    // was written with the first assertion alone, and a mutant that moved the
    // check after the walk passed it. The suite runtime tripled from the SMB
    // timeouts and nothing failed.
    expect(() => assertPathSafe(target)).toThrow(
      expect.objectContaining({ name: "PathRejectedError", reason: "unc" }),
    );
    expect(_existsSyncSpy).not.toHaveBeenCalled();
  });

  it("still accepts an ordinary local path under an allowed root", () => {
    // The guard must not have become a blanket refusal.
    expect(() => assertPathSafe(process.cwd(), { allowedRoots: [process.cwd()] })).not.toThrow();
  });
});

describe("detectTargets screens the Claude Desktop path before existsSync (#1417)", () => {
  afterEach(() => vi.restoreAllMocks());

  // **`platformOverride` is what makes this test able to fail.** Without it the
  // run inherits the host platform, and off win32 `claudeDesktopConfigPath`
  // ignores `appDataOverride` by design (its own docblock says so) — so on a
  // Linux runner this derived `~/.config/claude/…`, a clean local path. The
  // screen never ran; `claude-desktop` was absent only because the posix file
  // does not exist, and the `not.toHaveBeenCalledWith` was vacuous because
  // nothing was ever called with that string. Deleting the guard at the
  // `desktopPrefixRejection` branch left this green on CI.
  //
  // Same defect class as #1417 itself, and the same one CI caught in
  // `uninstall-scrub.test.ts`: a fixture that does not reach the code it names.
  it("refuses a UNC-redirected %APPDATA% without calling existsSync", () => {
    // `%APPDATA%` can be redirected to a share by enterprise folder
    // redirection, and `existsSync` connects. `assertPathSafe` downstream is
    // one syscall too late, so the screen has to sit here — and since the
    // rejection produces the same "no Claude Desktop target" result either
    // way, the syscall is the only thing that distinguishes fixed from broken.
    _existsSyncSpy.mockClear();

    const targets = detectTargets({
      appDataOverride: "\\\\attacker\\share\\Roaming",
      platformOverride: "win32",
    });

    expect(targets.some((t) => t.kind === "claude-desktop")).toBe(false);
    expect(_existsSyncSpy).not.toHaveBeenCalledWith(expect.stringContaining("attacker"));
    // Positive control: without it, a `detectTargets` that threw early or a
    // mis-wired spy would satisfy the negative assertion for the wrong reason.
    // Claude Code's probe is platform-independent and must still have run.
    expect(_existsSyncSpy).toHaveBeenCalledWith(expect.stringContaining(".claude"));
  });
});

describe("detectTargets screens the home root before existsSync (#1417)", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(NETWORK_PATHS)("refuses a UNC home (%s) without calling existsSync", (_label, home) => {
    // `%USERPROFILE%` feeds `~/.claude.json`, `~/.claude` and the Claude
    // Desktop path, so screening it is what covers all four `existsSync` calls
    // rather than the one that happened to get reviewed.
    _existsSyncSpy.mockClear();

    expect(detectTargets({ homeOverride: home })).toEqual([]);
    expect(_existsSyncSpy).not.toHaveBeenCalled();
  });

  it("reports the refusal as distinct from 'nothing installed'", () => {
    // The two produce the same empty list and want opposite advice: the
    // standard remedy is `--force`, which cannot help because the refusal
    // happens before any force branch is reached.
    expect(detectionRefusal({ homeOverride: "\\\\attacker\\share" })).not.toBeNull();
    expect(detectionRefusal({ homeOverride: tmpdir() })).toBeNull();
  });
});

describe("loadSession discards the stored filePath (#1417)", () => {
  /**
   * The deepest fix in #1417, and the one most at risk of being deleted: its
   * own comment argues the two spellings are "equivalent by construction",
   * which is exactly the reasoning a future reader would use to remove the
   * line. Removing it puts a `JSON.parse`d, attacker-controlled string back
   * into `session.filePath` — and `sourceFileChanged`'s screen would stay
   * green, because that one only refuses UNC, while this kills the whole class
   * (traversal and cross-document redirection included).
   */
  it("returns the caller's path, not the one in the file", async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), "tandem-session-"));
    const realPath = join(dir, "real-document.md");

    const { SESSION_DIR } = await import("../../src/server/platform.js");
    const { sessionKey, loadSession } = await import("../../src/server/session/manager.js");
    await fsp.mkdir(SESSION_DIR, { recursive: true });
    const sessionPath = join(SESSION_DIR, `${sessionKey(realPath)}.json`);

    // A tampered session record: found under the real document's key, but
    // naming somewhere else entirely.
    await fsp.writeFile(
      sessionPath,
      JSON.stringify({
        filePath: "\\\\attacker\\share\\doc.md",
        ydocState: "",
        sourceFileMtime: 1,
      }),
    );

    try {
      const loaded = await loadSession(realPath);
      expect(loaded?.filePath).toBe(realPath);
    } finally {
      await fsp.rm(sessionPath, { force: true });
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sourceFileChanged screens the session's own filePath (#1417)", () => {
  afterEach(() => vi.restoreAllMocks());

  const session = (filePath: string): SessionData =>
    ({ filePath, sourceFileMtime: 1, ydocState: "" }) as unknown as SessionData;

  it.each(NETWORK_PATHS)("refuses %s (%s) without calling stat", async (_label, filePath) => {
    // `session.filePath` is parsed out of session JSON, not the caller's
    // already-validated path, and this `stat` was the first thing to touch
    // it — on every open-with-restore. Reported as "changed", which routes
    // the caller into a fresh parse of the path IT validated.
    const stat = vi.spyOn(fsp, "stat");

    await expect(sourceFileChanged(session(filePath))).resolves.toBe(true);

    expect(stat).not.toHaveBeenCalled();
  });

  it("still stats an ordinary local path", async () => {
    const stat = vi.spyOn(fsp, "stat");
    await sourceFileChanged(session(process.cwd()));
    expect(stat).toHaveBeenCalled();
  });
});
