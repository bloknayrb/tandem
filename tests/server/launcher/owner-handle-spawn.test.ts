/**
 * The launcher's half of the owner handle, through the REAL spawn path (#2358
 * PR 3a, Requirements 1 and 4; Rulings D4, D11, D14, M): `createSupervisor`
 * with `spawn` unmocked and `stub-claude-cli.cjs` as the child, as
 * `stream-json-protocol.test.ts` runs it. The stub reads the run files from
 * the paths in ITS OWN argv and records what it found, so a supervisor that
 * wrote one path and passed another fails here.
 *
 * Flag on for the whole file, except the dark block at the end. The chain
 * through the real bridge and server is owner-handle-chain.test.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import { RUN_FILE_SWEEP_AGE_MS, type RunFileAcl } from "../../../src/server/launcher/run-files.js";
import {
  buildClaudeArgs,
  childEnv,
  createSupervisor as createRealSupervisor,
  LicenseRefusedError,
  type Supervisor,
} from "../../../src/server/launcher/supervisor.js";
import type { AiRefusal } from "../../../src/server/license/ai-refusal.js";
import {
  judgeBind,
  ownerHandleBindSnapshotForTests,
  resetOwnerHandleBindForTests,
} from "../../../src/server/sessions/owner-handle-bind.js";
import { CLAUDE_STREAM_JSON_FLAGS } from "../../../src/shared/launcher/contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_SOURCE = path.join(HERE, "stub-claude-cli.cjs");
const HANDLE_RE = /^th_[A-Za-z0-9_-]{32}$/;
const NO_ACL: RunFileAcl = {
  assertOwned: async () => {},
  lockDir: async () => {},
  verifyNoBroadAce: async () => {},
};
const REFUSAL: AiRefusal = {
  error: "LICENSE_REQUIRED",
  kind: "unlicensed",
  message: "Tandem is unlicensed, so its AI features are turned off.",
};
const ENV_KEYS = [
  "TANDEM_REAPER_PATH",
  "TANDEM_TAURI_SIDECAR",
  "NODE_ENV",
  "TANDEM_CLAUDE_CMD",
  "TANDEM_STUB_CLAUDE_RECORD_DIR",
  "TANDEM_STUB_CLAUDE_EXIT_DELAY_MS",
] as const;
const POSIX = process.platform !== "win32";

let tmpDir: string;
let spawnDir: string;
let recordDir: string;
let bridgeScript: string;
const savedEnv: Record<string, string | undefined> = {};
const supervisors: Supervisor[] = [];

interface SpawnRecord {
  pid: number;
  claudeArgs: string[];
}
interface RunFilesRecord {
  pid: number;
  mcpConfigPath?: string;
  settingsPath?: string;
  sessionId?: string;
  mcp?: {
    ok: boolean;
    value?: {
      mcpServers: { tandem: { command: string; args: string[]; env: Record<string, string> } };
    };
  };
  settings?: { ok: boolean; value?: { enabledPlugins: Record<string, boolean> } };
}

function records<T>(prefix: string): T[] {
  return fs
    .readdirSync(recordDir)
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .map((n) => JSON.parse(fs.readFileSync(path.join(recordDir, n), "utf8")) as T);
}

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every console.error line from here on, passed through to the real console. */
function captureErrors(): () => string[] {
  const lines: string[] = [];
  const real = console.error.bind(console);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
    real(...args);
  });
  return () => lines;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const launcherDir = () => path.join(tmpDir, "launcher");
const runFilesOnDisk = () =>
  fs.existsSync(launcherDir())
    ? fs.readdirSync(launcherDir()).filter((n) => n.startsWith("tandem-run-"))
    : [];

type Opts = Parameters<typeof createRealSupervisor>[0];
function makeSupervisor(extra: Partial<Opts> = {}): Supervisor {
  const sup = createRealSupervisor({
    integrationsBase: tmpDir,
    homeOverride: fs.realpathSync(os.tmpdir()),
    getBoundMcpAddress: () => ({ address: "127.0.0.1", port: 45678 }),
    stdioBridgeScript: bridgeScript,
    runFileAcl: NO_ACL,
    claudeSettingsHome: path.join(tmpDir, "home"),
    storeLockHeld: () => true,
    restartBackoffsMs: [50],
    ...extra,
  });
  supervisors.push(sup);
  return sup;
}

async function writeIntegration(): Promise<void> {
  const file: IntegrationsFile = {
    schemaVersion: 3,
    integrations: [
      {
        kind: "claude-code",
        id: "active",
        label: "Active Claude",
        configPath: POSIX ? "/home/test/.claude.json" : "C:\\Users\\test\\.claude.json",
        transport: "http",
        url: "http://127.0.0.1:3479/mcp",
        apply: "create",
        workingDirectory: spawnDir,
      },
    ],
  };
  await createIntegrationsStore(tmpDir).write(file);
}

const flagsIn = (args: string[]) => args.filter((a) => a === "--mcp-config" || a === "--settings");
const runRecordFor = (pid: number) =>
  records<RunFilesRecord>("runfiles-").find((r) => r.pid === pid);

beforeEach(async () => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oh-spawn-")));
  spawnDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oh-spawn-cwd-")));
  recordDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oh-spawn-rec-")));
  fs.copyFileSync(STUB_SOURCE, path.join(spawnDir, String(process.pid)));
  bridgeScript = path.join(recordDir, "bridge.js");
  fs.writeFileSync(bridgeScript, "// stands in for the bridge dist; never run here\n");
  process.env.NODE_ENV = "test";
  delete process.env.TANDEM_TAURI_SIDECAR;
  process.env.TANDEM_REAPER_PATH = process.execPath;
  const sentinel = path.join(recordDir, `stub-claude${POSIX ? "" : ".exe"}`);
  fs.writeFileSync(sentinel, "", { mode: 0o755 });
  process.env.TANDEM_CLAUDE_CMD = sentinel;
  process.env.TANDEM_STUB_CLAUDE_RECORD_DIR = recordDir;
  await writeIntegration();
});

afterEach(async () => {
  for (const sup of supervisors.splice(0)) await sup.stop().catch(() => {});
  resetOwnerHandleBindForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const dir of [tmpDir, spawnDir, recordDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // A just-exited child can hold its cwd briefly on Windows; the dir is unique.
    }
  }
});

describe("each spawn gets a handle and its run files (R1)", () => {
  it("a fresh spawn's argv names both files; the stub read them from its own argv", async () => {
    const sup = makeSupervisor();
    await sup.startFresh(spawnDir);
    const [spawnRec] = await waitFor(() => {
      const r = records<SpawnRecord>("spawn-");
      return r.length > 0 ? r : null;
    }, "the spawn record");
    const args = spawnRec.claudeArgs;
    expect(args.slice(0, CLAUDE_STREAM_JSON_FLAGS.length)).toEqual([...CLAUDE_STREAM_JSON_FLAGS]);
    const tail = args.slice(CLAUDE_STREAM_JSON_FLAGS.length);
    expect(tail[0]).toBe("--mcp-config");
    expect(tail[2]).toBe("--settings");
    // The session flag stays last (R1.7).
    expect(tail[4]).toBe("--session-id");
    expect(tail).toHaveLength(6);

    const run = await waitFor(() => runRecordFor(spawnRec.pid), "the run-files record");
    expect(run.mcpConfigPath).toBe(tail[1]);
    expect(run.settingsPath).toBe(tail[3]);
    expect(path.dirname(tail[1])).toBe(launcherDir());
    expect(run.sessionId).toBe(tail[5]);
    expect(run.mcp?.ok).toBe(true);
    const entry = run.mcp?.value?.mcpServers.tandem;
    expect(entry?.command).toBe(process.execPath);
    expect(entry?.args).toEqual([bridgeScript]);
    expect(entry?.env.TANDEM_OWNER_HANDLE).toMatch(HANDLE_RE);
    // A base URL, no /mcp, on the bound port and a loopback address R2.2 accepts.
    expect(entry?.env.TANDEM_OWNER_HANDLE_URL).toBe("http://127.0.0.1:45678");
    expect(entry?.env.TANDEM_URL).toBe("http://127.0.0.1:45678");
    expect(JSON.stringify(entry)).not.toMatch(/AUTH_TOKEN|Bearer/);
    expect(run.settings?.value).toEqual({ enabledPlugins: { "tandem@tandem-editor": false } });

    // buildClaudeArgs and the spawned argv agree, flag on.
    expect(
      buildClaudeArgs(
        { sessionId: tail[5], resuming: false },
        { mcpConfigPath: tail[1], settingsPath: tail[3] },
      ),
    ).toEqual(args);
    // The handle is the spawn's own: the current spawn binds it with its id.
    expect(judgeBind(entry?.env.TANDEM_OWNER_HANDLE, tail[5])).not.toBeNull();
  });

  it("a resumed spawn (relaunch) gets a new handle and new paths", async () => {
    const sup = makeSupervisor();
    await sup.startFresh(spawnDir);
    const first = await waitFor(() => records<RunFilesRecord>("runfiles-")[0], "spawn 1");
    await sup.relaunch(spawnDir);
    const second = await waitFor(
      () => records<RunFilesRecord>("runfiles-").find((r) => r.pid !== first.pid),
      "spawn 2",
    );
    const spawn2 = records<SpawnRecord>("spawn-").find((r) => r.pid === second.pid);
    expect(spawn2?.claudeArgs).toContain("--resume");
    expect(second.sessionId).toBe(first.sessionId);
    const h1 = first.mcp?.value?.mcpServers.tandem.env.TANDEM_OWNER_HANDLE;
    const h2 = second.mcp?.value?.mcpServers.tandem.env.TANDEM_OWNER_HANDLE;
    expect(h1).toMatch(HANDLE_RE);
    expect(h2).toMatch(HANDLE_RE);
    expect(h2).not.toBe(h1);
    expect(second.mcpConfigPath).not.toBe(first.mcpConfigPath);
    expect(second.settingsPath).not.toBe(first.settingsPath);
    // The first spawn's handle no longer binds; its files are gone.
    expect(judgeBind(h1, first.sessionId)).toBeNull();
    expect(judgeBind(h2, second.sessionId)).not.toBeNull();
    await waitFor(() => !fs.existsSync(first.settingsPath as string), "spawn 1's files deleted");
    expect(fs.existsSync(first.mcpConfigPath as string)).toBe(false);
  });

  it("a licence-refused start writes nothing and mints nothing", async () => {
    const sup = makeSupervisor({ aiRefusal: () => REFUSAL });
    await sup.start();
    await sleep(100);
    expect(records("spawn-")).toEqual([]);
    expect(fs.existsSync(launcherDir())).toBe(false);
    expect(ownerHandleBindSnapshotForTests().spawns).toEqual([]);
  });
});

describe("no usable bridge, no flags (R1.5)", () => {
  async function expectNoFlags(sup: Supervisor) {
    await sup.startFresh(spawnDir);
    const [rec] = await waitFor(() => {
      const r = records<SpawnRecord>("spawn-");
      return r.length > 0 ? r : null;
    }, "the spawn");
    expect(flagsIn(rec.claudeArgs)).toEqual([]);
    expect(runFilesOnDisk()).toEqual([]);
    expect(ownerHandleBindSnapshotForTests().spawns).toEqual([]);
    return rec;
  }

  it("the bridge script the entry would name does not exist", async () => {
    await expectNoFlags(makeSupervisor({ stdioBridgeScript: path.join(recordDir, "missing.js") }));
  });

  it.each([
    ["0.0.0.0", { address: "0.0.0.0", port: 3479 }],
    ["a LAN address", { address: "192.168.1.9", port: 3479 }],
    ["nothing bound", null],
  ])("the bound address is %s (Ruling D14)", async (_n, bound) => {
    await expectNoFlags(makeSupervisor({ getBoundMcpAddress: () => bound }));
  });

  it("a file is already present at the run file's name", async () => {
    fs.mkdirSync(launcherDir(), { mode: 0o700 });
    const planted = path.join(launcherDir(), `tandem-run-mcp-${"a".repeat(32)}.json`);
    fs.writeFileSync(planted, "{}");
    const sup = makeSupervisor({ runFileNameSuffix: () => "a".repeat(32) });
    await sup.startFresh(spawnDir);
    const [rec] = await waitFor(() => {
      const r = records<SpawnRecord>("spawn-");
      return r.length > 0 ? r : null;
    }, "the spawn");
    expect(flagsIn(rec.claudeArgs)).toEqual([]);
    // Only the planted file; nothing of the spawn's left behind, and the
    // planted file untouched.
    expect(runFilesOnDisk()).toEqual([path.basename(planted)]);
    expect(fs.readFileSync(planted, "utf8")).toBe("{}");
  });

  it("the settings write fails after the MCP config was written: neither is left", async () => {
    // A suffix that names a missing subdirectory makes the second create fail.
    const sup = makeSupervisor({
      runFileNameSuffix: (kind) => (kind === "mcp" ? "b".repeat(32) : `nodir/${"c".repeat(32)}`),
    });
    await expectNoFlags(sup);
  });

  it.runIf(POSIX)("a link at launcher/ (POSIX; Windows: run-files-acl-win)", async () => {
    const elsewhere = path.join(tmpDir, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, launcherDir());
    await expectNoFlags(makeSupervisor());
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it.runIf(POSIX)(
    "a link or a dangling link at the name (POSIX; Windows: run-files-acl-win)",
    async () => {
      fs.mkdirSync(launcherDir(), { mode: 0o700 });
      const target = path.join(tmpDir, "target.json");
      fs.symlinkSync(target, path.join(launcherDir(), `tandem-run-mcp-${"d".repeat(32)}.json`));
      const sup = makeSupervisor({ runFileNameSuffix: () => "d".repeat(32) });
      await sup.startFresh(spawnDir);
      const [rec] = await waitFor(() => {
        const r = records<SpawnRecord>("spawn-");
        return r.length > 0 ? r : null;
      }, "the spawn");
      expect(flagsIn(rec.claudeArgs)).toEqual([]);
      // Only the planted link remains, still dangling: nothing was created through it.
      expect(runFilesOnDisk()).toEqual([`tandem-run-mcp-${"d".repeat(32)}.json`]);
      expect(fs.existsSync(target)).toBe(false);
    },
  );
});

describe("the write's re-checks (R1.8, Ruling M)", () => {
  /** Hold the Nth run-file write (1-based); later writes pass. */
  function holdWrite(n: number) {
    const gate = deferred();
    const reached = deferred();
    let count = 0;
    return {
      gate,
      reached,
      hold: async () => {
        count++;
        if (count === n) {
          reached.resolve();
          await gate.promise;
        }
      },
    };
  }

  it("planAndSpawn: a shutdown (stop()) during a locked start(): no child, no file", async () => {
    const h = holdWrite(1);
    const sup = makeSupervisor({ runFileWriteHold: h.hold });
    const logs = captureErrors();
    const started = sup.start();
    await h.reached.promise;
    const stopped = sup.stop();
    h.gate.resolve();
    await started;
    await stopped;
    await sleep(100);
    // Not vacuous: without the re-check the stub is spawned and then killed
    // by the stop before it can record itself, so the log line is the proof.
    expect(logs().filter((l) => l.includes("Spawning Claude via reaper"))).toEqual([]);
    expect(logs().some((l) => l.includes("Not spawning: Tandem is shutting down"))).toBe(true);
    expect(records("spawn-")).toEqual([]);
    expect(runFilesOnDisk()).toEqual([]);
    expect(ownerHandleBindSnapshotForTests().spawns).toEqual([]);
  });

  it("planAndSpawn: a crash restart whose write is held while a locked start() spawns finds a child, spawns nothing, deletes its files", async () => {
    const h = holdWrite(2);
    const sup = makeSupervisor({ runFileWriteHold: h.hold });
    const logs = captureErrors();
    await sup.startFresh(spawnDir); // write 1
    const first = await waitFor(() => records<SpawnRecord>("spawn-")[0], "spawn 1");
    process.kill(first.pid, "SIGKILL");
    await h.reached.promise; // the crash restart (write 2) is held
    // The held spawn's state exists but its child is not started: not current.
    const snap = ownerHandleBindSnapshotForTests();
    expect(snap.current).toBeNull();
    expect(snap.spawns.filter((s) => !s.started)).toHaveLength(1);
    await sup.start(); // locked start: write 3, spawns
    const second = await waitFor(
      () => records<RunFilesRecord>("runfiles-").find((r) => r.pid !== first.pid),
      "spawn 2",
    );
    h.gate.resolve();
    await sleep(300);
    // The re-check, not spawnOnce's "already running" guard, refused it.
    expect(logs().some((l) => l.includes("Not spawning: a Claude started meanwhile"))).toBe(true);
    expect(logs().filter((l) => l.includes("Spawn failed"))).toEqual([]);
    expect(records("spawn-")).toHaveLength(2);
    // Only the started spawn's files remain (spawn 2 has not bound).
    expect(runFilesOnDisk().sort()).toEqual(
      [
        path.basename(second.mcpConfigPath as string),
        path.basename(second.settingsPath as string),
      ].sort(),
    );
    const after = ownerHandleBindSnapshotForTests();
    expect(after.spawns).toHaveLength(1);
    expect(after.current).toBe(after.spawns[0].serial);
    expect(
      judgeBind(second.mcp?.value?.mcpServers.tandem.env.TANDEM_OWNER_HANDLE, second.sessionId),
    ).toEqual({ serial: after.current });
  });

  it("planAndSpawn: the other order — a locked start() held while a crash restart spawns", async () => {
    const h = holdWrite(2);
    const sup = makeSupervisor({ runFileWriteHold: h.hold, restartBackoffsMs: [400] });
    const logs = captureErrors();
    await sup.startFresh(spawnDir); // write 1
    const first = await waitFor(() => records<SpawnRecord>("spawn-")[0], "spawn 1");
    process.kill(first.pid, "SIGKILL");
    await waitFor(() => sup.status().running === false, "the crash");
    const started = sup.start(); // locked start: write 2, held
    await h.reached.promise;
    // The restart fires (write 3) and spawns while the start is held.
    const second = await waitFor(
      () => records<RunFilesRecord>("runfiles-").find((r) => r.pid !== first.pid),
      "the restart's spawn",
      5_000,
    );
    h.gate.resolve();
    await started;
    await sleep(200);
    expect(logs().some((l) => l.includes("Not spawning: a Claude started meanwhile"))).toBe(true);
    expect(logs().filter((l) => l.includes("Spawn failed"))).toEqual([]);
    expect(records("spawn-")).toHaveLength(2);
    const snap = ownerHandleBindSnapshotForTests();
    expect(snap.spawns).toHaveLength(1);
    expect(
      judgeBind(second.mcp?.value?.mcpServers.tandem.env.TANDEM_OWNER_HANDLE, second.sessionId),
    ).toEqual({ serial: snap.current });
    expect(runFilesOnDisk()).toHaveLength(2);
  });

  it("planAndSpawn: the breaker tripped by an unlocked restart chain during the write: no child, no file", async () => {
    const h = holdWrite(2);
    const sup = makeSupervisor({ runFileWriteHold: h.hold, restartBackoffsMs: [400, 20] });
    await sup.startFresh(spawnDir);
    const first = await waitFor(() => records<SpawnRecord>("spawn-")[0], "spawn 1");
    process.kill(first.pid, "SIGKILL");
    await waitFor(() => sup.status().running === false, "the crash");
    const started = sup.start(); // write 2, held
    await h.reached.promise;
    // From here every integrations read fails transiently: the restart chain
    // loops on EPERM until the breaker trips, with no child alive.
    const realReadFile = fs.promises.readFile;
    const spy = vi.spyOn(fs.promises, "readFile").mockImplementation(((
      ...args: Parameters<typeof realReadFile>
    ) => {
      if (String(args[0]).endsWith("integrations.json")) {
        return Promise.reject(Object.assign(new Error("EPERM"), { code: "EPERM" }));
      }
      return realReadFile(...args);
    }) as typeof realReadFile);
    try {
      await waitFor(() => "lastError" in sup.status() && sup.status(), "the breaker", 8_000);
      h.gate.resolve();
      await started;
    } finally {
      spy.mockRestore();
    }
    await sleep(100);
    expect(records("spawn-")).toHaveLength(1);
    expect(runFilesOnDisk()).toEqual([]);
    expect(ownerHandleBindSnapshotForTests().spawns).toEqual([]);
  });

  it("planAndSpawn: the licence turning to refuse during the write: no child, no file", async () => {
    let refuse = false;
    const h = holdWrite(1);
    const sup = makeSupervisor({
      runFileWriteHold: h.hold,
      aiRefusal: () => (refuse ? REFUSAL : null),
    });
    const started = sup.start();
    await h.reached.promise;
    refuse = true;
    h.gate.resolve();
    await started;
    await sleep(100);
    expect(records("spawn-")).toEqual([]);
    expect(runFilesOnDisk()).toEqual([]);
    expect(sup.status()).toMatchObject({ running: false, lastError: "unlicensed" });
  });

  it("stopAndSpawn: a shutdown during a locked relaunch: no child, no file, why shutting-down", async () => {
    const h = holdWrite(2);
    const sup = makeSupervisor({ runFileWriteHold: h.hold });
    await sup.startFresh(spawnDir);
    await waitFor(() => records("spawn-").length === 1, "spawn 1");
    const relaunched = sup.relaunch(spawnDir);
    await h.reached.promise;
    const stopped = sup.stop();
    h.gate.resolve();
    expect(await relaunched).toEqual({ spawned: false, why: "shutting-down" });
    await stopped;
    await sleep(100);
    expect(records("spawn-")).toHaveLength(1);
    expect(runFilesOnDisk()).toEqual([]);
    expect(sup.status().running).toBe(false);
  });

  it("stopAndSpawn: the licence turning to refuse during a locked relaunch throws LicenseRefusedError, no child, no file; activation brings Claude back", async () => {
    let refuse = false;
    const h = holdWrite(2);
    const sup = makeSupervisor({
      runFileWriteHold: h.hold,
      aiRefusal: () => (refuse ? REFUSAL : null),
    });
    await sup.startFresh(spawnDir);
    await waitFor(() => records("spawn-").length === 1, "spawn 1");
    const relaunched = sup.relaunch(spawnDir);
    await h.reached.promise;
    refuse = true;
    h.gate.resolve();
    await expect(relaunched).rejects.toBeInstanceOf(LicenseRefusedError);
    await sleep(100);
    expect(records("spawn-")).toHaveLength(1);
    expect(runFilesOnDisk()).toEqual([]);
    expect(sup.status()).toMatchObject({ running: false, lastError: "unlicensed" });
    refuse = false;
    await sup.resumeAfterLicence();
    await waitFor(() => records("spawn-").length === 2, "the resumed spawn");
  });
});

describe("teardown on every exit path (R4)", () => {
  it("a spawn that never binds: both files deleted at teardown (stop)", async () => {
    const sup = makeSupervisor();
    await sup.startFresh(spawnDir);
    const run = await waitFor(() => records<RunFilesRecord>("runfiles-")[0], "spawn");
    expect(fs.existsSync(run.mcpConfigPath as string)).toBe(true);
    expect(fs.existsSync(run.settingsPath as string)).toBe(true);
    const handle = run.mcp?.value?.mcpServers.tandem.env.TANDEM_OWNER_HANDLE;
    await sup.stop();
    await waitFor(() => runFilesOnDisk().length === 0, "the files deleted");
    expect(judgeBind(handle, run.sessionId)).toBeNull();
  });

  it("an exit before binding (a crash) ends the spawn, and the crash restart's spawn is a new one", async () => {
    const sup = makeSupervisor();
    await sup.startFresh(spawnDir);
    const first = await waitFor(() => records<RunFilesRecord>("runfiles-")[0], "spawn 1");
    process.kill(first.pid, "SIGKILL");
    const second = await waitFor(
      () => records<RunFilesRecord>("runfiles-").find((r) => r.pid !== first.pid),
      "the restart",
    );
    await waitFor(() => !fs.existsSync(first.settingsPath as string), "spawn 1's files deleted");
    expect(
      judgeBind(first.mcp?.value?.mcpServers.tandem.env.TANDEM_OWNER_HANDLE, first.sessionId),
    ).toBeNull();
    expect(
      judgeBind(second.mcp?.value?.mcpServers.tandem.env.TANDEM_OWNER_HANDLE, second.sessionId),
    ).not.toBeNull();
  });

  it("stopByChoice (Off in settings) tears down", async () => {
    const sup = makeSupervisor();
    await sup.startFresh(spawnDir);
    const run = await waitFor(() => records<RunFilesRecord>("runfiles-")[0], "spawn");
    await sup.updateSettings({ startMode: "off" });
    await waitFor(() => runFilesOnDisk().length === 0, "the files deleted");
    expect(
      judgeBind(run.mcp?.value?.mcpServers.tandem.env.TANDEM_OWNER_HANDLE, run.sessionId),
    ).toBeNull();
  });

  it("the superseded spawn's late teardown leaves the newer spawn's state alone", async () => {
    process.env.TANDEM_STUB_CLAUDE_EXIT_DELAY_MS = "300";
    const sup = makeSupervisor();
    await sup.startFresh(spawnDir);
    const first = await waitFor(() => records<RunFilesRecord>("runfiles-")[0], "spawn 1");
    await sup.relaunch(spawnDir);
    const second = await waitFor(
      () => records<RunFilesRecord>("runfiles-").find((r) => r.pid !== first.pid),
      "spawn 2",
    );
    // Spawn 1's exit (and its idempotent teardown) has landed by now.
    await waitFor(() => records("exited-").length >= 1, "spawn 1's exit");
    await sleep(100);
    expect(fs.existsSync(second.mcpConfigPath as string)).toBe(true);
    expect(fs.existsSync(second.settingsPath as string)).toBe(true);
    expect(
      judgeBind(second.mcp?.value?.mcpServers.tandem.env.TANDEM_OWNER_HANDLE, second.sessionId),
    ).not.toBeNull();
  });
});

describe("the remaining R4.4 exit paths", () => {
  it("reaperPath() throwing (no reaper anywhere): no run file, no spawn state", async () => {
    process.env.TANDEM_REAPER_PATH = path.join(recordDir, "no-such-reaper");
    const sup = makeSupervisor();
    await expect(sup.startFresh(spawnDir)).rejects.toThrow();
    await sleep(100);
    expect(runFilesOnDisk()).toEqual([]);
    expect(ownerHandleBindSnapshotForTests().spawns).toEqual([]);
  });

  it.runIf(POSIX)(
    "an early 'error' before 'spawn' (an unrunnable reaper, EACCES): no run file, no spawn state (POSIX)",
    async () => {
      const unrunnable = path.join(recordDir, "reaper-not-executable");
      fs.writeFileSync(unrunnable, "", { mode: 0o644 });
      process.env.TANDEM_REAPER_PATH = unrunnable;
      const sup = makeSupervisor();
      await expect(sup.startFresh(spawnDir)).rejects.toThrow();
      await sleep(200);
      expect(runFilesOnDisk()).toEqual([]);
      expect(ownerHandleBindSnapshotForTests().spawns).toEqual([]);
    },
  );
});

describe("the boot sweep (R1.9)", () => {
  function plantOld(name: string) {
    fs.mkdirSync(launcherDir(), { recursive: true, mode: 0o700 });
    const file = path.join(launcherDir(), name);
    fs.writeFileSync(file, "{}");
    const old = (Date.now() - RUN_FILE_SWEEP_AGE_MS - 60_000) / 1000;
    fs.utimesSync(file, old, old);
    return file;
  }

  it("start() sweeps an old run file before the first spawn while holding the store lock", async () => {
    const old = plantOld(`tandem-run-mcp-${"9".repeat(32)}.json`);
    const sup = makeSupervisor({ aiRefusal: () => REFUSAL });
    await sup.start();
    expect(fs.existsSync(old)).toBe(false);
  });

  it("does nothing without the store lock", async () => {
    const old = plantOld(`tandem-run-mcp-${"8".repeat(32)}.json`);
    const sup = makeSupervisor({ aiRefusal: () => REFUSAL, storeLockHeld: () => false });
    await sup.start();
    expect(fs.existsSync(old)).toBe(true);
  });
});

describe("flag off: master's spawn exactly (Ruling I, the dark requirement)", () => {
  it("no new argument, no launcher/ directory, no handle, no sweep", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    // A matching run file two hours old: a flag-on boot would sweep it.
    fs.mkdirSync(launcherDir(), { mode: 0o700 });
    const old = path.join(launcherDir(), `tandem-run-mcp-${"7".repeat(32)}.json`);
    fs.writeFileSync(old, "{}");
    const twoHoursAgo = (Date.now() - 2 * RUN_FILE_SWEEP_AGE_MS) / 1000;
    fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
    const sup = makeSupervisor();
    await sup.start();
    const [rec] = await waitFor(() => {
      const r = records<SpawnRecord>("spawn-");
      return r.length > 0 ? r : null;
    }, "the spawn");
    expect(flagsIn(rec.claudeArgs)).toEqual([]);
    const tail = rec.claudeArgs.slice(CLAUDE_STREAM_JSON_FLAGS.length);
    expect(buildClaudeArgs({ sessionId: tail[1], resuming: tail[0] === "--resume" })).toEqual(
      rec.claudeArgs,
    );
    // Nothing swept, nothing written.
    expect(fs.readdirSync(launcherDir())).toEqual([path.basename(old)]);
    expect(records("runfiles-")).toEqual([]);
    expect(ownerHandleBindSnapshotForTests().spawns).toEqual([]);
  });

  it("the spawned environment strips the handle and its URL variable, flag on or off", () => {
    const base = {
      PATH: "/bin",
      TANDEM_OWNER_HANDLE: `th_${"x".repeat(32)}`,
      TANDEM_OWNER_HANDLE_URL: "http://127.0.0.1:1",
    };
    for (const flag of ["", "1"]) {
      vi.stubEnv("TANDEM_OWNERSHIP", flag);
      expect(childEnv(base, [])).toEqual({ PATH: "/bin" });
    }
  });
});

describe("the greeting, flag on (a regression test, not new behaviour)", () => {
  it("a spawn with run files still classifies its own child's reply by session id, as on master (Ruling A)", async () => {
    type Query = {
      sessionId: string | undefined;
      replyTo: string | undefined;
      inProgress: boolean | undefined;
    };
    let classifier: ((q: Query) => boolean) | null = null;
    const sup = makeSupervisor({
      greeting: { isOwed: () => true, markDone: async () => {} },
      subscribeTandemReply: () => () => {},
      registerGreetingReplyClassifier: (fn) => {
        classifier = fn;
        return () => {
          classifier = null;
        };
      },
      userChatSnapshot: () => ({ ids: new Set<string>(), unread: false }),
    });
    await sup.startFresh(spawnDir);
    const run = await waitFor(() => records<RunFilesRecord>("runfiles-")[0], "the spawn");
    expect(run.mcpConfigPath).toBeDefined();
    await waitFor(() => records("turn-").length > 0, "the greeting turn");
    const classify = (sessionId: string | undefined) =>
      (classifier as ((q: Query) => boolean) | null)?.({
        sessionId,
        replyTo: undefined,
        inProgress: undefined,
      }) ?? false;
    expect(classify("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(classify(run.sessionId)).toBe(true);
  });
});
