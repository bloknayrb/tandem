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
  isDurableNodeRealPath,
  isUnderWindowsInstallRoot,
  isWalkablePathEntry,
  type LinkStat,
  meetsSystemNodeFloor,
  SYSTEM_NODE_MAX_PROBES,
  SYSTEM_NODE_MIN_VERSION,
  screenedRealPath,
  stableManagerPath,
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
    ["Scoop shims", "C:\\Users\\u\\scoop\\shims", "win32"],
    ["Scoop global shims", "C:\\ProgramData\\scoop\\shims", "win32"],
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

// POSIX-only: shell-script stand-ins for `node` (`#!/bin/sh`, `chmod 0o755`) and
// symlinks, judged with `platform: "linux"`. Skipped on a Windows host, where
// none of that holds; CI's Linux `check` leg runs it on every push.
const ON_WINDOWS = process.platform === "win32";

describe.skipIf(ON_WINDOWS)("the PATH walk on a real filesystem (POSIX)", () => {
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

  it("the async default probe is bounded too, and kills a binary that hangs", async () => {
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
      await findSystemNodeAsync({
        pathVar: `${slow}:${fast}`,
        platform: "linux",
        scratchRoots: [],
        env: {},
      }),
    ).toBe(join(fast, "node"));
    expect(Date.now() - started).toBeLessThan(8000);
  }, 15_000);

  it("concurrent default-argument callers share one walk", async () => {
    const a = findSystemNodeAsync();
    const b = findSystemNodeAsync();
    expect(a).toBe(b);
    await a; // no probe left running past the test
  });

  it("strips NODE_OPTIONS and the server's secrets from the probe's environment", async () => {
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
      expect(
        await findSystemNodeAsync({ pathVar: n, platform: "linux", scratchRoots: [], env: {} }),
      ).toBe(join(n, "node"));
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

describe("Windows: only Program Files and the user's profile (Bryan, 2026-11-06)", () => {
  const env = {
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    USERPROFILE: "C:\\Users\\bryan",
  };
  const file = { isSymbolicLink: () => false, isFile: () => true };
  const durable = (real: string, e: NodeJS.ProcessEnv = env) =>
    isDurableNodeRealPath(real, { platform: "win32", env: e, lstat: () => file, scratchRoots: [] });

  it.each([
    ["the Node installer", "C:\\Program Files\\nodejs\\node.exe"],
    ["a 32-bit install", "C:\\Program Files (x86)\\nodejs\\node.exe"],
    ["nvm-windows", "C:\\Users\\bryan\\AppData\\Roaming\\nvm\\v22.12.0\\node.exe"],
    ["Scoop", "C:\\Users\\bryan\\scoop\\apps\\nodejs\\current\\node.exe"],
    ["a different case", "c:\\program files\\NodeJS\\node.exe"],
  ])("accepts %s", (_label, real) => {
    expect(durable(real)).toBe(true);
  });

  it.each([
    ["a folder under the drive root", "C:\\tools\\bin\\node.exe"],
    ["another drive", "D:\\nodejs\\node.exe"],
    ["a sibling sharing the prefix", "C:\\Program Files Evil\\node.exe"],
    ["another user's profile", "C:\\Users\\mallory\\node\\node.exe"],
    ["ProgramData (Chocolatey's shims)", "C:\\ProgramData\\chocolatey\\bin\\node.exe"],
    // 8.3 short names (smoke finding 1): one INSIDE the root used to be refused
    // only because the prefix test missed; one BELOW it was accepted and
    // recorded as the alias.
    ["an 8.3 alias of Program Files", "C:\\PROGRA~1\\nodejs\\node.exe"],
    ["an 8.3 folder below Program Files", "C:\\Program Files\\NODEJS~1\\node.exe"],
    [
      "an 8.3 folder in the profile",
      "C:\\Users\\bryan\\AppData\\Roaming\\nvm\\V2212~1.0\\node.exe",
    ],
  ])("refuses %s", (_label, real) => {
    expect(durable(real)).toBe(false);
  });

  it("an unset, relative or drive-root variable contributes no root", () => {
    expect(durable("C:\\Program Files\\nodejs\\node.exe", {})).toBe(false);
    expect(isUnderWindowsInstallRoot("C:\\x\\node.exe", { USERPROFILE: "C:\\" })).toBe(false);
    expect(isUnderWindowsInstallRoot("C:\\x\\node.exe", { USERPROFILE: "x" })).toBe(false);
    // Values that only normalise to the drive root.
    for (const v of ["C:\\.", "C:\\x\\..", "C:/./"]) {
      expect(isUnderWindowsInstallRoot("C:\\tools\\bin\\node.exe", { USERPROFILE: v })).toBe(false);
    }
    expect(
      isUnderWindowsInstallRoot("C:\\Users\\b\\n.exe", { USERPROFILE: "C:\\Users\\b\\" }),
    ).toBe(true);
  });

  it("POSIX is unaffected (ownership decides there)", () => {
    expect(
      isDurableNodeRealPath("/usr/bin/node", {
        platform: "linux",
        env: {},
        lstat: () => file,
        scratchRoots: [],
        ownerStat: () => ({ uid: 0, mode: 0o755 }),
        uid: 1000,
      }),
    ).toBe(true);
  });
});

describe("version managers that delete old versions: record their stable link (Bryan, 2026-11-06)", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "tandem-stable-"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** A Homebrew prefix: Cellar/node/<v>/bin/node, bin/node → it, opt/node → Cellar/node/<v>. */
  const brew = (versions: string[], optAt: string | null) => {
    const prefix = join(base, "homebrew");
    for (const v of versions) {
      const bin = join(prefix, "Cellar", "node", v, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "node"), `#!/bin/sh\necho v${v}\n`);
      chmodSync(join(bin, "node"), 0o755);
    }
    const newest = versions[versions.length - 1] as string;
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync(`../Cellar/node/${newest}/bin/node`, join(prefix, "bin", "node"));
    if (optAt !== null) {
      mkdirSync(join(prefix, "opt"), { recursive: true });
      symlinkSync(`../Cellar/node/${optAt}`, join(prefix, "opt", "node"));
    }
    return prefix;
  };
  const walk = (pathVar: string) =>
    findSystemNodeAsync({ pathVar, platform: "linux", scratchRoots: [], env: {} });

  // POSIX-only, like the real-filesystem walk above.
  it.skipIf(ON_WINDOWS)(
    "Homebrew: records <prefix>/opt/node/bin/node, not the Cellar version directory",
    async () => {
      const prefix = brew(["23.1.0"], "23.1.0");
      expect(await walk(join(prefix, "bin"))).toBe(join(prefix, "opt", "node", "bin", "node"));
    },
  );

  it.skipIf(ON_WINDOWS)(
    "Homebrew: keeps the real path when no opt link exists, or it names another version",
    async () => {
      const none = brew(["23.1.0"], null);
      expect(await walk(join(none, "bin"))).toBe(
        join(none, "Cellar", "node", "23.1.0", "bin", "node"),
      );
      rmSync(none, { recursive: true, force: true });
      const other = brew(["22.12.0", "23.1.0"], "22.12.0");
      expect(await walk(join(other, "bin"))).toBe(
        join(other, "Cellar", "node", "23.1.0", "bin", "node"),
      );
    },
  );

  it.skipIf(ON_WINDOWS)("nvm keeps the real, versioned path (it keeps old versions)", async () => {
    const v = join(base, ".nvm", "versions", "node", "v22.12.0", "bin");
    mkdirSync(v, { recursive: true });
    writeFileSync(join(v, "node"), "#!/bin/sh\necho v22.12.0\n");
    chmodSync(join(v, "node"), 0o755);
    expect(await walk(v)).toBe(join(v, "node"));
  });

  it("Scoop: records apps\\nodejs\\current, not the version directory", () => {
    const real = "C:\\Users\\u\\scoop\\apps\\nodejs\\22.12.0\\node.exe";
    const isLink = (p: string) => p.toLowerCase() === "c:\\users\\u\\scoop\\apps\\nodejs\\current";
    const deps = {
      platform: "win32" as const,
      env: { USERPROFILE: "C:\\Users\\u" },
      scratchRoots: [],
      lstat: (p: string) => ({ isSymbolicLink: () => isLink(p), isFile: () => p.endsWith(".exe") }),
      readlink: () => "C:\\Users\\u\\scoop\\apps\\nodejs\\22.12.0",
    };
    expect(stableManagerPath(real, deps)).toBe(
      "C:\\Users\\u\\scoop\\apps\\nodejs\\current\\node.exe",
    );
    // `current` pointing elsewhere: the real path stays.
    expect(
      stableManagerPath(real, {
        ...deps,
        readlink: () => "C:\\Users\\u\\scoop\\apps\\nodejs\\23.0.0",
      }),
    ).toBe(real);
    // Already `current`: nothing to do.
    const cur = "C:\\Users\\u\\scoop\\apps\\nodejs\\current\\node.exe";
    expect(stableManagerPath(cur, deps)).toBe(cur);
  });
});
