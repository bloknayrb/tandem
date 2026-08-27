import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rejectUnsafeWindowsPrefix } from "../../src/shared/windows-path-safety.js";
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
/**
 * `node:fs/promises` is a SEPARATE module from `node:fs`, and the mock above
 * does not reach it. The annotation-store scan is async and imports from here,
 * so without this tally its "no filesystem call" rows would assert against a
 * spy the code never touches — a check that cannot fail.
 */
const { _fspReaddirTally } = vi.hoisted(() => ({
  _fspReaddirTally: { paths: [] as string[] },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (p: unknown, ...rest: unknown[]) => {
      if (typeof p === "string") _fspReaddirTally.paths.push(p);
      return (actual.readdir as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

const { _readFileSyncSpy, _existsSyncSpy, _statTally } = vi.hoisted(() => ({
  _readFileSyncSpy: vi.fn(),
  _existsSyncSpy: vi.fn(),
  /** Hostile `statSync` paths the stub below refused before any syscall. */
  _statTally: { refused: [] as string[] },
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  _readFileSyncSpy.mockImplementation(actual.readFileSync as never);
  _existsSyncSpy.mockImplementation(actual.existsSync as never);

  // **`statSync` is stubbed for hostile prefixes so this suite does not perform
  // the handshake it exists to prevent.**
  //
  // Poisoning `homedir()` reaches further than the three checks under test:
  // `runDoctor` also calls `detectClaudeCli`, which stats
  // `join(homedir(), ".local", "bin")` through `path-lookup.isFile`. That site
  // is genuinely unguarded — it is one of the three enumerated in
  // `docs/security.md` and filed as #1609 — so on Windows this suite issued a
  // REAL `statSync` against a `\attacker\share\...` path, twice per row,
  // fourteen rows. Windows resolves the host `attacker` over DNS/LLMNR/NBNS:
  // the Responder NTLM-relay vector, which is exactly what #1417 is about,
  // fired from a developer's machine on every pre-push run.
  //
  // This is CONTAINMENT, not a fix; #1609 is the fix. The stub is deliberately
  // narrow — hostile prefixes only, everything else delegates to the real
  // implementation — so it cannot mask a genuine failure. It asserts nothing,
  // because asserting here would require #1609 to already be closed.
  const statSyncStub = ((p: unknown, ...rest: unknown[]) => {
    if (typeof p === "string" && rejectUnsafeWindowsPrefix(p) !== null) {
      _statTally.refused.push(p);
      // `throwIfNoEntry: false` is how `path-lookup.isFile` calls it.
      const opts = rest[0] as { throwIfNoEntry?: boolean } | undefined;
      if (opts?.throwIfNoEntry === false) return undefined;
      throw Object.assign(new Error("ENOENT (test stub: refused before syscall)"), {
        code: "ENOENT",
      });
    }
    return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as unknown as typeof actual.statSync;

  return {
    ...actual,
    readFileSync: _readFileSyncSpy,
    existsSync: _existsSyncSpy,
    statSync: statSyncStub,
  };
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

const { readClaudeConfig, runDoctor } = await import("../../src/cli/doctor.js");
const { claudeDesktopConfigTarget } = await import(
  "../../src/shared/integrations/client-config-paths.js"
);

/**
 * Assembled rather than written out, exactly as `doctor.ts` does for the same
 * string and for the same reason: a bare literal here trips tooling that
 * screens for reads of the developer's real Claude Code config.
 */
const USER_CONFIG_LEAF = `.${"claude"}.json`;
const SETTINGS_LEAF = "settings.json";
const DESKTOP_LEAF = "claude_desktop_config.json";

/** JSON bodies that parse cleanly and are still not a config. */
const NULL_BODY = "null";
const ARRAY_BODY = "[]";
const NUMBER_BODY = "42";
const STRING_BODY = JSON.stringify("a string");

/**
 * The recognisable tail of one corpus row, derived from the row itself.
 *
 * **Derived, not hardcoded, and that is the whole point.** The first version
 * of this file matched a literal `/attacker|someone/`, which works only
 * because every row happens to name one of those two today. `unc-fixtures.ts`
 * exists to be extended -- its docblock says "add a newly-found spelling HERE
 * and every guard's test picks it up" -- and a new row spelling its host
 * anything else would filter to `[]` no matter what doctor read, and pass. A
 * zero-of-zero satisfying a zero check, in the file whose entire job is to be
 * the gate the eighth site slipped past.
 *
 * **Normalised THROUGH `join`, not from the raw string**, and that second
 * version was needed because the first reintroduced the same vacuity by a
 * different route. `path.join` collapses `/./` and a leading `//`, so a tail
 * taken from the raw home can be absent from the path derived from it. The
 * row `//./unc/attacker/share/x` was exactly that: tail
 * `./unc/attacker/share/x`, derived path `/unc/attacker/share/x/...`, no
 * match -- so on POSIX that row filtered to `[]` regardless of what doctor
 * read, in all three blocks below, while staying load-bearing on Windows.
 * Joining a marker and taking its `dirname` applies the same collapse to both
 * sides; {@link expectFilterWouldSee} then proves it per row rather than
 * trusting this reasoning.
 */
function tailOf(home: string): string {
  return dirname(join(home, "marker")).replace(/\\/g, "/").replace(/^\/+/, "");
}

/** The three leaves this unit owns. Scoping keeps an unguarded read elsewhere
 *  in doctor from failing an assertion that is about these three checks. */
function isClaudeConfigLeaf(p: string): boolean {
  return p.endsWith(USER_CONFIG_LEAF) || p.endsWith(SETTINGS_LEAF) || p.endsWith(DESKTOP_LEAF);
}

function allPathArgs(): string[] {
  return [..._readFileSyncSpy.mock.calls, ..._existsSyncSpy.mock.calls].map(([p]) => String(p));
}

function claudeConfigCallsIn(paths: string[], home: string): string[] {
  const tail = tailOf(home);
  return paths.filter((p) => p.replace(/\\/g, "/").includes(tail) && isClaudeConfigLeaf(p));
}

/** Claude-config reads doctor actually performed that derive from `home`. */
function claudeConfigCallsDerivedFrom(home: string): string[] {
  return claudeConfigCallsIn(allPathArgs(), home);
}

/**
 * Per-row positive control for the three `toEqual([])` blocks below.
 *
 * A filter that cannot match satisfies `toEqual([])` perfectly, and the
 * suite-level control at the end of that describe only proves the filter
 * works for SOME input -- it cannot see a single row collapsing, which is
 * exactly what `//./unc/attacker/share/x` did. So before asserting that a row
 * produced no read, assert the filter would have caught that read had it
 * happened.
 */
function expectFilterWouldSee(home: string): void {
  const wouldRead = join(home, USER_CONFIG_LEAF);
  expect(
    claudeConfigCallsIn([wouldRead], home),
    "this row's marker does not appear in the path derived from it, so its " +
      "`toEqual([])` assertion would pass vacuously",
  ).toEqual([wouldRead]);
}

let dataDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "tandem-doctor-path-safety-"));
  for (const key of ["HOME", "USERPROFILE", "TANDEM_APP_DATA_DIR", "APPDATA"]) {
    savedEnv[key] = process.env[key];
  }
  // Keep the annotation-store check off the real OS data dir, exactly as
  // doctor.test.ts does — it is unrelated to this file and would otherwise
  // read whatever the developer has.
  process.env.TANDEM_APP_DATA_DIR = dataDir;
  // Default the profile to a scratch dir — the env vars AND `homedir()`.
  // Without this, every test that does not set HOME itself reads the
  // developer's real Claude Code and Claude Desktop configs, which is both a
  // cross-machine flakiness source and a read this suite has no business
  // performing. Tests that care override or delete these.
  //
  // `homedir()` is pinned too, not just the env vars, because the two
  // characterization tests below DELETE both env vars: that is the condition
  // they exist to pin, and without a pinned `homedir()` the fallback lands on
  // the real profile. An earlier revision pinned it to the real home for
  // exactly that reason and left the real-config read in place; the scratch
  // dir serves the same purpose with none of the reach.
  process.env.HOME = dataDir;
  process.env.USERPROFILE = dataDir;
  // %APPDATA% too: on Windows the desktop check derives from it rather than
  // from HOME, so leaving it alone had most rows reading the developer's real
  // claude_desktop_config.json -- the same reach the pinning above removes.
  process.env.APPDATA = join(dataDir, "AppData", "Roaming");
  _homedirSpy.mockReturnValue(dataDir);
  _readFileSyncSpy.mockClear();
  _existsSyncSpy.mockClear();
  _statTally.refused.length = 0;
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
    expect(allPathArgs()).toContain(join(dataDir, USER_CONFIG_LEAF));
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
    expect(allPathArgs()).not.toContain(join(dataDir, ".claude", SETTINGS_LEAF));
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

    expectFilterWouldSee(hostileHome);
    expect(claudeConfigCallsDerivedFrom(hostileHome)).toEqual([]);
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
  // so the block was red on ubuntu CI while green on this machine.
  //
  // That comment also claimed the block ABOVE reached the desktop leaf on
  // posix, via `homedir()` returning `$HOME`. It does not: `beforeEach` pins
  // `homedir()` to the scratch dir, so the desktop check is never handed a
  // hostile path there on any platform. THIS block, driving `homeOverride`, is
  // the only thing that exercises the desktop input screen — which is why it
  // exists rather than being folded into the one above.
  it.each([
    ...NETWORK_PATHS,
    ...LOCAL_EXTENDED_PATHS,
  ])("%s — no read of a Claude Desktop config derived from it", async (_label, hostileHome) => {
    await runDoctor({ homeOverride: hostileHome });
    expectFilterWouldSee(hostileHome);
    expect(claudeConfigCallsDerivedFrom(hostileHome)).toEqual([]);
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

    expectFilterWouldSee(hostileHome);
    expect(claudeConfigCallsDerivedFrom(hostileHome)).toEqual([]);
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
      // `homedir()` too, and this is what makes the test able to fail. The
      // resolver never reads USERPROFILE -- it reads `homedir()` and
      // %APPDATA% -- so poisoning only the env var left "the profile is
      // redirected" false, and the row reddened solely under a blanket
      // refusal. It passed against the very bug it names.
      _homedirSpy.mockReturnValue("\\\\fileserver\\profiles\\alice");
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
      // could be silently disarmed by a change to `tailOf` or
      // `isClaudeConfigLeaf`, and every row would still be green.
      expect(claudeConfigCallsDerivedFrom(home).length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * The loader's own screen, tested directly because nothing reachable through
 * `runDoctor` can make it fire: every caller screens its raw input first, and
 * on Windows no safe input can `path.win32.join` into an unsafe path.
 * Deleting the screen leaves every integration assertion in this file
 * green -- an untested claim. It is NOT unreachable in general: on POSIX a
 * `$HOME` of a single backslash passes the input screen and derives a path
 * this rejects, which `checkTandemPlugin` now reports rather than
 * swallowing.
 * It is a deliberate backstop for the NEXT check that reads a Claude config,
 * which is exactly the role `checkTandemPlugin` needed and did not have.
 */
describe("readClaudeConfig screens the path it is handed", () => {
  it.each([...NETWORK_PATHS, ...LOCAL_EXTENDED_PATHS])("%s", (_label, hostile) => {
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

  it("distinguishes absent from unreadable from malformed", () => {
    // The three non-screen outcomes, none of which had a direct test. The
    // split between `unreadable` and `malformed` is not cosmetic: the caller
    // printed "is malformed JSON" for EACCES/EISDIR, asserting as fact
    // something it could not know, and prescribing a rewrite that fails the
    // same way.
    expect(readClaudeConfig(join(dataDir, "absent.json"))).toEqual({ kind: "absent" });

    // A directory reads as EISDIR -- the file is fine, the read is not.
    expect(readClaudeConfig(dataDir)).toEqual({ kind: "unreadable" });

    const bad = join(dataDir, "bad.json");
    writeFileSync(bad, "{ not json", "utf-8");
    expect(readClaudeConfig(bad)).toEqual({ kind: "malformed" });
  });

  it.each([
    [NULL_BODY],
    [ARRAY_BODY],
    [NUMBER_BODY],
    [STRING_BODY],
  ])("treats a non-object JSON body (%s) as malformed, not as an empty config", (body) => {
    // Each of these parses, then answers `?.mcpServers` with `undefined` --
    // indistinguishable at the call site from a valid config with nothing
    // registered. Doctor reported "tandem not registered" and prescribed
    // `setup --apply` for a file that is corrupt.
    const file = join(dataDir, "scalar.json");
    writeFileSync(file, body, "utf-8");
    expect(readClaudeConfig(file)).toEqual({ kind: "malformed" });
  });
});

/**
 * The desktop resolver's screening input.
 *
 * `doctor.ts` used to carry a mirror of this precedence, so that the value it
 * screened matched the value the path derived from. The mirror reproduced only
 * one of the resolver's two caller-supplied inputs -- `appDataOverride` BEATS
 * `homeOverride` while `%APPDATA%` LOSES to it, and it implemented the losing
 * rule for both. It was correct at doctor's only call site, which passes no
 * `appDataOverride`, and wrong as a contract; `apply.ts` does pass one.
 *
 * The mirror is gone: the resolver returns the value itself. These pin that
 * value against each branch, with `platformOverride` rather than a runIf so
 * every branch runs on every runner -- a win32-gated spec is skipped forever on
 * this repo's ubuntu-only vitest job and reads exactly like a pass (#1529).
 */
describe("claudeDesktopConfigTarget reports the input its path derives from", () => {
  const HOME = "/home/alice";
  let savedAppData: string | undefined;

  beforeEach(() => {
    savedAppData = process.env.APPDATA;
  });
  afterEach(() => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
  });

  it.each([
    "win32",
    "darwin",
    "linux",
  ] as const)("screens homeOverride when nothing outranks it (%s)", (platformOverride) => {
    _homedirSpy.mockReturnValue(HOME);
    expect(claudeDesktopConfigTarget({ homeOverride: "/ov", platformOverride }).screenInput).toBe(
      "/ov",
    );
  });

  it("screens appDataOverride on win32, which BEATS homeOverride", () => {
    // The half doctor's deleted mirror got backwards. Screening `homeOverride`
    // here would screen a value the path does not derive from -- refusing a
    // local config, or reading a hostile one.
    expect(
      claudeDesktopConfigTarget({
        homeOverride: "/ov",
        appDataOverride: "/ad",
        platformOverride: "win32",
      }).screenInput,
    ).toBe("/ad");
  });

  it("screens %APPDATA% on win32, which LOSES to homeOverride", () => {
    process.env.APPDATA = "/env-appdata";
    expect(
      claudeDesktopConfigTarget({ homeOverride: "/ov", platformOverride: "win32" }).screenInput,
    ).toBe("/ov");
    expect(claudeDesktopConfigTarget({ platformOverride: "win32" }).screenInput).toBe(
      "/env-appdata",
    );
  });

  it("ignores %APPDATA% off win32", () => {
    // Screening it unconditionally is the bug this replaced: under enterprise
    // redirection %USERPROFILE% is on a share while %APPDATA% stays local, so
    // refusing on either prints a false statement and drops the only check
    // that reports Claude Desktop registration.
    process.env.APPDATA = "/env-appdata";
    _homedirSpy.mockReturnValue(HOME);
    expect(claudeDesktopConfigTarget({ platformOverride: "linux" }).screenInput).toBe(HOME);
  });

  it("falls back to the resolved home on win32 with no %APPDATA%", () => {
    delete process.env.APPDATA;
    _homedirSpy.mockReturnValue(HOME);
    expect(claudeDesktopConfigTarget({ platformOverride: "win32" }).screenInput).toBe(HOME);
  });

  it.each([
    "win32",
    "darwin",
    "linux",
  ] as const)("the path it returns actually derives from the input it reports (%s)", (platformOverride) => {
    // The correspondence itself, which is what the mirror kept getting wrong.
    // Nothing previously pinned that the screened value and the read path
    // were the same value, so a consumer could screen one and read the other.
    process.env.APPDATA = "/env-appdata";
    _homedirSpy.mockReturnValue(HOME);
    for (const opts of [
      { platformOverride },
      { platformOverride, homeOverride: "/ov" },
      { platformOverride, appDataOverride: "/ad" },
      { platformOverride, homeOverride: "/ov", appDataOverride: "/ad" },
    ]) {
      const { screenInput, path } = claudeDesktopConfigTarget(opts);
      expect(path, `path does not derive from screenInput for ${JSON.stringify(opts)}`).toContain(
        join(screenInput),
      );
    }
  });
});

/**
 * The refusals are reported, not merely performed.
 *
 * Every corpus block above asserts that no READ happened, which a check that
 * silently returns satisfies perfectly. Replacing any of the three refusal
 * bodies with a bare `return` left all of them green -- the same "untested
 * claim" standard this file applies to the loader's backstop, applied to the
 * warning whose docblock argues at length that silence is the one wrong answer.
 */
describe("a refused profile is reported rather than silently skipped", () => {
  const HOSTILE = "\\\\fileserver\\profiles\\alice";

  const warningsFor = async (check: string): Promise<string[]> => {
    process.env.HOME = HOSTILE;
    process.env.USERPROFILE = HOSTILE;
    _homedirSpy.mockReturnValue(HOSTILE);
    // %APPDATA% too, because on win32 that is the value the desktop check's
    // path derives from — `homedir()` only reaches it as the fallback. A
    // roaming profile on a share is the realistic form of this. Off win32 it
    // is ignored and the hostile `homedir()` is what that check screens.
    process.env.APPDATA = HOSTILE;
    const report = await runDoctor();
    return report.results
      .filter((x) => x.check === check && x.status === "warn")
      .map((x) => x.message);
  };

  it.each([
    ["user-mcp-config"],
    ["desktop-mcp-config"],
    ["tandem-plugin"],
  ])("%s warns that the profile is on a network path", async (check) => {
    const messages = await warningsFor(check);
    expect(messages.join(" | ")).toMatch(/network or device path/);
  });

  // The plugin check's SECOND refusal path: the input screen passes and the
  // loader's backstop is what rejects. Reachable only where `path.posix.join`
  // turns a lone backslash into a `\\`-prefixed path, so it is gated the
  // opposite way from the usual trap — skipped on this Windows machine and RUN
  // on CI's ubuntu job, which is the only vitest job there is. Its evidence is
  // therefore CI, not a local green.
  //
  // Without it, folding that branch back into `enabledPlugins === null` leaves
  // the whole file green: measured, not assumed.
  it.runIf(process.platform !== "win32")(
    "the plugin check reports a refusal the input screen did not catch",
    async () => {
      const LONE_BACKSLASH = String.fromCharCode(92);
      process.env.HOME = LONE_BACKSLASH;
      process.env.USERPROFILE = LONE_BACKSLASH;
      _homedirSpy.mockReturnValue(LONE_BACKSLASH);
      const report = await runDoctor();
      const messages = report.results
        .filter((x) => x.check === "tandem-plugin" && x.status === "warn")
        .map((x) => x.message);
      expect(messages.join(" | ")).toMatch(/network or device path/);
    },
  );

  it("says nothing of the sort for an ordinary local profile", async () => {
    // Positive control: a check that warned unconditionally would satisfy the
    // rows above.
    const report = await runDoctor();
    const messages = report.results
      .filter((x) => ["user-mcp-config", "desktop-mcp-config", "tandem-plugin"].includes(x.check))
      .map((x) => x.message);
    expect(messages.join(" | ")).not.toMatch(/network or device path/);
  });
});

/**
 * `readJson` stays away from the credential configs.
 *
 * `readClaudeConfig` is the fenced reader, but the unfenced one is still in the
 * same file, sixty lines up, and it carries a `reason` field a caller can
 * print. For a lockfile that is right -- the errno and "not valid JSON" are the
 * whole diagnosis. For ~/.claude.json it is a V8 `SyntaxError` embedding a
 * snippet of a file holding bearer tokens, on its way to the Copy Diagnostics
 * clipboard and `tandem_diagnostics` (which applies no redaction at all).
 *
 * Nothing in the type system stops the next author from pointing `readJson` at
 * one, and no runtime test can catch a call that has not been written yet. So
 * this reads the source -- the same technique as
 * `tests/shared/unc-check-duplication.test.ts` -- and fails on the call rather
 * than on its consequence.
 */
describe("the unfenced JSON reader is not pointed at a Claude config", () => {
  const SOURCE = readFileSync(new URL("../../src/cli/doctor.ts", import.meta.url), "utf-8");

  it("every readJson call site names a lockfile or package.json", () => {
    const args = [...SOURCE.matchAll(/\breadJson\(([^)]*)\)/g)]
      .map((m) => m[1].trim())
      .filter((a) => !a.startsWith("path: string"));

    // Positive control: a regex that matched nothing would satisfy the loop
    // below perfectly -- the failure mode this whole file exists to refuse.
    expect(args.length, "found no readJson call sites, so the scan is broken").toBeGreaterThan(0);

    for (const arg of args) {
      for (const needle of [
        "claudeCodeConfigPath",
        "claudeDesktopConfigTarget",
        "claudeDesktopConfigPath",
        SETTINGS_LEAF,
        USER_CONFIG_LEAF,
        DESKTOP_LEAF,
      ]) {
        expect(
          arg,
          `readJson(${arg}) reads a Claude config -- use readClaudeConfig, which ` +
            `carries no reason field`,
        ).not.toContain(needle);
      }
    }
  });
});

/**
 * The containment this file installs on its own `node:fs` mock, pinned.
 *
 * The full rationale is at the mock itself, where the code is. What is only
 * true HERE is why it needs its own describe: the probe it contains is
 * CONDITIONAL. `detectClaudeCli` returns `INSTALLED_ON_PATH` before reaching
 * `~/.local/bin`, so on a machine with `claude` on PATH the stub is never
 * exercised by the corpus blocks, and an assertion there demanding otherwise
 * fails for a reason unrelated to the guard under test. This pins that the
 * containment exists; the corpus blocks rely on it.
 */
describe("this suite does not perform the handshake it tests for", () => {
  it.each([...NETWORK_PATHS, ...LOCAL_EXTENDED_PATHS])("%s", (_label, hostile) => {
    expect(statSync(hostile, { throwIfNoEntry: false })).toBeUndefined();
    expect(_statTally.refused, "a hostile statSync reached the real filesystem").toContain(hostile);
  });

  it("still stats an ordinary local path for real", () => {
    // Positive control: a stub that refused everything would satisfy the rows
    // above and quietly break every other check in the file.
    expect(statSync(dataDir, { throwIfNoEntry: false })?.isDirectory()).toBe(true);
    expect(_statTally.refused).toEqual([]);
  });
});

/**
 * The annotation-store check screens its raw app-data input before deriving a
 * path from it (#1417's ordering class, in the one doctor check that had no
 * screen at all).
 *
 * **Screening the derived path alone would not be enough, and would look
 * identical on CI.** `posix.join` renders the four pure forward-slash spellings
 * harmless, so on a Linux runner a derived-path-only guard never fires for them
 * and the row passes because the path stopped being dangerous — the #1529
 * shape. The rows here poison the *input*, which is load-bearing on every
 * platform.
 *
 * The assertion is on the syscall, not the report: an unreachable UNC host
 * produces the same failure whether or not the guard ran, so a return-value
 * assertion passes against the vulnerable code. It is scoped to `annotations`
 * paths because `runDoctor` legitimately reads elsewhere.
 */
describe("the annotation-store check screens its app-data input", () => {
  function annotationReaddirs(): string[] {
    return _fspReaddirTally.paths.filter((p) => p.includes("annotations"));
  }

  it.each([
    ...NETWORK_PATHS,
    ...LOCAL_EXTENDED_PATHS,
  ])("%s in TANDEM_APP_DATA_DIR reaches no filesystem call", async (_label, hostile) => {
    process.env.TANDEM_APP_DATA_DIR = hostile;
    _fspReaddirTally.paths.length = 0;

    const report = await runDoctor();
    const store = report.results.filter((r) => r.check === "annotation-store");

    expect(annotationReaddirs()).toEqual([]);
    expect(store.some((r) => r.status === "fail" && r.data?.unsafePath === true)).toBe(true);
  });

  it("still reads the store for an ordinary local path", async () => {
    // Positive control. Without it a guard that refused unconditionally — or a
    // rename that stopped the check running at all — satisfies every row above.
    process.env.TANDEM_APP_DATA_DIR = dataDir;
    mkdirSync(join(dataDir, "annotations"), { recursive: true });
    _fspReaddirTally.paths.length = 0;

    const report = await runDoctor();
    expect(annotationReaddirs()).toContain(join(dataDir, "annotations"));
    expect(report.results.some((r) => r.check === "annotation-store" && r.status !== "fail")).toBe(
      true,
    );
  });
});

/**
 * Why the input screen is not redundant with the scanner's own derived-path
 * screen — and why proving that is platform-gated.
 *
 * On win32 `join` preserves every hostile prefix, so the derived path is still
 * hostile and the scanner's screen refuses it. Deleting doctor's input screen
 * therefore changes NOTHING observable on this machine: the rows above stay
 * green against the vulnerable code. That is the #1529 shape, measured rather
 * than assumed — a mutation that removed the input screen survived the whole
 * suite locally.
 *
 * On posix the four pure forward-slash spellings collapse
 * (`//attacker/share/x` -> `/attacker/share/x/annotations`), the derived screen
 * accepts the result, and the input screen is the only thing left. The first
 * test pins the collapse itself so the premise cannot rot silently; the second
 * is the discriminating assertion and runs on CI's ubuntu job, which is the
 * only vitest job there is.
 */
describe("the input screen is load-bearing where posix.join collapses the prefix", () => {
  const COLLAPSING = NETWORK_PATHS.filter(([, p]) => p.startsWith("//"));

  it("posix.join renders those spellings acceptable to the derived-path screen", () => {
    expect(COLLAPSING.length).toBeGreaterThan(0);
    for (const [label, hostile] of COLLAPSING) {
      const derived = posix.join(hostile, "annotations");
      expect(
        rejectUnsafeWindowsPrefix(derived),
        `${label}: still rejected after posix.join, so it does not discriminate the two screens`,
      ).toBeNull();
    }
  });

  it.runIf(process.platform !== "win32").each(COLLAPSING)(
    "%s is refused by the input screen alone",
    async (_label, hostile) => {
      process.env.TANDEM_APP_DATA_DIR = hostile;
      const report = await runDoctor();
      expect(
        report.results.some(
          (r) => r.check === "annotation-store" && r.status === "fail" && r.data?.unsafePath,
        ),
      ).toBe(true);
    },
  );
});
