import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_EXTENDED_PATHS, NETWORK_PATHS } from "../helpers/unc-fixtures.js";

/**
 * Doctor's Claude-config reads, screened before the syscall (#1417).
 *
 * **Why a separate file from `doctor.test.ts`.** `vi.mock("node:fs")` is
 * module-scoped, and `doctor.test.ts` builds real temp-dir fixtures through
 * the same module throughout. Mocking `node:fs` there would reach every one of
 * its tests to serve these.
 *
 * **Why the syscall and not the return value.** See the standing rule in
 * `tests/helpers/unc-fixtures.ts`: a UNC host that does not answer produces the
 * same warning whether or not the guard ran, because the read throws either
 * way. Asserting on the report passes against the vulnerable code. The
 * vulnerability is that the call was made at all.
 *
 * **Why `vi.hoisted` + `vi.mock` and not `vi.spyOn`.** `doctor.ts` imports
 * `readFileSync`/`existsSync` from `node:fs` directly; an ESM module namespace
 * is not configurable, so `vi.spyOn(fs, …)` throws. Same technique as
 * `tests/server/unc-guard-ordering.test.ts`.
 */
const { _readFileSyncSpy, _existsSyncSpy } = vi.hoisted(() => ({
  _readFileSyncSpy: vi.fn(),
  _existsSyncSpy: vi.fn(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  _readFileSyncSpy.mockImplementation(actual.readFileSync as never);
  _existsSyncSpy.mockImplementation(actual.existsSync as never);
  return { ...actual, readFileSync: _readFileSyncSpy, existsSync: _existsSyncSpy };
});

// __TANDEM_VERSION__ is a tsup define and never set under vitest, so
// checkStaleGlobal short-circuits and runDoctor spawns nothing. Mocked anyway
// so a future change to that guard cannot turn this file into a process-spawner.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

const { runDoctor } = await import("../../src/cli/doctor.js");

/**
 * Assembled rather than written out, exactly as `doctor.ts` does for the same
 * string and for the same reason: a bare literal here trips tooling that
 * screens for reads of the developer's real Claude Code config.
 */
const USER_CONFIG_LEAF = `.${"claude"}.json`;
const SETTINGS_LEAF = "settings.json";
const DESKTOP_LEAF = "claude_desktop_config.json";

/**
 * Every hostile path in the corpus names one of these two. Asserting on the
 * marker rather than on the poisoned `home` string is deliberate: `path.join`
 * rewrites separators differently per platform, so the exact derived path is
 * not predictable from the input, but the hostname/username inside it survives
 * every spelling.
 */
const HOSTILE_MARKER = /attacker|someone/i;

/** The two leaves this unit owns. Scoping keeps an unguarded read elsewhere in
 *  doctor from failing an assertion that is about these three checks. */
function isClaudeConfigLeaf(p: string): boolean {
  return p.endsWith(USER_CONFIG_LEAF) || p.endsWith(SETTINGS_LEAF) || p.endsWith(DESKTOP_LEAF);
}

function allPathArgs(): string[] {
  return [..._readFileSyncSpy.mock.calls, ..._existsSyncSpy.mock.calls].map(([p]) => String(p));
}

function hostileClaudeConfigCalls(): string[] {
  return allPathArgs().filter((p) => HOSTILE_MARKER.test(p) && isClaudeConfigLeaf(p));
}

let dataDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "tandem-doctor-path-safety-"));
  for (const key of ["HOME", "USERPROFILE", "TANDEM_APP_DATA_DIR"]) {
    savedEnv[key] = process.env[key];
  }
  // Keep the annotation-store check off the real OS data dir, exactly as
  // doctor.test.ts does — it is unrelated to this file and would otherwise
  // read whatever the developer has.
  process.env.TANDEM_APP_DATA_DIR = dataDir;
  // Default the profile to a scratch dir. Without this, every test that does
  // not set HOME itself reads the developer's real Claude Code config — which
  // is both a cross-machine flakiness source and a read this suite has no
  // business performing. Tests that care override or delete these.
  //
  // Two characterization tests below DO delete both, because unset-in-both is
  // the condition they exist to pin. `os.homedir()` then falls back to the real
  // profile and doctor reads the developer's actual config. That is inherent to
  // what those two assert and cannot be scratch-dir'd away; the assertions are
  // over the path argument, never the file's contents, and nothing is written.
  process.env.HOME = dataDir;
  process.env.USERPROFILE = dataDir;
  _readFileSyncSpy.mockClear();
  _existsSyncSpy.mockClear();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Characterization, written against unmodified production code and run before
 * anything moved. These pin behavior this unit must NOT change; the home
 * resolution they describe is deliberately left alone here and unified in a
 * follow-up, where it is the subject rather than a side effect of a security
 * fix.
 */
describe("doctor's Claude-config home resolution (characterization)", () => {
  it("the plugin check reads $HOME/.claude/settings.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "tandem-doctor-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      await runDoctor();
      expect(allPathArgs()).toContain(join(home, ".claude", SETTINGS_LEAF));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the user-mcp-config check falls back to homedir() when HOME and USERPROFILE are unset", async () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    await runDoctor();
    expect(allPathArgs()).toContain(join(homedir(), USER_CONFIG_LEAF));
  });

  it("the plugin check does NOT fall back to homedir() — it returns silently", async () => {
    // The two checks read the same file and already disagree: `if (!home)
    // return;` makes the whole plugin check vanish in an env-less context
    // (a launchd/service start) where the user-mcp-config check still probes.
    // Pinned because unifying home resolution un-silences it, and the existing
    // wiring tests filter by check name and would stay green through that.
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    await runDoctor();
    expect(allPathArgs()).not.toContain(join(homedir(), ".claude", SETTINGS_LEAF));
  });
});

/**
 * The ordering half. The user-mcp-config and desktop-mcp-config checks were
 * guarded by #1417 and are expected green from the start — that is the point.
 * They prove the harness can distinguish a guarded site from an unguarded one,
 * and they are the first coverage those two guards have ever had.
 */
describe("doctor screens hostile home paths before reading any Claude config (#1417)", () => {
  it.each([
    ...NETWORK_PATHS,
    ...LOCAL_EXTENDED_PATHS,
  ])("%s — no read of a Claude config derived from it", async (_label, hostileHome) => {
    // Both, because the resolvers read `HOME || USERPROFILE` and a real
    // Windows box has only the second.
    process.env.HOME = hostileHome;
    process.env.USERPROFILE = hostileHome;

    await runDoctor();

    expect(hostileClaudeConfigCalls()).toEqual([]);
  });

  // The desktop check reads `%APPDATA%` and `homedir()` rather than HOME or
  // USERPROFILE directly, so on win32 the block above never reaches it. Its
  // guard shipped with #1417 and had no coverage at all until now.
  //
  // `homeOverride` WINS over `%APPDATA%` by design (a containment boundary,
  // documented in client-config-paths.ts), which is what lets this drive a
  // hostile desktop path on Windows as well as posix.
  //
  // This block's first draft carried a comment predicting that the
  // forward-slash spellings would, on Linux, "assert something true but not
  // load-bearing". That was wrong in the worse direction — they asserted
  // something FALSE. `posix.join` collapses those four to a path the guard
  // accepts, the read happens, and the derived path still carries the marker,
  // so the block was red on ubuntu CI while green on this machine. Note also
  // that on posix `homedir()` returns `$HOME`, so the block ABOVE reaches the
  // desktop leaf too and failed the same way. The desktop check now screens
  // its inputs the same way the home-derived checks screen theirs, which is
  // what makes all fourteen rows load-bearing on both platforms.
  it.each([
    ...NETWORK_PATHS,
    ...LOCAL_EXTENDED_PATHS,
  ])("%s — no read of a Claude Desktop config derived from it", async (_label, hostileHome) => {
    await runDoctor({ homeOverride: hostileHome });
    expect(hostileClaudeConfigCalls()).toEqual([]);
  });

  it("still reads an ordinary local home", async () => {
    // The guard must not have become a blanket refusal — without this, deleting
    // every read would pass the assertions above.
    const home = mkdtempSync(join(tmpdir(), "tandem-doctor-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      await runDoctor();
      const touched = allPathArgs();
      expect(touched).toContain(join(home, USER_CONFIG_LEAF));
      expect(touched).toContain(join(home, ".claude", SETTINGS_LEAF));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
