import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2358 PR 2b, Bryan's decision 2 (2026-11-06): `tandem_diagnostics` never
 * runs the system-Node `--version` walk. It is reachable by the AI through
 * MCP, so it reports the last boot's cached verdict; only boot, `tandem
 * setup`, `tandem rotate-token` and the wizard's apply may walk.
 *
 * That is NOT "diagnostics spawns nothing": a release build's `runDoctor`
 * also runs `npm ls -g` (since #2391, Tandem's own Node running the
 * `npm-cli.js` beside it, with no shell) and may run the annotation store's
 * lock-holder probe (`/bin/ps`, or `tasklist.exe` on Windows).
 * `tests/cli/doctor-spawn-allowlist.test.ts` owns that allowlist; this file
 * adds the Node walk's half, so its runDoctor cases run as a release build
 * does — the same seam #2391 uses: `__TANDEM_VERSION__` stubbed, modules
 * reset, `doctor.ts` imported afresh — with `process.execPath` pointed at a
 * fixture that has `npm-cli.js` beside it, and require every spawn they see to
 * be on that allowlist, with no shell. What they can see is bounded: POSIX
 * only (this file skips Windows, and CI's `check` is Ubuntu), only the
 * branches this fixture reaches (no lock exists, so the lock-holder probe
 * does not run), and only spawns made through `child_process` from
 * transformed code.
 *
 * Everything else is the real code except two things: the temp-dir fixtures
 * are not treated as scratch (so an "installed" layout can live under
 * `os.tmpdir()`), and both `child_process` specifiers are wrapped so every
 * spawn is recorded (the npm and `ps` spawns are answered at once with empty
 * output rather than run; everything else really runs, which is how the
 * positive control's probe is seen). The fixture is a desktop-shaped install
 * (the injected bridge path, honoured only with `--tauri-sidecar` in argv)
 * plus a qualifying fake `node` on PATH that the walk WOULD pick.
 */

type Spawn = { fn: string; cmd: string; args: unknown; opts: unknown };
const { spawns, answered } = vi.hoisted(() => ({
  spawns: [] as Spawn[],
  /** Commands answered with empty output instead of being run. */
  answered: new Set<string>(),
}));

vi.mock("node:child_process", async (importOriginal) =>
  recorderFor(await importOriginal<typeof import("node:child_process")>()),
);
vi.mock("child_process", async (importOriginal) =>
  recorderFor(await importOriginal<typeof import("child_process")>()),
);

function recorderFor<T extends object>(actual: T): T {
  const wrap =
    (fn: string) =>
    (cmd: unknown, ...rest: unknown[]) => {
      const args = Array.isArray(rest[0]) ? rest[0] : undefined;
      const opts = rest.find((r) => r !== null && typeof r === "object" && !Array.isArray(r));
      spawns.push({ fn, cmd: String(cmd), args, opts });
      if (answered.has(String(cmd))) {
        const cb = rest.find((r) => typeof r === "function") as
          | ((e: Error | null, out: string, err: string) => void)
          | undefined;
        if (cb) queueMicrotask(() => cb(new Error("recorded, not run"), "", ""));
        if (fn.endsWith("Sync")) throw new Error("recorded, not run");
        return undefined;
      }
      return (actual[fn as keyof T] as (...a: unknown[]) => unknown)(cmd, ...rest);
    };
  return {
    ...actual,
    execFile: wrap("execFile"),
    execFileSync: wrap("execFileSync"),
    spawn: wrap("spawn"),
    spawnSync: wrap("spawnSync"),
    fork: wrap("fork"),
    exec: wrap("exec"),
    execSync: wrap("execSync"),
  };
}
const root = mkdtempSync(join(tmpdir(), "tandem-doctor-noprobe-"));
const mocks = vi.hoisted(() => ({ runningNode: undefined as string | undefined }));
vi.mock("../../src/server/integrations/node-binary.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/server/integrations/node-binary.js")>();
  return {
    ...real,
    resolveNodeBinary: (c?: string) => mocks.runningNode ?? real.resolveNodeBinary(c),
    isScratchPath: (p: string, d?: Parameters<typeof real.isScratchPath>[1]) =>
      p.startsWith(root) ? false : real.isScratchPath(p, d),
  };
});

// A desktop-shaped install, set up BEFORE apply.ts is imported: it resolves
// the bridge path at module load.
const script = join(root, "Tandem", "dist", "stdio-bridge", "index.js");
mkdirSync(join(script, ".."), { recursive: true });
writeFileSync(script, "");
// The fake Node must sit OUTSIDE every scratch root, or the walk refuses it
// and the negative assertions below would pass without a probe ever being
// possible. `node-binary.ts` calls its own `isScratchPath` internally, which no
// module mock reaches, so it lives in a gitignored directory of the checkout.
const fixtureRoot = join(
  import.meta.dirname,
  "..",
  "..",
  ".vitest-fixtures",
  `noprobe-${process.pid}`,
);
const nodeDir = join(fixtureRoot, "nodebin");
mkdirSync(nodeDir, { recursive: true });
const fakeNode = join(nodeDir, "node");
writeFileSync(fakeNode, "#!/bin/sh\necho v22.12.0\n");
chmodSync(fakeNode, 0o755);
const home = join(root, "home");
mkdirSync(home);
writeFileSync(
  join(home, ".claude.json"),
  JSON.stringify({
    mcpServers: {
      tandem: {
        type: "http",
        url: "http://127.0.0.1:3479/mcp",
        headers: { Authorization: `Bearer ${"t".repeat(40)}` },
      },
    },
  }),
);

const savedArgv = [...process.argv];
process.argv.push("--tauri-sidecar");
vi.stubEnv("TANDEM_STDIO_BRIDGE_DIST", script);
vi.stubEnv("TANDEM_TAURI_SIDECAR", "1");

const apply = await import("../../src/server/integrations/apply.js");
const nodeBinary = await import("../../src/server/integrations/node-binary.js");
const { PS_BIN } = await import("../../src/server/annotations/process-identity.js");
const { systemBin } = await import("../../src/server/platform.js");

// Tandem's own Node, as the stale-global check resolves it: a fixture with
// `npm-cli.js` beside it, so the npm anchor does not depend on the runner's
// Node layout.
const npmNode = join(root, "npm-node", "bin", "node");
const npmCli = join(root, "npm-node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
mkdirSync(join(npmCli, ".."), { recursive: true });
writeFileSync(npmCli, "// npm");
answered.add(npmNode);
answered.add(PS_BIN);
/** Every program the diagnostics path may start (`doctor-spawn-allowlist.test.ts`'s set). */
const DIAGNOSTICS_SPAWN_ALLOWLIST = new Set([npmNode, PS_BIN, systemBin("tasklist.exe")]);

afterAll(() => {
  process.argv.splice(0, process.argv.length, ...savedArgv);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  spawns.length = 0;
  nodeBinary._resetSystemNodeCacheForTests();
  vi.stubEnv("PATH", `${nodeDir}:/usr/bin:/bin`);
  vi.stubEnv("HOME", home);
  vi.stubEnv("TANDEM_APP_DATA_DIR", join(root, "appdata"));
});
afterEach(() => {
  mocks.runningNode = undefined;
});

/** Spawns of anything under the fixture roots except Tandem's own npm Node: the walk's probes. */
const probed = () =>
  spawns
    .map((s) => s.cmd)
    .filter((f) => f !== npmNode && (f.startsWith(root) || f.startsWith(fixtureRoot)));
/** What a spawn on the diagnostics path did wrong, if anything. */
function spawnProblems(): string[] {
  const out: string[] = [];
  for (const s of spawns) {
    const what = `${s.fn}(${s.cmd})`;
    if (s.fn === "exec" || s.fn === "execSync") out.push(`${what} always uses a shell`);
    if (!DIAGNOSTICS_SPAWN_ALLOWLIST.has(s.cmd)) out.push(`${what} is not allowlisted`);
    if (s.cmd === npmNode && (s.args as string[] | undefined)?.[0] !== npmCli) {
      out.push(`${what} ran something other than npm-cli.js`);
    }
    if (s.opts && typeof s.opts === "object" && "shell" in s.opts) {
      out.push(`${what} passed a shell option`);
    }
  }
  return out;
}
/** The stale-global check's npm spawns, through Tandem's own Node. */
const npmSpawns = () => spawns.filter((s) => s.cmd === npmNode);

/**
 * `runDoctor` as the shipped server runs it — the seam #2391 uses: the
 * bundled-version define stubbed, modules reset and `doctor.ts` imported
 * afresh (it reads the define into a module-level const), and
 * `process.execPath` pointed at the npm fixture for the call.
 */
async function runDoctorAsReleased() {
  const realExecPath = process.execPath;
  vi.stubGlobal("__TANDEM_VERSION__", "9.9.9-noprobe");
  vi.resetModules();
  Object.defineProperty(process, "execPath", { value: npmNode, configurable: true });
  try {
    const { runDoctor } = await import("../../src/cli/doctor.js");
    // The default MCP port: the fixture's entry names 3479, and the port
    // check would otherwise answer before the entry's own arm.
    return await runDoctor({ wsPort: 1, vitePort: 1 });
  } finally {
    Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
    vi.unstubAllGlobals();
  }
}

describe.skipIf(process.platform === "win32")("the diagnostics path never probes a Node", () => {
  it("the fixture really is an installed layout (so the verdict reaches the Node question)", () => {
    expect(apply.durableBridgeScript()).toBe(script);
  });

  it("claudeCodeBridgeVerdict reads the cache: unprobed, with no spawn", () => {
    mocks.runningNode = "node"; // the running Node cannot be recorded
    expect(apply.claudeCodeBridgeVerdict()).toBe("unprobed");
    expect(nodeBinary.peekSystemNode()).toBeUndefined();
    expect(probed()).toEqual([]);
  });

  it("runDoctor (tandem_diagnostics' collector), as released, spawns only what the allowlist names", async () => {
    mocks.runningNode = "node";
    const report = await runDoctorAsReleased();
    const row = report.results.find((x) => x.message.includes("older direct-HTTP entry"));
    expect(row, JSON.stringify(report.results.map((x) => x.message))).toBeDefined();
    // The release-build path really ran: its `npm ls` was seen, through Tandem's Node.
    expect(npmSpawns(), "the stale-global check never spawned").toHaveLength(1);
    expect(spawnProblems()).toEqual([]);
    expect(probed()).toEqual([]);
    expect(nodeBinary.peekSystemNode()).toBeUndefined();
  });

  it("positive control: the writers' warm-up DOES run the probe, and the verdict then reads it", async () => {
    mocks.runningNode = "node";
    await apply.warmClaudeCodeBridge();
    expect(probed()).toEqual([fakeNode]);
    expect(apply.resolveClaudeCodeBridge()).toEqual({ command: fakeNode, script });
    spawns.length = 0;
    expect(apply.claudeCodeBridgeVerdict()).toBe("bridge");
    await runDoctorAsReleased();
    expect(npmSpawns(), "the stale-global check never spawned").toHaveLength(1);
    expect(spawnProblems()).toEqual([]);
    expect(probed()).toEqual([]);
  });

  it("resolveClaudeCodeBridge, unpinned, takes the installed arm and the running Node when nothing probed", () => {
    // No `_setClaudeCodeBridgeForTests`: the real `durableBridgeScript()`.
    const exec = join(nodeDir, "node");
    mocks.runningNode = exec;
    expect(apply.resolveClaudeCodeBridge()).toEqual({ command: exec, script });
    expect(probed()).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")(
  "the writers that may probe do (#2358 PR 2b rework)",
  () => {
    it("rotate-token's applyConfigWithToken warms first, so the entry names the system Node", async () => {
      mocks.runningNode = "node"; // without the warm-up, nothing could be recorded
      const writeHome = join(root, "writer-home");
      mkdirSync(writeHome, { recursive: true });
      writeFileSync(join(writeHome, ".claude.json"), JSON.stringify({ mcpServers: {} }));
      const result = await apply.applyConfigWithToken("t".repeat(40), { homeOverride: writeHome });
      expect(result.errors).toEqual([]);
      expect(probed()).toEqual([fakeNode]);
      const { readFileSync } = await import("node:fs");
      const written = JSON.parse(readFileSync(join(writeHome, ".claude.json"), "utf-8"));
      expect(written.mcpServers.tandem).toMatchObject({ command: fakeNode, args: [script] });
    });

    it("setup and the wizard's apply warm before they build Claude Code's entry (source pin)", async () => {
      const { readFileSync } = await import("node:fs");
      const src = (rel: string) =>
        readFileSync(join(import.meta.dirname, "..", "..", rel), "utf-8");
      // Every caller of `buildMcpEntries` in src/, found rather than listed, so a
      // new writer that skips the warm-up fails here. `apply.ts` (rotate-token)
      // is covered behaviourally above.
      const { readdirSync, statSync } = await import("node:fs");
      const callers: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (
            /\.ts$/.test(name) &&
            readFileSync(p, "utf-8").includes("buildMcpEntries(CHANNEL_DIST")
          )
            callers.push(
              p.slice(join(import.meta.dirname, "..", "..").length + 1).replace(/\\/g, "/"),
            );
        }
      };
      walk(join(import.meta.dirname, "..", "..", "src"));
      expect(callers.sort()).toEqual([
        "src/cli/setup.ts",
        "src/server/integrations/api-routes.ts",
        "src/server/integrations/apply.ts",
      ]);
      for (const rel of callers) {
        const text = src(rel);
        const warm = text.search(
          /if \(\w+\.kind === "claude-code"\) await warmClaudeCodeBridge\(\);/,
        );
        const build = text.indexOf("buildMcpEntries(CHANNEL_DIST", warm);
        expect(warm, `${rel} no longer warms`).toBeGreaterThan(-1);
        expect(build - warm, `${rel}: the warm-up must sit right before the build`).toBeLessThan(
          200,
        );
      }
    });
  },
);

describe.skipIf(process.platform === "win32")("durableRunningNode (the npm fallback)", () => {
  it("records Homebrew's stable opt link for a Cellar Node, not the version folder", async () => {
    const { symlinkSync } = await import("node:fs");
    const prefix = join(fixtureRoot, "homebrew");
    const cellarBin = join(prefix, "Cellar", "node", "23.1.0", "bin");
    mkdirSync(cellarBin, { recursive: true });
    writeFileSync(join(cellarBin, "node"), "");
    mkdirSync(join(prefix, "opt"), { recursive: true });
    symlinkSync("../Cellar/node/23.1.0", join(prefix, "opt", "node"));
    // `process.execPath` names the real Cellar path, as Homebrew's Node reports it.
    mocks.runningNode = join(cellarBin, "node");
    expect(apply.durableRunningNode()).toBe(join(prefix, "opt", "node", "bin", "node"));
  });

  it("refuses a running Node below the 22.12 floor, as the PATH walk does", () => {
    mocks.runningNode = fakeNode;
    expect(apply.durableRunningNode(process.env, "v22.13.0")).toBe(fakeNode);
    expect(apply.durableRunningNode(process.env, "v22.11.0")).toBeNull();
  });
});
