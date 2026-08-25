import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * `os.homedir()` is the fallback both HOME-reading checks reach when the
 * environment is empty, so it is an input in its own right — and the only way
 * to poison it is to mock it.
 */
const { _homedirSpy } = vi.hoisted(() => ({ _homedirSpy: vi.fn() }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  _homedirSpy.mockImplementation(actual.homedir as never);
  return { ...actual, homedir: _homedirSpy };
});

// __TANDEM_VERSION__ is a tsup define and never set under vitest, so
// checkStaleGlobal short-circuits and runDoctor spawns nothing. Mocked anyway
// so a future change to that guard cannot turn this file into a process-spawner.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn() };
});

const { desktopScreenInput, readClaudeConfig, runDoctor } = await import("../../src/cli/doctor.js");

/**
 * Assembled rather than written out, exactly as `doctor.ts` does for the same
 * string and for the same reason: a bare literal here trips tooling that
 * screens for reads of the developer's real Claude Code config.
 */
const USER_CONFIG_LEAF = `.${"claude"}.json`;
const SETTINGS_LEAF = "settings.json";
const DESKTOP_LEAF = "claude_desktop_config.json";

/**
 * The recognisable tail of one corpus row, derived from the row itself.
 *
 * **Derived, not hardcoded, and that is the whole point.** The first version
 * of this file matched a literal `/attacker|someone/`, which works only
 * because every row happens to name one of those two today. `unc-fixtures.ts`
 * exists to be extended — its docblock says "add a newly-found spelling HERE
 * and every guard's test picks it up" — and a new row spelling its host
 * anything else (say `\\?\GLOBALROOT\Device\HarddiskVolume1\x`) would filter
 * to `[]` no matter what doctor read, and pass. A zero-of-zero satisfying a
 * zero check, in the file whose entire job is to be the gate the eighth site
 * slipped past.
 *
 * Separators are normalised and leading ones dropped, so the tail survives
 * both `path.win32.join` (which preserves the UNC prefix) and
 * `path.posix.join` (which collapses it). `\\attacker\share\x` and
 * `//?/C:/Users/someone/x` become `attacker/share/x` and
 * `?/C:/Users/someone/x`, each of which appears in every platform's
 * derivation of that row.
 */
function hostileTail(hostileHome: string): string {
  return hostileHome.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** The two leaves this unit owns. Scoping keeps an unguarded read elsewhere in
 *  doctor from failing an assertion that is about these three checks. */
function isClaudeConfigLeaf(p: string): boolean {
  return p.endsWith(USER_CONFIG_LEAF) || p.endsWith(SETTINGS_LEAF) || p.endsWith(DESKTOP_LEAF);
}

function allPathArgs(): string[] {
  return [..._readFileSyncSpy.mock.calls, ..._existsSyncSpy.mock.calls].map(([p]) => String(p));
}

function hostileClaudeConfigCalls(hostileHome: string): string[] {
  const tail = hostileTail(hostileHome);
  return allPathArgs().filter((p) => p.replace(/\\/g, "/").includes(tail) && isClaudeConfigLeaf(p));
}

/** Captured through the delegating spy before any test overrides it. */
const REAL_HOME = homedir();

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
  _homedirSpy.mockReturnValue(REAL_HOME);
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

    expect(hostileClaudeConfigCalls(hostileHome)).toEqual([]);
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
    expect(hostileClaudeConfigCalls(hostileHome)).toEqual([]);
  });

  // The env-less case, which the block above cannot reach because it SETS
  // HOME/USERPROFILE rather than clearing them. With both unset,
  // `claudeCodeConfigPath` falls back to `homedir()` — and `homeIsUnsafe("")`
  // is false, so screening the env value alone left exactly the launchd/service
  // configuration this guard exists for behind the derived-path screen that
  // posix collapse defeats. Screening the EFFECTIVE home closes it.
  it.each([
    ...NETWORK_PATHS,
    ...LOCAL_EXTENDED_PATHS,
  ])("%s — no read derived from a hostile homedir() when the environment is empty", async (_label, hostileHome) => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    _homedirSpy.mockReturnValue(hostileHome);

    await runDoctor();

    expect(hostileClaudeConfigCalls(hostileHome)).toEqual([]);
  });

  // The input screen must screen the input that actually FEEDS the derivation.
  // A first pass refused the desktop check whenever `homeOverride ?? homedir()`
  // OR `%APPDATA%` was hostile, which inverts the cost: under enterprise
  // redirection `%USERPROFILE%` sits on a share while `%APPDATA%` stays local,
  // so the desktop config is an ordinary local file — and doctor printed "on a
  // network path Tandem will not read" (false) and dropped the only check that
  // reports whether tandem is registered with Claude Desktop. A guard that
  // manufactures the failure it exists to prevent.
  //
  // win32-only because that is the only platform where `%APPDATA%` enters the
  // derivation at all. It asserts a READ HAPPENED rather than a message, so it
  // fails if the check silently returns.
  it.runIf(process.platform === "win32")(
    "does not refuse a local %APPDATA% just because the profile is redirected",
    async () => {
      const appData = mkdtempSync(join(tmpdir(), "tandem-doctor-appdata-"));
      const savedAppData = process.env.APPDATA;
      process.env.APPDATA = appData;
      process.env.USERPROFILE = "\\\\fileserver\\profiles\\alice";
      delete process.env.HOME;
      try {
        await runDoctor();
        expect(
          allPathArgs(),
          "the desktop check refused a local %APPDATA% because the profile was on a share",
        ).toContain(join(appData, "Claude", DESKTOP_LEAF));
      } finally {
        if (savedAppData === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = savedAppData;
        rmSync(appData, { recursive: true, force: true });
      }
    },
  );

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

      // And the FILTER itself must be able to return non-empty. Both `it.each`
      // blocks above assert `toEqual([])`, which a filter that never matches
      // anything satisfies perfectly — so run it here, over a home that really
      // was read, and require a hit. Without this the whole ordering suite
      // could be silently disarmed by a change to `hostileTail` or
      // `isClaudeConfigLeaf`, and every row would still be green.
      expect(hostileClaudeConfigCalls(home).length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * The loader's own screen, tested directly because nothing reachable through
 * `runDoctor` can make it fire: every caller screens its raw input first, and
 * no safe input can `path.join` into an unsafe path. Deleting the screen left
 * all 47 integration assertions green on both platforms — an untested claim.
 * It is a deliberate backstop for the NEXT check that reads a Claude config,
 * which is exactly the role `checkTandemPlugin` needed and did not have.
 */
describe("readClaudeConfig screens the path it is handed", () => {
  it.each([...NETWORK_PATHS, ...LOCAL_EXTENDED_PATHS])("%s", (_label, hostile) => {
    _readFileSyncSpy.mockClear();
    expect(readClaudeConfig(hostile)).toEqual({ kind: "unsafe-path" });
    expect(_readFileSyncSpy).not.toHaveBeenCalled();
  });

  it("still reads an ordinary local path", () => {
    // Positive control: without it, `return { kind: "unsafe-path" }` for every
    // input passes every assertion above.
    const file = join(dataDir, "cfg.json");
    writeFileSync(file, JSON.stringify({ mcpServers: {} }), "utf-8");
    expect(readClaudeConfig(file)).toEqual({ kind: "ok", value: { mcpServers: {} } });
  });
});

/**
 * The desktop precedence mirror. Both platform branches run on every runner:
 * the same property as an `it.runIf(win32)` integration test, minus the part
 * where CI's ubuntu-only vitest job skips it forever and reports a pass
 * (#1529).
 */
describe("desktopScreenInput mirrors claudeDesktopConfigPath's precedence", () => {
  const HOME_DIR = "/home/alice";

  it("uses homeOverride when set, on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(
        desktopScreenInput({ homeOverride: "/ov", platform, appData: "/ad", homeDir: HOME_DIR }),
      ).toBe("/ov");
    }
  });

  it("uses %APPDATA% on win32 when homeOverride is absent", () => {
    expect(desktopScreenInput({ platform: "win32", appData: "/ad", homeDir: HOME_DIR })).toBe(
      "/ad",
    );
  });

  it("ignores %APPDATA% off win32", () => {
    // The bug this replaced: screening %APPDATA% unconditionally refused a
    // local desktop config whenever the profile was redirected.
    expect(desktopScreenInput({ platform: "linux", appData: "/ad", homeDir: HOME_DIR })).toBe(
      HOME_DIR,
    );
  });

  it("falls back to the home dir on win32 with no %APPDATA%", () => {
    expect(desktopScreenInput({ platform: "win32", homeDir: HOME_DIR })).toBe(HOME_DIR);
  });

  it("treats an empty homeOverride the way the resolver does", () => {
    // `claudeDesktopConfigPath` branches on truthiness, so `homeOverride: ""`
    // takes the %APPDATA% route. An `=== undefined` test here screened "",
    // a no-op, while the resolver derived from %APPDATA%.
    expect(
      desktopScreenInput({
        homeOverride: "",
        platform: "win32",
        appData: "/ad",
        homeDir: HOME_DIR,
      }),
    ).toBe("/ad");
  });
});
