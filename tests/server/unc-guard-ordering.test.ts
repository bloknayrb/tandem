import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPathSafe, detectTargets } from "../../src/server/integrations/apply.js";
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
    // The reason code is the observable. Before the fix this function had NO
    // UNC check at all: the path fell through `existsSync` / `lstatSync` on the
    // raw string — the calls that leak the hash — and was eventually refused as
    // "outside-home" by the allowed-roots test. Same rejection, but only after
    // the damage, so asserting merely "it throws" passes against the old code.
    expect(() => assertPathSafe(target)).toThrow(
      expect.objectContaining({ name: "PathRejectedError", reason: "unc" }),
    );
  });

  it("still accepts an ordinary local path under an allowed root", () => {
    // The guard must not have become a blanket refusal.
    expect(() => assertPathSafe(process.cwd(), { allowedRoots: [process.cwd()] })).not.toThrow();
  });
});

describe("detectTargets screens the Claude Desktop path before existsSync (#1417)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses a UNC-redirected %APPDATA% without calling existsSync", () => {
    // `%APPDATA%` can be redirected to a share by enterprise folder
    // redirection, and `existsSync` connects. `assertPathSafe` downstream is
    // one syscall too late, so the screen has to sit here — and since the
    // rejection produces the same "no Claude Desktop target" result either
    // way, the syscall is the only thing that distinguishes fixed from broken.
    _existsSyncSpy.mockClear();

    const targets = detectTargets({ appDataOverride: "\\\\attacker\\share\\Roaming" });

    expect(targets.some((t) => t.kind === "claude-desktop")).toBe(false);
    expect(_existsSyncSpy).not.toHaveBeenCalledWith(expect.stringContaining("attacker"));
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
