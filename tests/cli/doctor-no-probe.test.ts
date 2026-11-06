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
 * also runs `npm ls -g` through a shell (`checkStaleGlobal`, filed as #2379
 * and fixed in its own PR) and, on POSIX, may run `ps` for the annotation
 * store's lock holder. So the runDoctor cases run the stale-global check as a
 * release build does (`bundledVersionForTests`) and assert that EVERY spawn is
 * on an explicit allowlist — a new spawn on the diagnostics path fails here.
 *
 * Everything else is the real code except two things: the temp-dir fixtures
 * are not treated as scratch (so an "installed" layout can live under
 * `os.tmpdir()`), and `child_process` is wrapped so every spawn is recorded
 * (`npm` is answered at once with empty output rather than run). The fixture
 * is a desktop-shaped install (the injected bridge path, honoured only with
 * `--tauri-sidecar` in argv) plus a qualifying fake `node` on PATH that the
 * probe WOULD pick — the positive control proves it.
 */

/** Every program the diagnostics path may spawn, and why. */
const DIAGNOSTICS_SPAWN_ALLOWLIST = new Set([
  "npm", // checkStaleGlobal's `npm ls -g` — predates PR 2b; #2379
  "ps", // probeProcessIdentity, the annotation-store lock holder (POSIX)
]);

const root = mkdtempSync(join(tmpdir(), "tandem-doctor-noprobe-"));
const spawned: string[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const record =
    <F extends (...a: never[]) => unknown>(fn: F) =>
    (...args: Parameters<F>) => {
      spawned.push(String(args[0]));
      return fn(...args);
    };
  // `npm ls -g` is recorded and answered with empty output, not run.
  const execFile = (...args: unknown[]) => {
    if (args[0] === "npm") {
      spawned.push("npm");
      const cb = args.find((a) => typeof a === "function") as
        | ((e: Error | null, out: string, err: string) => void)
        | undefined;
      queueMicrotask(() => cb?.(null, "", ""));
      return undefined;
    }
    return record(actual.execFile as never)(...(args as never[]));
  };
  return {
    ...actual,
    execFile,
    execFileSync: record(actual.execFileSync as never),
    spawn: record(actual.spawn as never),
    spawnSync: record(actual.spawnSync as never),
    exec: record(actual.exec as never),
    execSync: record(actual.execSync as never),
  };
});
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
const { runDoctor } = await import("../../src/cli/doctor.js");

afterAll(() => {
  process.argv.splice(0, process.argv.length, ...savedArgv);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  spawned.length = 0;
  nodeBinary._resetSystemNodeCacheForTests();
  vi.stubEnv("PATH", `${nodeDir}:/usr/bin:/bin`);
  vi.stubEnv("HOME", home);
  vi.stubEnv("TANDEM_APP_DATA_DIR", join(root, "appdata"));
});
afterEach(() => {
  mocks.runningNode = undefined;
});

const probed = () => spawned.filter((f) => f.startsWith(root) || f.startsWith(fixtureRoot));
/** Spawns the diagnostics path made that are not on the allowlist. */
const unlisted = () => spawned.filter((f) => !DIAGNOSTICS_SPAWN_ALLOWLIST.has(f));
const runDoctorAsReleased = () => runDoctor({ bundledVersionForTests: "9.9.9" });

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
    // The release-build path really ran: its `npm ls` was seen.
    expect(spawned).toContain("npm");
    expect(unlisted(), `unlisted spawns: ${JSON.stringify(spawned)}`).toEqual([]);
    expect(probed()).toEqual([]);
    expect(nodeBinary.peekSystemNode()).toBeUndefined();
  });

  it("positive control: the writers' warm-up DOES run the probe, and the verdict then reads it", async () => {
    mocks.runningNode = "node";
    await apply.warmClaudeCodeBridge();
    expect(probed()).toEqual([fakeNode]);
    expect(apply.resolveClaudeCodeBridge()).toEqual({ command: fakeNode, script });
    spawned.length = 0;
    expect(apply.claudeCodeBridgeVerdict()).toBe("bridge");
    await runDoctorAsReleased();
    expect(unlisted()).toEqual([]);
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
