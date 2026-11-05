import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_NODE_VERSION } from "../../../src/cli/doctor.js";
import {
  _resetSystemNodeCacheForTests,
  findSystemNode,
  findSystemNodeAsync,
  isAppImageMountPath,
  isWalkablePathEntry,
  type LinkStat,
  meetsSystemNodeFloor,
  SYSTEM_NODE_MAX_PROBES,
  SYSTEM_NODE_MIN_VERSION,
  screenedRealPath,
  systemNodeCandidates,
} from "../../../src/server/integrations/node-binary.js";
import { NETWORK_PATHS } from "../../helpers/unc-fixtures.js";

const UNC_SPELLINGS = NETWORK_PATHS.map(([, p]) => p);

/**
 * #2358 PR 2b — "Prefer system Node" (Bryan, 2026-11-05). The PATH walk that
 * picks the Node Claude Code's bridge entry names. Design §3.6, "Rule: which
 * Node". Windows cases inject `platform: "win32"` and fake filesystem calls,
 * so `path.win32` decides absoluteness and the UNC screens really run on Linux
 * CI — a native `path` would call `\\host\share` relative and skip it for the
 * wrong reason.
 */

const file = (): LinkStat => ({ isSymbolicLink: () => false, isFile: () => true });
const dir = (): LinkStat => ({ isSymbolicLink: () => false, isFile: () => false });
const link = (): LinkStat => ({ isSymbolicLink: () => true, isFile: () => false });

afterEach(() => _resetSystemNodeCacheForTests());

describe("the floor is engines.node", () => {
  it("matches package.json and doctor's MIN_NODE_VERSION", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf-8"));
    expect(pkg.engines.node).toBe(`>=${SYSTEM_NODE_MIN_VERSION}`);
    expect(MIN_NODE_VERSION).toBe(SYSTEM_NODE_MIN_VERSION);
  });

  it.each([
    ["v22.12.0", true],
    ["v22.12.1", true],
    ["v23.0.0-rc.1", true],
    ["v22.11.9", false],
    ["v20.18.0", false],
    ["node", false],
    ["", false],
  ])("%s → %s", (out, ok) => {
    expect(meetsSystemNodeFloor(`${out}\n`)).toBe(ok);
  });
});

describe("which PATH entries are walked at all (no filesystem call before this)", () => {
  it.each(UNC_SPELLINGS)("refuses the UNC spelling %s on win32", (unc) => {
    expect(isWalkablePathEntry(unc, "win32")).toBe(false);
  });

  it.each([
    ["relative", "bin", "win32"],
    ["dot", ".", "win32"],
    ["root-relative", "\\bin", "win32"],
    ["dot-dot", "C:\\a\\..\\b", "win32"],
    ["relative", "bin", "linux"],
    ["dot", ".", "linux"],
    ["dot-dot", "/a/../b", "linux"],
    ["Volta shim", "/home/u/.volta/bin", "linux"],
    ["Volta shim (win)", "C:\\Users\\u\\AppData\\Local\\Volta\\bin", "win32"],
    ["asdf shims", "/home/u/.asdf/shims", "linux"],
    ["mise shims", "/home/u/.local/share/mise/shims", "linux"],
    ["fnm per-shell", "/run/user/1000/fnm_multishells/123_456/bin", "linux"],
    ["a project's node_modules", "/home/u/proj/node_modules/.bin", "linux"],
  ] as const)("refuses a %s entry (%s)", (_name, entry, platform) => {
    expect(isWalkablePathEntry(entry, platform)).toBe(false);
  });

  it.each(UNC_SPELLINGS)("refuses the UNC spelling %s on linux too", (unc) => {
    // Without the screen, the `//host/share` spellings would pass the POSIX
    // absolute test here.
    expect(isWalkablePathEntry(unc, "linux")).toBe(false);
  });

  it("accepts ordinary absolute entries, Volta's versioned image included", () => {
    expect(isWalkablePathEntry("/usr/local/bin", "linux")).toBe(true);
    expect(isWalkablePathEntry("/home/u/.volta/tools/image/node/22.12.0/bin", "linux")).toBe(true);
    expect(isWalkablePathEntry("C:\\Program Files\\nodejs", "win32")).toBe(true);
  });

  it("never lstats a UNC entry", () => {
    const lstat = vi.fn(file);
    systemNodeCandidates({
      platform: "win32",
      pathVar: UNC_SPELLINGS.join(";"),
      lstat,
      readlink: () => "",
      env: {},
    });
    expect(lstat).not.toHaveBeenCalled();
  });
});

describe("screenedRealPath follows a link only after screening its target", () => {
  it("refuses a junction in a PARENT component that points at a share, before following it", () => {
    const lstat = vi.fn((p: string) =>
      p === "C:\\Tools" ? link() : p.endsWith("node.exe") ? file() : dir(),
    );
    const readlink = vi.fn(() => "\\\\attacker\\share");
    expect(
      screenedRealPath("C:\\Tools\\nodejs\\node.exe", { platform: "win32", lstat, readlink }),
    ).toBeNull();
    // Nothing below the junction was inspected.
    expect(lstat.mock.calls.map((c) => c[0])).not.toContain("C:\\Tools\\nodejs");
  });

  it("records nvm-windows' symlink by its real, versioned target", () => {
    const lstat = (p: string) =>
      p === "C:\\Program Files\\nodejs" ? link() : p.endsWith("node.exe") ? file() : dir();
    const readlink = () => "C:\\Users\\u\\AppData\\Roaming\\nvm\\v22.12.0";
    expect(
      screenedRealPath("C:\\Program Files\\nodejs\\node.exe", {
        platform: "win32",
        lstat,
        readlink,
      }),
    ).toBe("C:\\Users\\u\\AppData\\Roaming\\nvm\\v22.12.0\\node.exe");
  });

  it("strips the extended-length drive prefix a junction target carries", () => {
    const lstat = (p: string) => (p === "C:\\j" ? link() : dir());
    expect(
      screenedRealPath("C:\\j\\x", { platform: "win32", lstat, readlink: () => "\\\\?\\D:\\real" }),
    ).toBe("D:\\real\\x");
  });

  it("gives up on a link loop", () => {
    const lstat = (p: string) => (p === "/a" ? link() : dir());
    expect(
      screenedRealPath("/a/node", { platform: "linux", lstat, readlink: () => "/a" }),
    ).toBeNull();
  });
});

describe("the PATH walk on a real filesystem (POSIX)", () => {
  let root: string;
  const makeNode = (d: string): string => {
    mkdirSync(d, { recursive: true });
    const p = join(d, "node");
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    return p;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tandem-sysnode-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // The real temp dir is a scratch root (refused), so these walks pass an
  // empty scratch list; the scratch refusal has its own test.
  const deps = (pathVar: string, runVersion: (p: string) => string | null) => ({
    pathVar,
    platform: "linux" as const,
    scratchRoots: [],
    env: {},
    runVersion,
  });

  it("picks the first qualifying Node, skipping one below the floor", () => {
    const old = makeNode(join(root, "old"));
    const good = makeNode(join(root, "good"));
    const versions = new Map([
      [old, "v20.0.0\n"],
      [good, "v22.12.0\n"],
    ]);
    expect(findSystemNode(deps(`${root}/old:${root}/good`, (p) => versions.get(p) ?? null))).toBe(
      good,
    );
  });

  it("refuses a `node` link to some other program by its real basename", () => {
    mkdirSync(join(root, "bin"));
    const python = join(root, "python3");
    writeFileSync(python, "");
    symlinkSync(python, join(root, "bin", "node"));
    expect(findSystemNode(deps(`${root}/bin`, () => "v22.12.0"))).toBeNull();
  });

  it("refuses a link into a shim directory by its real path", () => {
    const shim = makeNode(join(root, ".asdf", "shims"));
    mkdirSync(join(root, "bin"));
    symlinkSync(shim, join(root, "bin", "node"));
    expect(findSystemNode(deps(`${root}/bin`, () => "v22.12.0"))).toBeNull();
  });

  it("refuses a Node under a scratch root", () => {
    makeNode(join(root, "bin"));
    expect(
      findSystemNode({ ...deps(`${root}/bin`, () => "v22.12.0"), scratchRoots: [root] }),
    ).toBeNull();
  });

  it("refuses a world-writable directory", () => {
    const n = makeNode(join(root, "ww"));
    chmodSync(join(root, "ww"), 0o777);
    expect(findSystemNode(deps(`${root}/ww`, () => "v22.12.0"))).toBeNull();
    chmodSync(join(root, "ww"), 0o755);
    expect(findSystemNode(deps(`${root}/ww`, () => "v22.12.0"))).toBe(n);
  });

  it(`version-probes at most ${SYSTEM_NODE_MAX_PROBES} candidates`, () => {
    const dirs = Array.from({ length: SYSTEM_NODE_MAX_PROBES + 3 }, (_, i) => join(root, `n${i}`));
    for (const d of dirs) makeNode(d);
    const run = vi.fn(() => null);
    expect(findSystemNode(deps(dirs.join(":"), run))).toBeNull();
    expect(run).toHaveBeenCalledTimes(SYSTEM_NODE_MAX_PROBES);
  });

  it("the async twin agrees", async () => {
    const good = makeNode(join(root, "good"));
    expect(
      await findSystemNodeAsync({
        ...deps(`${root}/good`, () => null),
        runVersionAsync: async () => "v24.1.0",
      }),
    ).toBe(good);
  });

  it("really runs --version, bounded, and skips a binary that hangs", () => {
    const slow = join(root, "slow");
    mkdirSync(slow);
    writeFileSync(join(slow, "node"), "#!/bin/sh\nsleep 10\n");
    chmodSync(join(slow, "node"), 0o755);
    const fast = join(root, "fast");
    mkdirSync(fast);
    writeFileSync(join(fast, "node"), "#!/bin/sh\necho v22.13.0\n");
    chmodSync(join(fast, "node"), 0o755);
    const started = Date.now();
    expect(
      findSystemNode({
        pathVar: `${slow}:${fast}`,
        platform: "linux",
        scratchRoots: [],
        env: {},
      }),
    ).toBe(join(fast, "node"));
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);

  it("strips NODE_OPTIONS and the server's secrets from the probe's environment", () => {
    const n = join(root, "envnode");
    mkdirSync(n);
    // Prints a version only when the environment is clean.
    writeFileSync(
      join(n, "node"),
      '#!/bin/sh\n[ -z "$NODE_OPTIONS" ] && [ -z "$TANDEM_AUTH_TOKEN" ] && echo v22.12.0\n',
    );
    chmodSync(join(n, "node"), 0o755);
    vi.stubEnv("NODE_OPTIONS", "--require /nope.js");
    vi.stubEnv("TANDEM_AUTH_TOKEN", "x".repeat(40));
    try {
      expect(findSystemNode({ pathVar: n, platform: "linux", scratchRoots: [], env: {} })).toBe(
        join(n, "node"),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("isAppImageMountPath", () => {
  it("recognises the runtime's mount by name and by APPDIR", () => {
    expect(isAppImageMountPath("/tmp/.mount_TandemAbc123/usr/lib/Tandem/x.js", {})).toBe(true);
    expect(isAppImageMountPath("/opt/app/usr/lib/x.js", { APPDIR: "/opt/app" })).toBe(true);
    expect(isAppImageMountPath("/opt/apple/x.js", { APPDIR: "/opt/app" })).toBe(false);
    expect(isAppImageMountPath("/usr/lib/tandem/x.js", {})).toBe(false);
  });
});
