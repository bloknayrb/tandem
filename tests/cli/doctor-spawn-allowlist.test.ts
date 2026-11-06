import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every process `runDoctor` starts is on a closed allowlist, and none goes
 * through a shell (#2379).
 *
 * `runDoctor` runs from the shipped server for `tandem_diagnostics` and
 * `GET /api/diagnostics`, so a spawn resolved from PATH (or, under
 * `shell: true` on Windows, from the server's cwd) runs a planted binary
 * whenever diagnostics run.
 *
 * **Why the bundled-version define is stubbed, and why the import is
 * dynamic.** The stale-global check returns before it spawns anything unless
 * `__TANDEM_VERSION__` is defined, and `doctor.ts` reads that define into a
 * module-level const at import. Under vitest nothing defines it, so a static
 * import would reach a `runDoctor` that never spawns npm, and the allowlist
 * below would pass over an empty set. That is why the test also requires the
 * npm spawn to be present.
 *
 * **Why `process.execPath` is repointed.** The npm script is resolved beside
 * the running Node. A fixture keeps the spawn reachable whatever Node layout
 * the CI runner has.
 *
 * **Why both `child_process` specifiers are mocked.** `doctor.ts` and
 * `process-identity.ts` import `node:child_process`, while `platform.ts` imports
 * the bare `child_process`. A spawn through the unmocked one would escape the
 * recorder.
 *
 * **What this does not see.** Only spawns on the path the test reaches, on the
 * runner's OS: CI's `check` is Linux, with no live prior-boot store lock, so
 * the `tasklist` branch never runs there. And `vi.mock` intercepts only
 * modules Vite transforms, so a spawn through an externalized dependency
 * (`execa`, `cross-spawn`) or a `createRequire`d `child_process` would not be
 * recorded. Neither exists under `runDoctor` today.
 *
 * **Why `ps` gets its own test.** `runDoctor` reaches the store-lock owner
 * probe only for a live lock left from a prior boot, and on Linux that probe
 * reads `/proc` and never runs `ps`. So the `/bin/ps` anchor is pinned by
 * calling the probe directly with the platform set to darwin.
 */

const { calls } = vi.hoisted(() => ({
  calls: [] as { fn: string; cmd: unknown; args: unknown; opts: unknown }[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return recorderFor(actual);
});
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return recorderFor(actual);
});

function recorderFor<T extends object>(actual: T): T {
  const record =
    (fn: string) =>
    (cmd: unknown, ...rest: unknown[]) => {
      const args = Array.isArray(rest[0]) ? rest[0] : undefined;
      const opts = rest.find((r) => r !== null && typeof r === "object" && !Array.isArray(r));
      calls.push({ fn, cmd, args, opts });
      const cb = rest.find((r) => typeof r === "function") as
        | ((err: unknown, stdout: string, stderr: string) => void)
        | undefined;
      // Answer like a command that printed nothing: every caller treats empty
      // output as "skip", so no real process is ever started.
      if (cb) queueMicrotask(() => cb(new Error("recorded, not run"), "", ""));
      if (fn.endsWith("Sync")) throw new Error("recorded, not run");
      return undefined;
    };
  return {
    ...actual,
    execFile: record("execFile"),
    exec: record("exec"),
    spawn: record("spawn"),
    execFileSync: record("execFileSync"),
    execSync: record("execSync"),
    spawnSync: record("spawnSync"),
    fork: record("fork"),
  };
}

describe("runDoctor's spawns (#2379)", () => {
  let root: string;
  let fakeNode: string;
  let fakeCli: string;
  const realExecPath = process.execPath;

  beforeEach(() => {
    calls.length = 0;
    root = mkdtempSync(join(tmpdir(), "doctor-spawns-"));
    if (process.platform === "win32") {
      fakeNode = join(root, "nodejs", "node.exe");
      fakeCli = join(root, "nodejs", "node_modules", "npm", "bin", "npm-cli.js");
    } else {
      fakeNode = join(root, "bin", "node");
      fakeCli = join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    }
    mkdirSync(join(fakeCli, ".."), { recursive: true });
    writeFileSync(fakeCli, "// npm");
    Object.defineProperty(process, "execPath", { value: fakeNode, configurable: true });
    vi.stubGlobal("__TANDEM_VERSION__", "9.9.9-spawn-test");
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, "execPath", { value: realExecPath, configurable: true });
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  it("starts only allowlisted binaries, by absolute path, with no shell", async () => {
    const { runDoctor } = await import("../../src/cli/doctor.js");
    const { systemBin } = await import("../../src/server/platform.js");
    const { PS_BIN } = await import("../../src/server/annotations/process-identity.js");

    await runDoctor({ mcpPort: 1, wsPort: 1, vitePort: 1 });

    // Positive anchor: the stale-global check did run, through Tandem's Node.
    const npm = calls.filter((c) => c.cmd === fakeNode);
    expect(
      npm,
      "the stale-global check never spawned — the allowlist below would be vacuous",
    ).toHaveLength(1);
    const allowed = new Set([fakeNode, PS_BIN, systemBin("tasklist.exe")]);
    for (const c of calls) {
      // `exec`/`execSync` always run through a shell, with or without an option.
      expect(["exec", "execSync"], `${c.fn}(${String(c.cmd)}) always uses a shell`).not.toContain(
        c.fn,
      );
      // Tandem's own Node is allowed only to run the npm script, not `-e …`.
      if (c.cmd === fakeNode) expect((c.args as string[] | undefined)?.[0]).toBe(fakeCli);
      expect(allowed.has(c.cmd as string), `unexpected spawn: ${c.fn}(${String(c.cmd)})`).toBe(
        true,
      );
      expect(c.opts ?? {}, `${c.fn}(${String(c.cmd)}) passed a shell option`).not.toHaveProperty(
        "shell",
      );
    }
  });
});

describe("the store-lock owner probe's ps (#2379)", () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    calls.length = 0;
    vi.resetModules();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  });

  it("runs the absolute /bin/ps, never a PATH ps", async () => {
    const { probeProcessIdentity, PS_BIN } = await import(
      "../../src/server/annotations/process-identity.js"
    );
    await probeProcessIdentity(4242);

    expect(PS_BIN).toBe("/bin/ps");
    expect(calls.map((c) => c.cmd)).toEqual([PS_BIN]);
    expect(calls[0].opts ?? {}).not.toHaveProperty("shell");
  });
});
