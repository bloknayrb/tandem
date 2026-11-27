/**
 * Tandem's Claude's run state in the supervisor (#2358 PR 3b-1, ships dark):
 * the spawn record, the bind window and the failed-bind judgement (R1), and
 * presence with its announcements (R2). Consumed by ownership through
 * `index.ts` since #2358 PR 3b-2b4a; the last describe wires it the same way.
 *
 * `spawn` is mocked for the whole file (a `FakeChild` whose exit the test can
 * hold), as `supervisor-turn-delivery.test.ts` does; the run files are real,
 * so each spawn has an owner handle the test reads from its run MCP config and
 * binds with `judgeBind` then `confirmBind`, the server's own order.
 *
 * Timing (the brief's harness rules): only `setTimeout`/`clearTimeout` are
 * faked; `setImmediate`, microtasks and `Date` stay real. Waits use no timer
 * (`settle`, `until`), with a failure bound on real `Date.now()`. The clock is
 * moved only by `vi.advanceTimersByTime`, and every assertion is about the
 * ORDER of events and the values announced, never about real elapsed time.
 * Injected durations (`bindWindowMs`, `presenceSettleMs`, `turnReceiptMs`)
 * are shorter than production's; the cases that exist only because of that
 * are named in their titles ("test-only staging").
 *
 * Privacy (the brief's hard requirement): `prepareRun` reads the user-level
 * Claude settings through `CLAUDE_CONFIG_DIR` before the home, and the project
 * settings in the spawn's working directory. Every supervisor here gets a
 * per-test temp home (`homeOverride` and `claudeSettingsHome`) holding its
 * working directory, and `CLAUDE_CONFIG_DIR` stubbed empty; `makeSupervisor`
 * and the `spawn` mock both refuse to run flag on without all of it.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { DELIVERY_STALL_MS } from "../../../src/shared/constants.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import type { TandemEvent } from "../../../src/server/events/types.js";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import type { RunFileAcl } from "../../../src/server/launcher/run-files.js";
import {
  readLauncherSettings,
  updateLauncherSettings,
} from "../../../src/server/launcher/settings.js";
import {
  createSupervisor,
  LicenseRefusedError,
  type Supervisor,
  type TandemPresenceSeam,
} from "../../../src/server/launcher/supervisor.js";
import type { AiRefusal } from "../../../src/server/license/ai-refusal.js";
import {
  confirmBind,
  judgeBind,
  resetOwnerHandleBindForTests,
} from "../../../src/server/sessions/owner-handle-bind.js";
import {
  checkWrite,
  getDocOwner,
  noteFailedBind,
  noteModeObserved,
  noteOwnSpawnStarted,
  noteSoloReleased,
  noteTandemPresence,
  noteTandemRunStart,
  noteTransportChanged,
  noteTransportRegistered,
  ownershipSnapshotForTests,
  resetOwnershipForTests,
  setDocOwner,
  setGraceMsForTests,
  setOpenDocumentIdsSource,
  setOwnSpawnSource,
  setRequestWakeSink,
  setStartOrWakeSink,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
  tandemWorkWaiting,
} from "../../../src/server/sessions/ownership.js";
import { SUPERVISOR_WAKE_PROMPT } from "../../../src/shared/launcher/contract.js";
import { OWNER_HANDLE_ENV } from "../../../src/shared/owner-handle.js";

// --- Fake child ---------------------------------------------------------------

class FakeStdin extends EventEmitter {
  writable = true;
  writes: string[] = [];
  write(data: string, cb?: (err?: Error | null) => void): boolean {
    this.writes.push(data);
    cb?.();
    return true;
  }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  /** While true, `kill()` marks the child killed but its exit waits for
   * `releaseExit` (a bind in the SIGTERM grace, a Start before the exit). */
  holdExit = false;
  private heldSignal: NodeJS.Signals | null = null;
  readonly stdin = new FakeStdin();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(
    readonly pid: number,
    readonly args: string[],
  ) {
    super();
  }
  kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    if (this.holdExit) {
      this.heldSignal ??= sig;
      return true;
    }
    setImmediate(() => this.exitWith(null, sig));
    return true;
  }
  /** Let a held exit through, by signal, or with `code` (a non-zero exit). */
  releaseExit(code: number | null = null): void {
    this.holdExit = false;
    this.exitWith(code, code === null ? (this.heldSignal ?? "SIGTERM") : null);
  }
  exitWith(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    // A real child's output streams end after its exit (#2358 S2).
    this.stdout.end();
    this.stderr.end();
  }
}

const EPIPE = (): NodeJS.ErrnoException =>
  Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) as NodeJS.ErrnoException;
const ENOENT = (): NodeJS.ErrnoException =>
  Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;

const NOT_SIGNED_IN = {
  type: "result",
  subtype: "success",
  is_error: true,
  result: "Not logged in · Please run /login",
};
const RESULT_OK = { type: "result", subtype: "success", is_error: false, result: "done" };

function pushJson(child: FakeChild, obj: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(obj)}\n`);
}

let eventSeq = 0;
function annotationEvent(): TandemEvent {
  eventSeq++;
  return {
    id: `evt_${eventSeq}`,
    type: "annotation:created",
    timestamp: Date.now(),
    documentId: "d1",
    payload: { annotationId: `ann_${eventSeq}`, content: "look", textSnippet: "x" },
  } as TandemEvent;
}
function chatEvent(): TandemEvent {
  eventSeq++;
  return {
    id: `evt_${eventSeq}`,
    type: "chat:message",
    timestamp: Date.now(),
    documentId: "d1",
    payload: { messageId: `msg_${eventSeq}`, text: "hi", replyTo: null, anchor: null },
  } as TandemEvent;
}

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

// --- Waits with no timer --------------------------------------------------------

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
/**
 * A few `setImmediate` turns: enough for microtasks and in-process emits (a
 * fake child's stdout line, a `kill()`'s exit, the run-start microtask). A turn
 * COUNT, so it is used only where no real I/O sits between the action and the
 * event it waits for; anything that waits on the file system (a spawn's run
 * files, a settings write) goes through `until`, which is bounded on real time.
 */
async function settle(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}
/** Poll on `setImmediate` turns, bounded on real `Date.now()` (never a count). */
async function until<T>(probe: () => T | null | undefined | false, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await tick();
  }
}
const advance = (ms: number) => vi.advanceTimersByTime(ms);

// --- Environment ----------------------------------------------------------------

const WINDOW = 1_000;
const SETTLE = 500;

let tmpRoot: string;
let home: string;
let baseDir: string;
let cwdDir: string;
let bridgeScript: string;
let children: FakeChild[];
let onSpawn: ((child: FakeChild) => void) | null;
let sups: Supervisor[];
let errSpy: MockInstance<typeof console.error>;
/** Called synchronously when `setStandby` arms the standby watch (R2.7's
 * live-read case reads the seam from inside it). */
let standbySubscribeProbe: (() => void) | null;

async function writeIntegration(present = true): Promise<void> {
  const file: IntegrationsFile = {
    schemaVersion: 3,
    integrations: present
      ? [
          {
            kind: "claude-code",
            id: "active",
            label: "Active Claude",
            configPath:
              process.platform === "win32"
                ? "C:\\Users\\test\\.claude.json"
                : "/home/test/.claude.json",
            transport: "http",
            url: "http://127.0.0.1:3479/mcp",
            apply: "create",
            workingDirectory: cwdDir,
          },
        ]
      : [],
  };
  await createIntegrationsStore(baseDir).write(file);
}

beforeEach(async () => {
  vi.stubEnv("TANDEM_OWNERSHIP", "1");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("TANDEM_TAURI_SIDECAR", "");
  standbySubscribeProbe = null;
  vi.stubEnv("TANDEM_REAPER_PATH", process.execPath);
  resetOwnerHandleBindForTests();
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "presence-")));
  home = path.join(tmpRoot, "home");
  baseDir = path.join(tmpRoot, "appdata");
  cwdDir = path.join(home, "project");
  fs.mkdirSync(cwdDir, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });
  bridgeScript = path.join(tmpRoot, "bridge.js");
  fs.writeFileSync(bridgeScript, "// stands in for the bridge dist; never run here\n");
  children = [];
  onSpawn = null;
  sups = [];
  let pid = 50_000;
  vi.mocked(spawn).mockClear();
  vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
    // The privacy guard, at the point the run files have been read (L2 of the
    // plan's security review): a flag-on spawn here must run with the
    // user-level settings variable stubbed empty.
    if (process.env.TANDEM_OWNERSHIP === "1" && process.env.CLAUDE_CONFIG_DIR !== "") {
      throw new Error("flag-on spawn without CLAUDE_CONFIG_DIR stubbed empty");
    }
    const child = new FakeChild(pid++, args);
    children.push(child);
    onSpawn?.(child);
    setImmediate(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  await writeIntegration();
  await updateLauncherSettings(baseDir, { startMode: "auto", lifetime: "always" }, null);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  for (const c of children) if (c.holdExit) c.releaseExit();
  vi.useRealTimers();
  for (const sup of sups) await sup.stop().catch(() => {});
  errSpy.mockRestore();
  vi.unstubAllEnvs();
  resetOwnerHandleBindForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

type ExtraOpts = Omit<
  Parameters<typeof createSupervisor>[0],
  "integrationsBase" | "subscribeToEvents" | "subscribeDuringGap" | "subscribeDuringStandby"
>;

/** The one builder for this file. Flag on, it refuses to build a supervisor
 * that could read the developer's real Claude settings (the brief's guard). */
function makeSupervisor(extra: ExtraOpts = {}): {
  sup: Supervisor;
  seam: TandemPresenceSeam;
  emit: (e: TandemEvent) => void;
  log: string[];
} {
  const opts = {
    probeCliUsable: () => true,
    resolveClaudeCommand: () => process.execPath,
    restartBackoffsMs: [0],
    homeOverride: home,
    claudeSettingsHome: home,
    getBoundMcpAddress: () => ({ address: "127.0.0.1", port: 45678 }),
    stdioBridgeScript: bridgeScript,
    runFileAcl: NO_ACL,
    storeLockHeld: () => true,
    bindWindowMs: WINDOW,
    presenceSettleMs: SETTLE,
    turnReceiptMs: 1e9,
    wakeLatchMs: 1e9,
    resumeConfirmMs: 1e9,
    backoffResetMs: 1e9,
    ...extra,
  };
  if (process.env.TANDEM_OWNERSHIP === "1") {
    const inside = (p: string | undefined) => p !== undefined && p.startsWith(tmpRoot);
    if (
      process.env.CLAUDE_CONFIG_DIR !== "" ||
      !inside(opts.claudeSettingsHome) ||
      !inside(opts.homeOverride)
    ) {
      throw new Error("flag-on supervisor built without the temp home and CLAUDE_CONFIG_DIR stub");
    }
  }
  const callbacks = new Set<(event: TandemEvent) => void>();
  const sub = (cb: (event: TandemEvent) => void) => {
    callbacks.add(cb);
    return () => callbacks.delete(cb);
  };
  const sup = createSupervisor({
    ...opts,
    integrationsBase: baseDir,
    subscribeToEvents: sub,
    subscribeDuringGap: sub,
    subscribeDuringStandby: (cb) => {
      standbySubscribeProbe?.();
      return sub(cb);
    },
  });
  sups.push(sup);
  const seam = sup.tandemPresence?.() as TandemPresenceSeam;
  const log: string[] = [];
  seam.subscribe((p) => log.push(p ? "present" : "not-present"));
  seam.onRunStart(() => log.push("run-start"));
  seam.onFailedBind((r) => log.push(`failed:${r}`));
  return {
    sup,
    seam,
    log,
    emit: (event) => {
      for (const cb of [...callbacks]) cb(event);
    },
  };
}

function argAfter(child: FakeChild, flag: string): string | undefined {
  const i = child.args.indexOf(flag);
  return i === -1 ? undefined : child.args[i + 1];
}

/** Read the spawn's handle from its run MCP config (before it is bound). */
function credentialsOf(child: FakeChild): { handle: string; sessionId: string } {
  const file = argAfter(child, "--mcp-config");
  if (file === undefined) throw new Error("spawn has no run MCP config");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as {
    mcpServers: { tandem: { env: Record<string, string> } };
  };
  const sessionId = argAfter(child, "--session-id") ?? argAfter(child, "--resume");
  return { handle: cfg.mcpServers.tandem.env[OWNER_HANDLE_ENV] as string, sessionId: sessionId! };
}

let mcpSeq = 0;
/** Bind as the server does: judge, then confirm; then let microtasks run. */
async function bind(child: FakeChild, creds = credentialsOf(child)): Promise<boolean> {
  const candidate = judgeBind(creds.handle, creds.sessionId);
  const ok = candidate !== null && confirmBind(candidate, `mcp-${++mcpSeq}`);
  await settle();
  return ok;
}

async function childN(n: number): Promise<FakeChild> {
  return until(() => children.length >= n && children[n - 1], `child ${n}`);
}

function logText(): string {
  return errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
}
const failedLines = () => (logText().match(/spawn did not bind/g) ?? []).length;

/** A fresh spawn that bound: present, one run start. */
async function boundFreshRun(h: ReturnType<typeof makeSupervisor>): Promise<FakeChild> {
  await h.sup.startFresh(cwdDir);
  const c1 = await childN(1);
  expect(await bind(c1)).toBe(true);
  expect(h.log).toEqual(["present", "run-start"]);
  return c1;
}

/** A resumed spawn's Claude says the conversation is not there (#2358 S2): what
 * makes its exit 1 the #1169 shape rather than a crash. */
async function sayNoConversation(child: FakeChild): Promise<void> {
  child.stderr.write(`No conversation found with session ID: ${argAfter(child, "--resume")}\n`);
  await settle();
}

/** After a bound run, crash it; the restart resumes (child 2), writing no turn. */
async function crashToResumed(c1: FakeChild): Promise<FakeChild> {
  c1.exitWith(1, null);
  await settle();
  advance(1); // the [0] backoff is a (faked) timer
  const c2 = await childN(2);
  await settle();
  expect(argAfter(c2, "--resume")).toBeDefined();
  return c2;
}

// --- R1 -------------------------------------------------------------------------

describe("R1: a run start needs the latest spawn, with no teardown cause", () => {
  it("a stub child that binds: one run start, with no turn result needed", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    expect(h.seam.isPresent()).toBe(true);
    expect(logText()).toMatch(/run started/);
  });

  it("a relaunch where the old spawn's bridge binds during the SIGTERM grace: no run start", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    const creds = credentialsOf(c1);
    // Its bootstrap turn answered, so the relaunch owes the next spawn no turn
    // and starts no window there (a plain relaunch resumes and writes none).
    pushJson(c1, RESULT_OK);
    await settle();
    c1.holdExit = true;
    const relaunching = h.sup.relaunch();
    await until(() => c1.killed, "the relaunch's SIGTERM");
    expect(await bind(c1, creds)).toBe(true); // latched "ever bound" only
    c1.releaseExit();
    await relaunching;
    await settle();
    advance(WINDOW * 2);
    await settle();
    expect(h.log).toEqual([]);
  });
});

describe("R1.2: the window", () => {
  it("a stub that never presents its handle: failed when the clock reaches the window from its bootstrap turn, not one tick before", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    await childN(1);
    advance(WINDOW - 1);
    await settle();
    expect(h.log).toEqual([]);
    advance(1);
    await settle();
    expect(h.log).toEqual(["failed:window-expired"]);
    expect(failedLines()).toBe(1);
  });

  it("a resumed spawn whose first turn (a wake) is written at T: failed at T plus the window, not at spawn plus the window", async () => {
    const h = makeSupervisor();
    const c2 = await crashToResumed(await boundFreshRun(h));
    advance(WINDOW / 2); // T
    h.emit(annotationEvent());
    expect(c2.stdin.writes).toHaveLength(1);
    advance(WINDOW / 2);
    await settle();
    expect(h.log).toEqual(["present", "run-start"]); // spawn + window passed: nothing
    advance(WINDOW / 2 - 1);
    await settle();
    expect(h.log).toEqual(["present", "run-start"]);
    advance(1);
    await settle();
    expect(h.log).toEqual(["present", "run-start", "failed:window-expired", "not-present"]);
  });

  it("a resumed spawn with nothing owed that binds with no turn written: one run start", async () => {
    const h = makeSupervisor();
    const c2 = await crashToResumed(await boundFreshRun(h));
    expect(c2.stdin.writes).toHaveLength(0);
    expect(await bind(c2)).toBe(true);
    expect(h.log).toEqual(["present", "run-start", "run-start"]);
  });

  it("a resumed spawn that is confirmed, then written to, never binds, and crashes after its window started: failed (site a)", async () => {
    const h = makeSupervisor({ resumeConfirmMs: WINDOW / 10 });
    const c2 = await crashToResumed(await boundFreshRun(h));
    advance(WINDOW / 10); // its resume is confirmed
    h.emit(annotationEvent()); // the window starts
    advance(WINDOW / 10);
    c2.exitWith(1, null); // a crash, not the #1169 shape (confirmed)
    await settle();
    expect(h.log).toEqual(["present", "run-start", "failed:torn-down-unbound", "not-present"]);
  });

  it("a spawn with no run files: failed at its window's expiry, not before (site c)", async () => {
    const h = makeSupervisor({ getBoundMcpAddress: () => null });
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    expect(argAfter(c1, "--mcp-config")).toBeUndefined();
    advance(WINDOW - 1);
    await settle();
    expect(h.log).toEqual([]);
    advance(1);
    await settle();
    expect(h.log).toEqual(["failed:no-run-files"]);
  });
});

describe("R1.3/R1.4: teardown unbound after the window started, one test per cause", () => {
  async function unboundFresh(extra: ExtraOpts = {}) {
    const h = makeSupervisor(extra);
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    expect(c1.stdin.writes).toHaveLength(1); // the bootstrap turn: the window runs
    return { h, c1 };
  }
  async function noJudgementAfterWindow(h: ReturnType<typeof makeSupervisor>) {
    advance(WINDOW * 2);
    await settle();
    expect(h.log.filter((e) => e.startsWith("failed:"))).toEqual([]);
    expect(failedLines()).toBe(0);
  }

  it("a crash: failed (site a)", async () => {
    const { h, c1 } = await unboundFresh();
    c1.exitWith(1, null);
    await settle();
    expect(h.log).toEqual(["failed:torn-down-unbound"]);
  });

  it("the stdin-gone kill: failed", async () => {
    const { h, c1 } = await unboundFresh();
    c1.stdin.emit("error", EPIPE());
    await until(() => c1.signalCode !== null, "the stdin-gone kill's exit");
    await settle();
    expect(h.log).toEqual(["failed:torn-down-unbound"]);
  });

  it("the receipt-timeout kill: failed (test-only staging: turnReceiptMs below the window)", async () => {
    const { h, c1 } = await unboundFresh({ turnReceiptMs: WINDOW / 4 });
    advance(WINDOW / 4);
    await until(() => c1.signalCode !== null, "the receipt kill's exit");
    await settle();
    expect(h.log).toEqual(["failed:torn-down-unbound"]);
  });

  it("Off: not judged", async () => {
    const { h } = await unboundFresh();
    await h.sup.updateSettings({ startMode: "off" });
    await noJudgementAfterWindow(h);
  });

  it("idle-stop: not judged (test-only staging: the idle limit below the window; a real idle stop comes after it)", async () => {
    await updateLauncherSettings(baseDir, { lifetime: "idle", idleMinutes: 1 }, null);
    const { h, c1 } = await unboundFresh({ idleMinuteMs: WINDOW / 4 });
    pushJson(c1, RESULT_OK);
    await settle();
    advance(WINDOW / 4);
    await until(() => c1.signalCode !== null, "the idle stop");
    await settle();
    await noJudgementAfterWindow(h);
  });

  it("a relaunch: not judged", async () => {
    const { h, c1 } = await unboundFresh();
    pushJson(c1, RESULT_OK); // nothing owed to the resumed successor
    await settle();
    await h.sup.relaunch();
    await settle();
    await noJudgementAfterWindow(h);
  });

  it("stop(): not judged", async () => {
    const { h } = await unboundFresh();
    await h.sup.stop();
    await noJudgementAfterWindow(h);
  });

  it("the needs-login trip: not judged (cause sign-in)", async () => {
    const { h, c1 } = await unboundFresh();
    pushJson(c1, NOT_SIGNED_IN);
    await until(() => c1.signalCode !== null, "the sign-in trip's kill");
    await settle();
    await noJudgementAfterWindow(h);
  });

  it("a child that emits `error` and then exits non-zero, with a turn written: not judged (cause child-error)", async () => {
    const { h, c1 } = await unboundFresh();
    c1.emit("error", EPIPE()); // not ENOENT: spawn-failed, a restart scheduled
    c1.exitWith(1, null); // its exit follows: site (a) runs, and must decline
    await settle();
    expect(h.log).toEqual([]);
    expect(failedLines()).toBe(0);
  });

  it("a child that emits `error` (ENOENT): not a failed bind", async () => {
    const { h, c1 } = await unboundFresh();
    c1.emit("error", ENOENT());
    await settle();
    await noJudgementAfterWindow(h);
  });
});

describe("R1.4 site (b): fault kills torn down by a Start or an Off before their exit", () => {
  it("a receipt-timeout kill, then the user's Start before the child's exit: judged failed at the Start's release, once (test-only staging)", async () => {
    const h = makeSupervisor({ turnReceiptMs: WINDOW / 4 });
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    c1.holdExit = true;
    advance(WINDOW / 4);
    await until(() => c1.killed, "the receipt kill");
    expect(h.log).toEqual([]);
    await h.sup.startByUser();
    expect(h.log).toEqual(["failed:torn-down-unbound"]);
    // The successor's owed wake was read (any envelope clears its receipt).
    pushJson(await childN(2), { type: "system", subtype: "init" });
    await settle();
    c1.releaseExit(1);
    await settle();
    advance(WINDOW / 2);
    await settle();
    expect(h.log).toEqual(["failed:torn-down-unbound"]);
    expect(failedLines()).toBe(1);
  });

  it("a fault kill of an unbound spawn after its window started, then Off before the exit: judged once, failed-bind before the Off's not-present; then On does not read present", async () => {
    const h = makeSupervisor();
    const c2 = await crashToResumed(await boundFreshRun(h));
    h.emit(annotationEvent()); // the window starts
    c2.holdExit = true;
    c2.stdin.emit("error", EPIPE()); // the stdin-gone kill: cause fault
    await until(() => c2.killed, "the fault kill");
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    expect(h.log).toEqual(["present", "run-start", "failed:torn-down-unbound", "not-present"]);
    await h.sup.updateSettings({ startMode: "on-click" });
    await settle();
    expect(h.log).toEqual(["present", "run-start", "failed:torn-down-unbound", "not-present"]);
    expect(h.seam.isPresent()).toBe(false);
    c2.releaseExit();
    await settle();
    expect(failedLines()).toBe(1);
  });

  it("a fault-killed, resumed, unconfirmed spawn whose non-zero exit comes first: declined at site (a), and a later Off does not judge it", async () => {
    const h = makeSupervisor();
    const c2 = await crashToResumed(await boundFreshRun(h));
    h.emit(annotationEvent());
    c2.holdExit = true;
    c2.stdin.emit("error", EPIPE());
    await until(() => c2.killed, "the fault kill");
    await sayNoConversation(c2);
    c2.releaseExit(1); // the #1169 shape: resuming, the message, code 1, unconfirmed
    await settle();
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    expect(h.log.filter((e) => e.startsWith("failed:"))).toEqual([]);
  });

  it("the #1169 shape whose message is read only after the exit: still never judged", async () => {
    // #2358 S2: Node may emit `exit` before the last stream data is read. The
    // verdict, and with it site (a), waits for both streams to end.
    const h = makeSupervisor();
    const c2 = await crashToResumed(await boundFreshRun(h));
    h.emit(annotationEvent()); // its wake: the window runs
    await settle();
    c2.exitCode = 1;
    c2.emit("exit", 1, null); // the exit first, its streams still open
    await settle();
    c2.stderr.write(`No conversation found with session ID: ${argAfter(c2, "--resume")}\n`);
    c2.stdout.end();
    c2.stderr.end();
    await settle();
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    expect(h.log.filter((e) => e.startsWith("failed:"))).toEqual([]);
  });

  it("the same fault kill ending in exit 1 without Claude's message (a Windows kill) is a crash, not the #1169 shape: judged at site (a), once", async () => {
    // #2358 S2: on Windows a killed Claude exits 1. Without the no-conversation
    // message the session is kept once (`shouldClearSession`), and site (a)
    // shares that verdict.
    const h = makeSupervisor();
    const c2 = await crashToResumed(await boundFreshRun(h));
    h.emit(annotationEvent());
    c2.holdExit = true;
    c2.stdin.emit("error", EPIPE());
    await until(() => c2.killed, "the fault kill");
    c2.releaseExit(1);
    await settle();
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    expect(h.log.filter((e) => e.startsWith("failed:"))).toEqual(["failed:torn-down-unbound"]);
    expect(failedLines()).toBe(1);
  });

  it("the same fault kill relayed by the Linux reaper as code 143 is a signal death, not the #1169 shape: judged at site (a), once", async () => {
    // The reaper forwards the kill's SIGTERM and exits 128 + 15, so the code is
    // not null. `shouldClearSession` keeps it once as an unexplained exit
    // (#2358), and site (a) judges it as a null code (macOS, Windows) was
    // already judged.
    const h = makeSupervisor();
    const c2 = await crashToResumed(await boundFreshRun(h));
    h.emit(annotationEvent());
    c2.holdExit = true;
    c2.stdin.emit("error", EPIPE());
    await until(() => c2.killed, "the fault kill");
    c2.releaseExit(143);
    await settle();
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    expect(h.log.filter((e) => e.startsWith("failed:"))).toEqual(["failed:torn-down-unbound"]);
    expect(failedLines()).toBe(1);
  });

  it("a fault-killed spawn whose bridge binds during the kill's grace: ever bound, no run start, not judged", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    const creds = credentialsOf(c1);
    c1.holdExit = true;
    c1.stdin.emit("error", EPIPE());
    await until(() => c1.killed, "the fault kill");
    expect(await bind(c1, creds)).toBe(true);
    c1.releaseExit();
    await settle();
    advance(WINDOW * 2);
    await settle();
    expect(h.log).toEqual([]);
  });
});

describe("R1: judged at most once, and only the latest spawn", () => {
  it("a second confirmBind on the same spawn (a second transport): no second run start", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    const creds = credentialsOf(c1);
    expect(await bind(c1, creds)).toBe(true);
    expect(await bind(c1, creds)).toBe(true);
    expect(h.log).toEqual(["present", "run-start"]);
  });

  for (const how of ["relaunch", "stop"] as const) {
    it(`a ${how} whose SIGTERM wait outlasts the spawn's window: not judged`, async () => {
      const h = makeSupervisor();
      await h.sup.startFresh(cwdDir);
      const c1 = await childN(1);
      c1.holdExit = true;
      const stopping = how === "relaunch" ? h.sup.relaunch() : h.sup.stop();
      await until(() => c1.killed, "the SIGTERM");
      advance(WINDOW + 1); // below stopInternal's 6 s grace
      await settle();
      c1.releaseExit();
      await stopping;
      await settle();
      expect(h.log.filter((e) => e.startsWith("failed:"))).toEqual([]);
      expect(failedLines()).toBe(0);
    });
  }

  it("a spawn judged at its window and then torn down: one failed-bind event and one log line", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    advance(WINDOW);
    await settle();
    c1.exitWith(1, null);
    await settle();
    expect(h.log).toEqual(["failed:window-expired"]);
    expect(failedLines()).toBe(1);
  });

  it("a respawn refused by the licence, or answering cli-unusable: the running spawn's record is unchanged", async () => {
    let refuse: AiRefusal | null = null;
    let bin: string | null = process.execPath;
    const h = makeSupervisor({ aiRefusal: () => refuse, resolveClaudeCommand: () => bin });
    await h.sup.startFresh(cwdDir);
    await childN(1);
    refuse = REFUSAL;
    await expect(h.sup.relaunch()).rejects.toBeInstanceOf(LicenseRefusedError);
    refuse = null;
    bin = null;
    expect(await h.sup.relaunch()).toEqual({ spawned: false, why: "cli-unusable" });
    // No cause was set and nothing was judged: the window still fails it.
    advance(WINDOW);
    await settle();
    expect(h.log).toEqual(["failed:window-expired"]);
    expect(children).toHaveLength(1);
  });

  it("the #1169 case: a bound run ended by an idle stop, a resumed spawn started by a message exits 1, a fresh spawn binds: never not-present", async () => {
    await updateLauncherSettings(baseDir, { lifetime: "idle", idleMinutes: 1 }, null);
    const h = makeSupervisor({ idleMinuteMs: WINDOW * 10 });
    const c1 = await boundFreshRun(h);
    pushJson(c1, RESULT_OK);
    await settle();
    advance(WINDOW * 10);
    await until(() => c1.signalCode !== null, "the idle stop");
    await settle();
    h.emit(chatEvent()); // the standby watch starts Claude for it
    const c2 = await childN(2);
    await settle();
    expect(argAfter(c2, "--resume")).toBeDefined();
    expect(c2.stdin.writes.length).toBeGreaterThan(0); // its wake: the window runs
    await sayNoConversation(c2);
    c2.exitWith(1, null);
    await settle();
    advance(1);
    const c3 = await childN(3);
    await settle();
    expect(argAfter(c3, "--session-id")).toBeDefined();
    expect(await bind(c3)).toBe(true);
    expect(h.log).toEqual(["present", "run-start", "run-start"]);
  });

  it("after a bound run, a start-fresh whose spawn binds only after its window expired: one not-present at expiry, then one present at the late bind", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await h.sup.startFresh(cwdDir);
    const c2 = await childN(2);
    const creds = credentialsOf(c2);
    advance(WINDOW);
    await settle();
    expect(h.log).toEqual(["present", "run-start", "failed:window-expired", "not-present"]);
    expect(await bind(c2, creds)).toBe(true);
    expect(h.log).toEqual([
      "present",
      "run-start",
      "failed:window-expired",
      "not-present",
      "present",
      "run-start",
    ]);
  });

  it("a superseded spawn's late teardown: the latest spawn's record is unchanged", async () => {
    const h = makeSupervisor({ turnReceiptMs: WINDOW / 4 });
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    c1.holdExit = true;
    advance(WINDOW / 4); // receipt kill of c1, exit held
    await until(() => c1.killed, "the receipt kill");
    await h.sup.startByUser(); // judges c1 at its release, spawns c2 (resumed)
    const c2 = await childN(2);
    h.emit(annotationEvent()); // c2's window starts
    pushJson(c2, { type: "system", subtype: "init" }); // read: no receipt kill
    await settle();
    c1.releaseExit(1); // the superseded spawn's late exit
    await settle();
    expect(h.log).toEqual(["failed:torn-down-unbound"]);
    // c2's record is untouched: it still fails at its own window, not earlier.
    advance(WINDOW - 1);
    await settle();
    expect(h.log).toEqual(["failed:torn-down-unbound"]);
    advance(1);
    await settle();
    expect(h.log).toEqual(["failed:torn-down-unbound", "failed:window-expired"]);
  });
});

// --- R2 -------------------------------------------------------------------------

describe("R2: presence is computed and announced (a build that never announces fails this pair)", () => {
  it("a crash-resume (bound run, crash, restart, re-bind): present throughout, nothing announced", async () => {
    const h = makeSupervisor();
    const c2 = await crashToResumed(await boundFreshRun(h));
    expect(await bind(c2)).toBe(true);
    advance(SETTLE * 4);
    await settle();
    expect(h.log).toEqual(["present", "run-start", "run-start"]);
  });

  it("Off then On after a bound run: exactly one not-present and one present", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    await h.sup.updateSettings({ startMode: "auto" });
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present", "present"]);
  });
});

describe("R2.3: when each change is announced", () => {
  it("Off is not present at once and cancels a pending settle; a Start from Off is present at once", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await writeIntegration(false);
    await h.sup.refreshConfigured(); // (ii) false: the settle
    await settle();
    expect(h.seam.diagnosticsForTests().settlePending).toBe(true);
    await writeIntegration(true);
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present"]);
    expect(h.seam.diagnosticsForTests().settlePending).toBe(false);
    // A Start from Off moves standby to awaiting-start before its spawn, and
    // the spawn's configured read is true again: present at once.
    await h.sup.startByUser();
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present", "present"]);
  });

  it("the spawn's setStandby(undefined) from Off (staged: in-memory Off, saved mode not Off): present at once", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    // The saved mode changes behind the supervisor's back; its standby stays Off.
    await updateLauncherSettings(baseDir, { startMode: "auto" }, null);
    const relaunching = h.sup.relaunch();
    await childN(2);
    await relaunching;
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present", "present"]);
  });

  it("configured false then true: not present when the settle elapses, then present at once", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await writeIntegration(false);
    await h.sup.refreshConfigured();
    await settle();
    advance(SETTLE - 1);
    await settle();
    expect(h.log).toEqual(["present", "run-start"]);
    advance(1);
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present"]);
    await writeIntegration(true);
    await h.sup.refreshConfigured();
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present", "present"]);
  });

  it("the needs-login trip on a present Tandem's Claude: not present at once", async () => {
    const h = makeSupervisor();
    const c1 = await boundFreshRun(h);
    pushJson(c1, NOT_SIGNED_IN);
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present"]);
  });

  describe("Check again while still signed out (both orders; which a real child takes is not measured)", () => {
    async function tripped() {
      const h = makeSupervisor();
      const c1 = await boundFreshRun(h);
      pushJson(c1, NOT_SIGNED_IN);
      await until(() => c1.signalCode !== null, "the trip's kill");
      await settle();
      await h.sup.relaunch(); // Check again
      const c2 = await childN(2);
      await settle();
      expect(c2.stdin.writes).toHaveLength(1); // its sign-in re-check turn
      return { h, c2 };
    }

    it("its refusal before its bind: nothing announced", async () => {
      const { h, c2 } = await tripped();
      const creds = credentialsOf(c2);
      pushJson(c2, NOT_SIGNED_IN);
      await settle();
      expect(await bind(c2, creds)).toBe(false); // the trip discarded the spawn
      expect(h.log).toEqual(["present", "run-start", "not-present"]);
    });

    it("its bind before its refusal: present at the bind, not present at once at the refusal", async () => {
      const { h, c2 } = await tripped();
      expect(await bind(c2)).toBe(true);
      pushJson(c2, NOT_SIGNED_IN);
      await settle();
      expect(h.log).toEqual([
        "present",
        "run-start",
        "not-present",
        "present",
        "run-start",
        "not-present",
      ]);
    });
  });

  describe("the error latch (amendment 3)", () => {
    async function breakerTrippedAt() {
      const h = makeSupervisor();
      const c1 = await boundFreshRun(h);
      c1.emit("error", ENOENT()); // breaker tripped, binary-not-found: a settle cause
      await settle();
      expect(h.log).toEqual(["present", "run-start"]);
      await h.sup.relaunch(); // Restart before the settle; clears the breaker
      const c2 = await childN(2);
      await settle();
      return { h, c2 };
    }

    it("a Restart whose child has not bound by the settle: not present when it fires, and present only at its later bind", async () => {
      const { h, c2 } = await breakerTrippedAt();
      advance(SETTLE);
      await settle();
      expect(h.log).toEqual(["present", "run-start", "not-present"]);
      expect(await bind(c2)).toBe(true);
      expect(h.log).toEqual(["present", "run-start", "not-present", "present", "run-start"]);
    });

    it("the mirror, where the Restart's child binds before the settle fires: nothing announced", async () => {
      const { h, c2 } = await breakerTrippedAt();
      expect(await bind(c2)).toBe(true);
      advance(SETTLE * 2);
      await settle();
      expect(h.log).toEqual(["present", "run-start", "run-start"]);
    });
  });

  it("by predicate: a crash restart whose planAndSpawn returns early with spawn-failed recorded is not present only when the settle fires after launching--", async () => {
    // Only `launching--` turns the value: the restart's plan still finds the
    // integration (`configured` stays true) and is refused by the licence,
    // which records nothing over `spawn-failed` (`recordLicenceRefusal`).
    let refuse: AiRefusal | null = null;
    const h = makeSupervisor({ aiRefusal: () => refuse });
    const c1 = await boundFreshRun(h);
    c1.emit("error", EPIPE()); // not ENOENT: spawn-failed, a restart scheduled
    await settle();
    refuse = REFUSAL;
    advance(1); // the restart timer fires; planAndSpawn returns early
    await until(() => logText().includes("AI features are unlicensed"), "the early return");
    expect(h.sup.status().lastError).toBe("spawn-failed");
    await settle();
    expect(h.log).toEqual(["present", "run-start"]);
    advance(SETTLE);
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present"]);
  });

  it("a restart underway keeps (v): an error with a crash restart pending past the settle is never announced, and the rebind keeps presence", async () => {
    const h = makeSupervisor({ restartBackoffsMs: [SETTLE * 3] });
    const c1 = await boundFreshRun(h);
    c1.emit("error", EPIPE()); // spawn-failed recorded, a restart scheduled (restartTimer)
    await settle();
    advance(SETTLE * 2); // well past the settle, the restart still pending
    await settle();
    expect(h.log).toEqual(["present", "run-start"]);
    advance(SETTLE);
    const c2 = await childN(2);
    await settle();
    expect(await bind(c2)).toBe(true);
    expect(h.log).toEqual(["present", "run-start", "run-start"]);
  });

  it("several writes in one synchronous run (the sign-in trip's): one recompute", async () => {
    const h = makeSupervisor();
    const c1 = await boundFreshRun(h);
    const before = h.seam.diagnosticsForTests().recomputes;
    pushJson(c1, NOT_SIGNED_IN); // lastError and breakerTripped, one handler
    await until(() => h.log.includes("not-present"), "the trip");
    // The trip's own writes are one recompute; the kill's exit later adds its own.
    expect(h.seam.diagnosticsForTests().recomputes - before).toBe(1);
  });
});

describe("R2.5: total", () => {
  it("a throwing subscriber: the next subscriber still runs, and nothing escapes", async () => {
    const h = makeSupervisor();
    const seen: string[] = [];
    h.seam.subscribe(() => {
      throw new Error("boom");
    });
    h.seam.subscribe((p) => seen.push(String(p)));
    h.seam.onRunStart(() => {
      throw new Error("boom");
    });
    h.seam.onRunStart(() => seen.push("run-start"));
    await boundFreshRun(h);
    expect(seen).toEqual(["true", "run-start"]);
    expect(logText()).toMatch(/subscriber threw/);
  });
});

describe("R2.6: a throwing stopAndSpawn records spawn-failed when nothing else did", () => {
  for (const via of ["relaunch", "startFresh"] as const) {
    it(`buildPlan throwing with no restart pending, through ${via}: spawn-failed, and not present when the settle elapses`, async () => {
      const h = makeSupervisor();
      await boundFreshRun(h);
      // A read that throws (EISDIR), not one that finds no entry.
      fs.rmSync(path.join(baseDir, "integrations.json"));
      fs.mkdirSync(path.join(baseDir, "integrations.json"));
      await expect(via === "relaunch" ? h.sup.relaunch() : h.sup.startFresh()).rejects.toThrow();
      await settle();
      expect(h.sup.status().lastError).toBe("spawn-failed");
      expect(h.log).toEqual(["present", "run-start"]);
      advance(SETTLE);
      await settle();
      expect(h.log).toEqual(["present", "run-start", "not-present"]);
    });
  }

  it("with a restart pending (an exit before 'spawn'): not recorded", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    onSpawn = (child) => {
      child.emit = ((orig) =>
        function (this: FakeChild, name: string | symbol, ...args: unknown[]) {
          if (name === "spawn") return orig.call(this, "exit", 1, null);
          return orig.call(this, name, ...args);
        })(child.emit) as typeof child.emit;
    };
    await expect(h.sup.relaunch()).rejects.toThrow(/before spawn/);
    expect(h.sup.status().lastError).toBeUndefined();
  });

  it("with spawnOnce throwing on a missing reaper: binary-not-found kept", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    vi.stubEnv("TANDEM_REAPER_PATH", path.join(tmpRoot, "no-such-reaper"));
    await expect(h.sup.relaunch()).rejects.toThrow();
    expect(h.sup.status().lastError).toBe("binary-not-found");
  });

  it("with the late licence refusal: unlicensed kept", async () => {
    let calls = 0;
    const h = makeSupervisor({
      // respawn's check admits; the one after the run files refuses.
      aiRefusal: () => (++calls >= 3 ? REFUSAL : null),
    });
    await boundFreshRun(h);
    calls = 1;
    await expect(h.sup.relaunch()).rejects.toBeInstanceOf(LicenseRefusedError);
    expect(h.sup.status().lastError).toBe("unlicensed");
  });
});

describe("R2.3: shutdown", () => {
  it("stop() from present: nothing announced, and a pending settle is cancelled", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await writeIntegration(false);
    await h.sup.refreshConfigured(); // (ii) false: a settle pending
    await settle();
    expect(h.seam.diagnosticsForTests().settlePending).toBe(true);
    await h.sup.stop();
    await settle();
    expect(h.log).toEqual(["present", "run-start"]);
    expect(h.seam.diagnosticsForTests().settlePending).toBe(false);
  });

  it("stop() from Off: nothing announced", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    await h.sup.stop();
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present"]);
  });

  it("Off, stop(), then start() with the mode still off: zero announcements after the Off", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    await h.sup.stop();
    await h.sup.start();
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present"]);
  });

  it("stop() from present, then start() with the mode off: not-present announced exactly once, after start() ends", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await h.sup.stop();
    await updateLauncherSettings(baseDir, { startMode: "off" }, null);
    await h.sup.start();
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present"]);
  });

  it("stop() from present, then start() that binds again: no announcement", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await h.sup.stop();
    await h.sup.start();
    const c2 = await childN(2);
    expect(await bind(c2)).toBe(true);
    expect(h.log).toEqual(["present", "run-start", "run-start"]);
  });

  it("start() returning early with a tripped breaker: the suppression lifts", async () => {
    const h = makeSupervisor();
    const c1 = await boundFreshRun(h);
    void c1;
    await h.sup.stop();
    // Trip the breaker on a live path: a start whose child errors ENOENT.
    await h.sup.start();
    const c2 = await childN(2);
    c2.emit("error", ENOENT());
    await settle();
    expect(h.log).toEqual(["present", "run-start"]); // suppression lifted, settle running
    await h.sup.stop();
    await h.sup.start(); // returns early: breaker tripped
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present"]);
  });

  it("a start() already in flight when stop() begins does not lift the suppression, and stop()'s own writes emit nothing", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await h.sup.stop();
    await updateLauncherSettings(baseDir, { startMode: "off" }, null);
    const starting = h.sup.start(); // in flight
    const stopping = h.sup.stop(); // begins after it
    await starting;
    await stopping;
    await settle();
    expect(h.log).toEqual(["present", "run-start"]);
  });

  it("once stop() has begun: a fault-killed unbound spawn judged at stop()'s release emits no failed-bind event", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    c1.holdExit = true;
    c1.stdin.emit("error", EPIPE());
    await until(() => c1.killed, "the fault kill");
    await h.sup.stop();
    await settle();
    expect(h.log).toEqual([]);
    expect(failedLines()).toBe(1); // judged and logged, not emitted
  });

  it("once stop() has begun: a bind landing before shutdown's kill is a run start that emits no event", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    const creds = credentialsOf(c1);
    // Another operation holds the lock, so stop()'s locked body (which sets
    // the deliberate cause) has not run when the bind lands: the bind is a
    // real run start, and only the suppression keeps it silent.
    const refreshing = h.sup.refreshConfigured();
    const stopping = h.sup.stop();
    expect(await bind(c1, creds)).toBe(true);
    expect(h.seam.diagnosticsForTests().lastRunBound).toBe(true);
    await refreshing;
    await stopping;
    await settle();
    expect(h.log).toEqual([]);
  });
});

describe("R2.7: the live standby read", () => {
  it("answers Off synchronously inside setStandby's write, before any recompute has run", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    const seen: Array<{ notOff: boolean; present: boolean; recomputes: number }> = [];
    const before = h.seam.diagnosticsForTests().recomputes;
    standbySubscribeProbe = () =>
      seen.push({
        notOff: h.seam.standbyNotOff(),
        present: h.seam.isPresent(),
        recomputes: h.seam.diagnosticsForTests().recomputes,
      });
    await h.sup.updateSettings({ startMode: "off" });
    expect(seen[0]).toEqual({ notOff: false, present: true, recomputes: before });
  });

  it("answers Off immediately after an Off is saved, while the announced value has not moved", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    // Suppressed (shutdown), so nothing is announced: the live read is all
    // that moves.
    await h.sup.stop();
    await h.sup.updateSettings({ startMode: "off" });
    expect(h.seam.standbyNotOff()).toBe(false);
    expect(h.seam.isPresent()).toBe(true);
  });
});

describe("none from status()", () => {
  it("status() never recomputes or announces, including its cli-unusable clear (Ruling H)", async () => {
    let bin: string | null = process.execPath;
    const h = makeSupervisor({ resolveClaudeCommand: () => bin });
    await boundFreshRun(h);
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    bin = null;
    expect(await h.sup.startByUser()).toEqual({ spawned: false, why: "cli-unusable" });
    await settle();
    advance(SETTLE * 2);
    await settle();
    const log = [...h.log];
    const recomputes = h.seam.diagnosticsForTests().recomputes;
    bin = process.execPath;
    expect(h.sup.status().lastError).toBeUndefined(); // the clear ran
    for (let i = 0; i < 5; i++) h.sup.status();
    await settle();
    expect(h.seam.diagnosticsForTests().recomputes).toBe(recomputes);
    expect(h.log).toEqual(log);
  });
});

describe("the dark requirement: flag off, nothing", () => {
  it("flag off: no microtask is queued and no timer beyond master's is armed, across a spawn, a turn, a relaunch and a stop", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const micro = vi.spyOn(globalThis, "queueMicrotask");
    try {
      const h = makeSupervisor();
      await h.sup.startFresh(cwdDir);
      const c1 = await childN(1);
      await settle();
      // Master's timers for a fresh spawn with its bootstrap turn: the wake
      // latch, the receipt check and the backoff reset. A window timer would
      // make this 4.
      expect(vi.getTimerCount()).toBe(3);
      pushJson(c1, RESULT_OK);
      await settle();
      h.emit(annotationEvent()); // a turn
      await settle();
      expect(vi.getTimerCount()).toBe(3);
      await h.sup.relaunch();
      const c2 = await childN(2);
      await settle();
      // The turn above went unanswered, so the relaunch carries a wake: the
      // second spawn resumes and writes one turn.
      expect(argAfter(c2, "--resume")).toBeDefined();
      expect(c2.stdin.writes).toHaveLength(1);
      // Master's timers after the relaunch: the first spawn's backoff reset
      // (never cleared; it checks `child === spawned` when it fires), the
      // relaunch's SIGTERM grace for the first child (resolved by its exit,
      // never cleared), the second spawn's resume confirmation, its wake turn's
      // latch and receipt check, and its backoff reset. A window timer would
      // make this 7.
      expect(vi.getTimerCount()).toBe(6);
      await h.sup.stop();
      await settle();
      // After stop(): the second spawn's confirmation, latch and receipt are
      // cleared; left are the two backoff resets and the two SIGTERM graces
      // (the relaunch's and the stop's).
      expect(vi.getTimerCount()).toBe(4);
      expect(micro).not.toHaveBeenCalled();
      expect(h.seam.diagnosticsForTests().recomputes).toBe(0);
    } finally {
      micro.mockRestore();
    }
  });

  it("R2.6's guard: flag off, a relaunch whose plan read throws records no spawn-failed (master's behaviour)", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    await childN(1);
    fs.rmSync(path.join(baseDir, "integrations.json"));
    fs.mkdirSync(path.join(baseDir, "integrations.json"));
    await expect(h.sup.relaunch()).rejects.toThrow();
    expect(h.sup.status().lastError).toBeUndefined();
  });

  it("no spawn record, window, recompute, announcement or log line; the same argv shape", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    expect(argAfter(c1, "--mcp-config")).toBeUndefined();
    advance(WINDOW * 2);
    c1.exitWith(1, null);
    await settle();
    expect(h.log).toEqual([]);
    expect(h.seam.diagnosticsForTests().recomputes).toBe(0);
    expect(h.seam.isPresent()).toBe(false);
    expect(h.seam.standbyNotOff()).toBe(false);
    expect(logText()).not.toMatch(/ownership\)/);
  });
});

// --- #2358 PR 3b-2a: requestWake and startOrWake (built, not called) -------------

/** `status().restartPending`, read off either branch of the union. */
function pendingOf(h: ReturnType<typeof makeSupervisor>): true | undefined {
  return (h.sup.status() as { restartPending?: true }).restartPending;
}

/** The texts of the turns written to a child. */
function turnTexts(child: FakeChild): string[] {
  return child.stdin.writes.map(
    (w) => (JSON.parse(w) as { message: { content: { text: string }[] } }).message.content[0].text,
  );
}
const wakes = (child: FakeChild) =>
  turnTexts(child).filter((t) => t === SUPERVISOR_WAKE_PROMPT).length;

/** A waiting decision double that records its calls (the brief's harness rule). */
function waitingDouble(answer: boolean | (() => boolean)) {
  const d = {
    calls: 0,
    fn: (): boolean => {
      d.calls += 1;
      return typeof answer === "function" ? answer() : answer;
    },
  };
  return d;
}

/** A licence decision double: refuses while `refusing`, throws while `throwing`. */
function licenceDouble() {
  const d = {
    refusing: false,
    throwing: false,
    calls: 0,
    fn: (): AiRefusal | null => {
      d.calls += 1;
      if (d.throwing) throw new Error("licence decision boom doc_secret");
      return d.refusing ? REFUSAL : null;
    },
  };
  return d;
}

/** A local-period double the test switches by hand. */
function localDouble() {
  const d = {
    held: false,
    switchTo: (_c: { to: "local" } | { to: "claude"; asked: boolean }) => {},
    opts: {
      held: () => d.held,
      subscribe: (cb: (c: { to: "local" } | { to: "claude"; asked: boolean }) => void) => {
        d.switchTo = cb;
        return () => {};
      },
    },
  };
  return d;
}

/** Wait until every operation queued on the op lock before now has run. */
async function lockBarrier(h: ReturnType<typeof makeSupervisor>): Promise<void> {
  await h.sup.refreshConfigured();
  await settle();
}

/** A running child whose bootstrap turn has been answered: idle. */
async function runningIdle(h: ReturnType<typeof makeSupervisor>): Promise<FakeChild> {
  const n = children.length;
  await h.sup.startFresh(cwdDir);
  const c = await childN(n + 1);
  pushJson(c, RESULT_OK);
  await settle();
  return c;
}

const IDLE_MS = 100;
/** Idle-stopped (standby "idle"), its first child answered and exited. */
async function idleStopped(extra: ExtraOpts = {}): Promise<{
  h: ReturnType<typeof makeSupervisor>;
  c1: FakeChild;
}> {
  await updateLauncherSettings(baseDir, { lifetime: "idle", idleMinutes: 1 }, null);
  const h = makeSupervisor({ idleMinuteMs: IDLE_MS, ...extra });
  const n = children.length;
  await h.sup.startFresh(cwdDir);
  const c1 = await childN(n + 1);
  pushJson(c1, RESULT_OK);
  await settle();
  advance(IDLE_MS);
  await until(() => c1.signalCode !== null || c1.exitCode !== null, "the idle stop");
  await settle();
  expect(h.sup.status()).toMatchObject({ running: false, standby: "idle" });
  return { h, c1 };
}

/** Off (standby "off") after an answered first child. */
async function offStopped(extra: ExtraOpts = {}) {
  const h = makeSupervisor(extra);
  const c1 = await runningIdle(h);
  await h.sup.updateSettings({ startMode: "off" });
  await settle();
  expect(h.sup.status()).toMatchObject({ running: false, standby: "off" });
  return { h, c1 };
}

async function savedStartMode(): Promise<string> {
  return (await readLauncherSettings(baseDir)).settings.startMode;
}

/** The per-test timeout of a case that runs `tripBreaker` (#2358 PR 3b-2b1a,
 *  R0.5): up to 12 spawn cycles, each waiting on real file I/O, under a
 *  default `testTimeout` of 15 s. The headroom is for a loaded Windows
 *  runner, not a wall-clock claim. */
const BREAKER_TIMEOUT_MS = 60_000;

/** Crash `c` and its restarts until the windowed breaker trips (the [0]
 *  backoff is a faked timer). */
async function tripBreaker(h: ReturnType<typeof makeSupervisor>, first: FakeChild): Promise<void> {
  let c = first;
  for (let i = 0; i < 12; i++) {
    const prev = children.length;
    c.exitWith(1, null);
    await settle();
    if (h.sup.status().lastError === "circuit-open") break;
    advance(1);
    c = await childN(prev + 1);
    await settle();
  }
  await until(() => h.sup.status().lastError === "circuit-open", "the breaker");
}

describe("3b-2a R1: requestWake", () => {
  it("idle: one wake now; more calls mid-turn give one follow-up after the result", async () => {
    const h = makeSupervisor();
    const c = await runningIdle(h);
    h.sup.requestWake?.();
    expect(wakes(c)).toBe(1);
    h.sup.requestWake?.();
    h.sup.requestWake?.();
    expect(wakes(c)).toBe(1);
    pushJson(c, RESULT_OK);
    await settle();
    expect(wakes(c)).toBe(2);
    pushJson(c, RESULT_OK);
    await settle();
    expect(wakes(c)).toBe(2);
  });

  it("licence refusing: nothing written, nothing owed on the spawn or across spawns", async () => {
    const lic = licenceDouble();
    const h = makeSupervisor({ aiRefusal: lic.fn });
    const c = await runningIdle(h);
    lic.refusing = true;
    h.sup.requestWake?.();
    expect(c.stdin.writes).toHaveLength(1); // the bootstrap only
    pushJson(c, RESULT_OK); // a turn boundary flushes nothing
    await settle();
    expect(c.stdin.writes).toHaveLength(1);
    lic.refusing = false;
    await h.sup.relaunch();
    const c2 = await childN(2);
    await settle();
    expect(argAfter(c2, "--resume")).toBeDefined();
    expect(c2.stdin.writes).toHaveLength(0);
  });

  it("positive twin: licence admitting, one turn", async () => {
    const lic = licenceDouble();
    const h = makeSupervisor({ aiRefusal: lic.fn });
    const c = await runningIdle(h);
    h.sup.requestWake?.();
    expect(wakes(c)).toBe(1);
  });

  it("stdin not writable: nothing now; once writable, the next turn boundary writes the wake once", async () => {
    const h = makeSupervisor();
    const c = await runningIdle(h);
    c.stdin.writable = false;
    h.sup.requestWake?.();
    expect(wakes(c)).toBe(0);
    c.stdin.writable = true;
    pushJson(c, RESULT_OK); // a turn boundary
    await settle();
    expect(wakes(c)).toBe(1);
    pushJson(c, RESULT_OK);
    await settle();
    expect(wakes(c)).toBe(1);
  });

  it("a licence decision that throws: the call returns normally and writes nothing", async () => {
    const lic = licenceDouble();
    const h = makeSupervisor({ aiRefusal: lic.fn });
    const c = await runningIdle(h);
    lic.throwing = true;
    expect(() => h.sup.requestWake?.()).not.toThrow();
    expect(c.stdin.writes).toHaveLength(1);
    // Name only in the log: the message is not echoed.
    expect(logText()).not.toMatch(/doc_secret/);
  });

  it("local period held: nothing written; the switch back's wakes are not doubled", async () => {
    async function run(callRequestWake: boolean): Promise<number> {
      const lp = localDouble();
      const h = makeSupervisor({ localPeriod: lp.opts });
      const c = await runningIdle(h);
      lp.held = true;
      lp.switchTo({ to: "local" });
      if (callRequestWake) h.sup.requestWake?.();
      expect(wakes(c)).toBe(0);
      lp.held = false;
      lp.switchTo({ to: "claude", asked: true });
      // The switch back's own wake reaches a running child through the push
      // path (an event), as in production.
      h.emit(chatEvent());
      await settle();
      pushJson(c, RESULT_OK);
      await settle();
      const n = wakes(c);
      await h.sup.stop();
      return n;
    }
    const without = await run(false);
    const withCall = await run(true);
    expect(without).toBe(1);
    expect(withCall).toBe(without);
  });

  it("no child: requestWake spawns nothing", async () => {
    // With no child there is nothing any build could write a turn to, and the
    // next spawn here is fresh (its bootstrap clears any owed wake), so the
    // only thing this case can catch is a requestWake that spawns. "The next
    // spawn writes no wake on its account" is asserted on the Off-released
    // sibling below, whose next spawn resumes.
    const h = makeSupervisor();
    h.sup.requestWake?.();
    await settle();
    expect(children).toHaveLength(0);
  });

  it("a child whose delivery an Off released: nothing written, and the next spawn writes no wake on its account", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    c1.holdExit = true;
    const off = h.sup.updateSettings({ startMode: "off" });
    await until(() => c1.killed, "the Off's SIGTERM");
    h.sup.requestWake?.();
    expect(c1.stdin.writes).toHaveLength(1);
    c1.releaseExit();
    await off;
    await h.sup.startByUser();
    const c2 = await childN(2);
    await settle();
    expect(argAfter(c2, "--resume")).toBeDefined();
    expect(c2.stdin.writes).toHaveLength(0);
  });

  it("a delivery-killed child that has not exited (still holding its delivery): nothing written", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    c1.holdExit = true;
    c1.stdin.emit("error", EPIPE()); // the stdin-gone kill
    await until(() => c1.killed, "the delivery kill");
    h.sup.requestWake?.();
    expect(c1.stdin.writes).toHaveLength(1);
  });

  it("flag off: nothing written, no timer, no log line", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const lic = licenceDouble();
    const h = makeSupervisor({ aiRefusal: lic.fn });
    const c = await runningIdle(h);
    const timers = vi.getTimerCount();
    const logged = errSpy.mock.calls.length;
    const licCalls = lic.calls;
    h.sup.requestWake?.();
    await settle();
    expect(c.stdin.writes).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(timers);
    expect(errSpy.mock.calls.length).toBe(logged);
    expect(lic.calls).toBe(licCalls);
  });
});

describe("3b-2a R2: startOrWake", () => {
  describe("H1: a chat behind the user's Start", () => {
    async function h1(sow: "none" | "false" | "true"): Promise<{ c2: FakeChild; calls: number }> {
      const waiting = waitingDouble(sow === "true");
      const { h } = await idleStopped({ workWaiting: waiting.fn });
      const starting = h.sup.startByUser();
      h.emit(chatEvent()); // accepted; its pass queues behind the Start
      if (sow !== "none") h.sup.startOrWake?.("document");
      expect(pendingOf(h)).toBe(true);
      await starting;
      const c2 = await childN(2);
      await settle();
      expect(argAfter(c2, "--resume")).toBeDefined();
      pushJson(c2, RESULT_OK); // the spawn's own first turn
      await settle();
      // The pass has demonstrably run: the lock is past it, the queued start
      // no longer reads as pending, and (with a call) the waiting double ran.
      await lockBarrier(h);
      expect(pendingOf(h)).toBeUndefined();
      if (sow !== "none") expect(waiting.calls).toBe(1);
      pushJson(c2, RESULT_OK); // flush anything left pending
      await settle();
      return { c2, calls: waiting.calls };
    }
    it("no startOrWake: exactly one wake turn on the new child", async () => {
      expect(wakes((await h1("none")).c2)).toBe(1);
    });
    it("a startOrWake that finds nothing waiting: exactly one wake turn", async () => {
      expect(wakes((await h1("false")).c2)).toBe(1);
    });
    it("twin, waiting true: the live child gets exactly one extra wake turn (Accepted)", async () => {
      expect(wakes((await h1("true")).c2)).toBe(2);
    });
  });

  it("idle-stopped, another AI attached, waiting true: one resumed spawn whose first turn is the wake, mode unchanged", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn, otherAiAttached: () => true });
    h.sup.startOrWake?.("document");
    await lockBarrier(h);
    const c2 = await childN(2);
    await settle();
    expect(children).toHaveLength(2);
    expect(argAfter(c2, "--resume")).toBeDefined();
    expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    expect(await savedStartMode()).toBe("auto");
  });

  it("twin: waiting false, no spawn", async () => {
    const waiting = waitingDouble(false);
    const { h } = await idleStopped({ workWaiting: waiting.fn, otherAiAttached: () => true });
    h.sup.startOrWake?.("document");
    await lockBarrier(h);
    expect(waiting.calls).toBe(1);
    expect(children).toHaveLength(1);
  });

  describe("H3: a chat and a startOrWake in one pass, another AI attaching by the pass", () => {
    async function h3(waitingAnswer: boolean) {
      let calls = 0;
      const waiting = waitingDouble(waitingAnswer);
      const { h } = await idleStopped({
        workWaiting: waiting.fn,
        // Clear when the chat is accepted, attached by the time the pass runs.
        otherAiAttached: () => ++calls > 1,
      });
      calls = 0;
      h.emit(chatEvent());
      h.sup.startOrWake?.("message");
      await lockBarrier(h);
      expect(calls).toBe(2); // acceptance, then the pass's guard
      expect(waiting.calls).toBe(1);
      return h;
    }
    it("waiting false: no spawn", async () => {
      await h3(false);
      expect(children).toHaveLength(1);
    });
    it("waiting true: one spawn", async () => {
      await h3(true);
      await childN(2);
      await settle();
      expect(children).toHaveLength(2);
    });
  });

  it("live standby Off at the call: nothing recorded, no pass, and a later Start writes no wake for it", async () => {
    const waiting = waitingDouble(true);
    const { h } = await offStopped({ workWaiting: waiting.fn });
    // The user's Start is queued first: a pass admitted here would run after
    // it, find the live child and wake it.
    const starting = h.sup.startByUser();
    h.sup.startOrWake?.("document");
    await starting;
    const c2 = await childN(2);
    await lockBarrier(h);
    expect(waiting.calls).toBe(0);
    expect(h.seam.diagnosticsForTests().startPasses).toBe(0);
    expect(c2.stdin.writes).toHaveLength(0);
  });

  it("positive twin: the same Start with the call admitted (standby idle) wakes the new child", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    const starting = h.sup.startByUser();
    h.sup.startOrWake?.("document");
    await starting;
    const c2 = await childN(2);
    await lockBarrier(h);
    expect(waiting.calls).toBe(1);
    expect(wakes(c2)).toBe(1);
  });

  it("shutdown: a startOrWake during stop() is dropped (nothing recorded, no pass)", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    const stopping = h.sup.stop();
    h.sup.startOrWake?.("document");
    await stopping;
    await lockBarrier(h);
    expect(waiting.calls).toBe(0);
    expect(h.seam.diagnosticsForTests().startPasses).toBe(0);
    expect(children).toHaveLength(1);
  });

  it("a pass queued ahead of stop(): no start (the pass-time shutdown check); twin without stop() starts", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    h.sup.startOrWake?.("document");
    await h.sup.stop();
    await settle();
    expect(waiting.calls).toBe(1);
    expect(children).toHaveLength(1);

    const w2 = waitingDouble(true);
    const second = await idleStopped({ workWaiting: w2.fn });
    second.h.sup.startOrWake?.("document");
    await lockBarrier(second.h);
    expect(children).toHaveLength(3);
  });

  it("a pass queued ahead of stop() with a live child writes no turn; twin without stop() wakes it", async () => {
    const waiting = waitingDouble(true);
    const h = makeSupervisor({ workWaiting: waiting.fn });
    const c1 = await runningIdle(h);
    h.sup.startOrWake?.("document");
    await h.sup.stop();
    expect(waiting.calls).toBe(1);
    expect(c1.stdin.writes).toHaveLength(1);

    const w2 = waitingDouble(true);
    const h2 = makeSupervisor({ workWaiting: w2.fn });
    const c2 = await runningIdle(h2);
    h2.sup.startOrWake?.("document");
    await lockBarrier(h2);
    expect(wakes(c2)).toBe(1);
  });

  /** The Off-ahead construction (the brief's four steps). */
  async function offAhead(
    h: ReturnType<typeof makeSupervisor>,
    order: string[],
  ): Promise<FakeChild> {
    let relaunchChild: FakeChild | null = null;
    // Each step is recorded where the lock runs it, not at its promise's
    // settlement (which trails the next operation's start by microtasks):
    // the relaunch at its spawn, the Off where it sets the standby (arming the
    // standby watch), the pass at its waiting decision.
    onSpawn = (c) => {
      c.holdExit = true; // 1: the relaunch's new child holds its exit
      relaunchChild = c;
      order.push("relaunch");
      onSpawn = null;
    };
    standbySubscribeProbe = () => {
      order.push("off");
      standbySubscribeProbe = null;
    };
    const relaunching = h.sup.relaunch(); // 2
    const off = h.sup.updateSettings({ startMode: "off" }); // 3
    h.sup.startOrWake?.("document"); // 4: a running child, standby unset: admitted
    await relaunching;
    const c2 = relaunchChild as unknown as FakeChild;
    await until(() => c2.killed, "the Off's SIGTERM");
    c2.releaseExit();
    await off;
    await lockBarrier(h);
    return c2;
  }

  it("Off ahead of the pass, waiting true: the lock ran relaunch, Off, pass; no spawn after the Off, mode Off, nothing owed", async () => {
    const order: string[] = [];
    const waiting = waitingDouble(() => {
      order.push("pass");
      return true;
    });
    const h = makeSupervisor({ workWaiting: waiting.fn });
    await runningIdle(h);
    await offAhead(h, order);
    expect(order).toEqual(["relaunch", "off", "pass"]);
    expect(children).toHaveLength(2);
    expect(await savedStartMode()).toBe("off");
    expect(h.sup.status()).toMatchObject({ running: false, standby: "off" });
    // Nothing owed: the user's later Start writes no wake.
    await h.sup.startByUser();
    const c3 = await childN(3);
    await settle();
    expect(c3.stdin.writes).toHaveLength(0);
  });

  describe("H4 (rebuilt in 3b-2b1a, R3.7): a startOrWake joins the pass a chat queued behind an Off", () => {
    // From idle-stopped, in one synchronous run: the Off queues on the lock,
    // the chat is accepted (the Off's body has not run, so the standby still
    // reads idle) and queues its own pass behind the Off, and the call joins
    // that queued pass. At the pass the standby reads Off.
    async function h4(otherAiAtPass: boolean) {
      let calls = 0;
      const waiting = waitingDouble(true);
      const { h } = await idleStopped({
        workWaiting: waiting.fn,
        // Clear at the chat's acceptance; attached by the pass when asked.
        otherAiAttached: () => otherAiAtPass && ++calls > 1,
      });
      calls = 0;
      const logged = (logText().match(/Start-or-wake queued/g) ?? []).length;
      const off = h.sup.updateSettings({ startMode: "off" });
      h.emit(chatEvent());
      h.sup.startOrWake?.("document");
      // Joined: the call queued no pass of its own.
      expect((logText().match(/Start-or-wake queued/g) ?? []).length).toBe(logged);
      await off;
      await lockBarrier(h);
      expect(h.seam.diagnosticsForTests().startPasses).toBe(1);
      return { h, waiting };
    }
    it("no other AI at the pass: today's arm starts Claude from Off and saves on-click", async () => {
      const { waiting } = await h4(false);
      const c2 = await childN(2);
      expect(children).toHaveLength(2);
      expect(argAfter(c2, "--resume")).toBeDefined();
      expect(await savedStartMode()).toBe("on-click");
      // Today's arm started it, so start-or-wake's share did not run.
      expect(waiting.calls).toBe(0);
    });
    it("another AI at the pass: today's arm declines, the share returns at Off: no spawn, mode still Off", async () => {
      const { h, waiting } = await h4(true);
      expect(waiting.calls).toBe(1);
      expect(children).toHaveLength(1);
      expect(await savedStartMode()).toBe("off");
      expect(h.sup.status()).toMatchObject({ running: false, standby: "off" });
    });
  });

  it("H2: a chat accepted during a pass's respawn leaves nothing that starts a later pass from Off", async () => {
    const order: string[] = [];
    const waiting = waitingDouble(() => {
      order.push("pass");
      return true;
    });
    let otherAiCalls = 0;
    const { h } = await idleStopped({
      workWaiting: waiting.fn,
      otherAiAttached: () => {
        otherAiCalls += 1;
        return false;
      },
    });
    // The pass's own spawn: a chat lands while the standby watch is still armed.
    // Since 3b-2b1a (R3.1) that chat has its own pass, queued behind this
    // one, which finds the child live and starts nothing; the case's premise
    // (nothing left over that starts a later pass from Off) is unchanged.
    // Acceptance is read from the watch's own effect: it calls `otherAiAttached`
    // only as its last check, after the standby, breaker and start-worthy
    // checks pass, and a start-or-wake-only pass never calls it. (A
    // `restartPending` read here would be true anyway: `launching > 0`.)
    let acceptedCalls = -1;
    onSpawn = () => {
      onSpawn = null;
      const before = otherAiCalls;
      h.emit(chatEvent());
      acceptedCalls = otherAiCalls - before;
    };
    h.sup.startOrWake?.("document");
    await lockBarrier(h);
    const c2 = await childN(2);
    expect(acceptedCalls).toBe(1);
    pushJson(c2, RESULT_OK);
    await settle();
    expect(pendingOf(h)).toBeUndefined();
    await updateLauncherSettings(baseDir, { lifetime: "always" }, null);
    order.length = 0;
    await offAhead(h, order);
    expect(order).toEqual(["relaunch", "off", "pass"]);
    expect(children).toHaveLength(3); // the relaunch's child only
    expect(await savedStartMode()).toBe("off");
  });

  describe("R2.5: standby unset", () => {
    it("a restartTimer pending: no second spawn, and the restart's spawn writes the wake", async () => {
      const waiting = waitingDouble(true);
      const h = makeSupervisor({ workWaiting: waiting.fn, restartBackoffsMs: [1000] });
      const c1 = await runningIdle(h);
      c1.exitWith(1, null);
      await settle();
      expect(pendingOf(h)).toBe(true);
      h.sup.startOrWake?.("document");
      await lockBarrier(h);
      expect(waiting.calls).toBe(1);
      expect(children).toHaveLength(1);
      advance(1000);
      const c2 = await childN(2);
      await settle();
      expect(argAfter(c2, "--resume")).toBeDefined();
      expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    });

    it("twin: the same restart with no call writes no turn", async () => {
      const h = makeSupervisor({ restartBackoffsMs: [1000] });
      const c1 = await runningIdle(h);
      c1.exitWith(1, null);
      await settle();
      advance(1000);
      const c2 = await childN(2);
      await settle();
      expect(c2.stdin.writes).toHaveLength(0);
    });

    it("launching > 0 (an unlocked crash restart under way): nothing owed", async () => {
      let pendingAtPass: boolean | undefined;
      const waiting = waitingDouble(() => {
        pendingAtPass = pendingOf(h);
        return true;
      });
      const h = makeSupervisor({ workWaiting: waiting.fn, restartBackoffsMs: [1000] });
      const c1 = await runningIdle(h);
      c1.exitWith(1, null);
      await settle();
      advance(1000); // the restart starts, unlocked, and awaits its plan
      h.sup.startOrWake?.("document");
      const c2 = await childN(2);
      await lockBarrier(h);
      expect(waiting.calls).toBe(1);
      expect(pendingAtPass).toBe(true);
      expect(children).toHaveLength(2);
      expect(c2.stdin.writes).toHaveLength(0);
    });

    it(
      "a tripped breaker (standby unset, no restart timer): nothing",
      async () => {
        const waiting = waitingDouble(true);
        const h = makeSupervisor({ workWaiting: waiting.fn });
        await tripBreaker(h, await runningIdle(h));
        const n = children.length;
        h.sup.startOrWake?.("document");
        await lockBarrier(h);
        expect(children).toHaveLength(n);
        // Nothing owed: the user's Start (which resets the breaker) writes no
        // wake. That half can fail only on a resumed spawn (a fresh spawn's
        // bootstrap clears an owed wake), so the spawn's kind is asserted
        // first. The harness gives a resumed one here (observed while building
        // #2358 PR 3b-2b1a, R0.4, where the brief expected a fresh one): the
        // crash loop alternates, since a resumed child's unconfirmed non-zero
        // exit clears the saved session (`shouldClearSession`) and the fresh
        // spawn after it saves a new one, which the Start then resumes.
        await h.sup.startByUser();
        const next = await childN(n + 1);
        await settle();
        expect(argAfter(next, "--resume")).toBeDefined();
        expect(wakes(next)).toBe(0);
      },
      BREAKER_TIMEOUT_MS,
    );

    it(
      "a tripped breaker with a standby set (trip, Off, mode on): no spawn",
      async () => {
        // The state the pass's breaker guards exist for: Off then a mode change
        // leave the standby `awaiting-start` and the breaker tripped (only a
        // non-message respawn resets it), and a message-kind respawn neither
        // refuses nor resets it.
        const waiting = waitingDouble(true);
        const h = makeSupervisor({ workWaiting: waiting.fn });
        await tripBreaker(h, await runningIdle(h));
        await h.sup.updateSettings({ startMode: "off" });
        await h.sup.updateSettings({ startMode: "auto" });
        expect(h.sup.status()).toMatchObject({ running: false, standby: "awaiting-start" });
        const n = children.length;
        h.sup.startOrWake?.("document");
        await lockBarrier(h);
        expect(waiting.calls).toBe(1);
        expect(children).toHaveLength(n);
      },
      BREAKER_TIMEOUT_MS,
    );

    it(
      "positive twin: the same after the user's Start has reset the breaker: one spawn",
      async () => {
        const waiting = waitingDouble(true);
        const h = makeSupervisor({ workWaiting: waiting.fn });
        await tripBreaker(h, await runningIdle(h));
        await h.sup.startByUser(); // resets the breaker
        await childN(children.length);
        await h.sup.updateSettings({ startMode: "off" });
        await h.sup.updateSettings({ startMode: "auto" });
        expect(h.sup.status()).toMatchObject({ running: false, standby: "awaiting-start" });
        const n = children.length;
        h.sup.startOrWake?.("document");
        await lockBarrier(h);
        await childN(n + 1);
        expect(children).toHaveLength(n + 1);
      },
      BREAKER_TIMEOUT_MS,
    );
  });

  describe("R2.6: the licence inside the pass", () => {
    it("a running child admitted at the call, refused by the pass: nothing written; twin admitting wakes it", async () => {
      const lic = licenceDouble();
      const waiting = waitingDouble(true);
      const h = makeSupervisor({ aiRefusal: lic.fn, workWaiting: waiting.fn });
      const c1 = await runningIdle(h);
      h.sup.startOrWake?.("document");
      lic.refusing = true;
      await lockBarrier(h);
      expect(waiting.calls).toBe(1);
      expect(c1.stdin.writes).toHaveLength(1);
      lic.refusing = false;
      h.sup.startOrWake?.("document");
      await lockBarrier(h);
      expect(wakes(c1)).toBe(1);
    });

    it("no child, admitted at the call, refused in respawn: no spawn, recorded; activation spawns once and writes the wake", async () => {
      const lic = licenceDouble();
      const waiting = waitingDouble(true);
      const { h } = await idleStopped({ aiRefusal: lic.fn, workWaiting: waiting.fn });
      h.sup.startOrWake?.("document");
      lic.refusing = true;
      await lockBarrier(h);
      expect(children).toHaveLength(1);
      expect(h.sup.licenceRefusal()).not.toBeNull();
      expect(h.sup.status().lastError).toBe("unlicensed");
      lic.refusing = false;
      await h.sup.resumeAfterLicence();
      const c2 = await childN(2);
      await settle();
      expect(children).toHaveLength(2);
      expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    });

    it("refused at the call: activation spawns nothing for it", async () => {
      const lic = licenceDouble();
      const waiting = waitingDouble(true);
      const { h } = await idleStopped({ aiRefusal: lic.fn, workWaiting: waiting.fn });
      lic.refusing = true;
      h.sup.startOrWake?.("document");
      lic.refusing = false;
      await lockBarrier(h);
      await h.sup.resumeAfterLicence();
      await settle();
      expect(waiting.calls).toBe(0);
      expect(children).toHaveLength(1);
    });
  });

  describe("R2.7: the end of a pass", () => {
    it("a call while a pass is running gives exactly one more pass, which wakes the new child", async () => {
      const waiting = waitingDouble(true);
      const { h } = await idleStopped({ workWaiting: waiting.fn });
      onSpawn = () => {
        onSpawn = null;
        h.sup.startOrWake?.("document"); // during the first pass's respawn
      };
      h.sup.startOrWake?.("document");
      const c2 = await childN(2);
      await lockBarrier(h);
      await lockBarrier(h);
      expect(h.seam.diagnosticsForTests().startPasses).toBe(2);
      expect(waiting.calls).toBe(2);
      expect(children).toHaveLength(2);
      pushJson(c2, RESULT_OK); // its first turn; the second pass's wake follows
      await settle();
      expect(wakes(c2)).toBe(2);
    });

    it("a chat during a pass whose respawn answers cli-unusable: the chat's own pass retries today's arm (two attempts)", async () => {
      // Before 3b-2b1a the chat joined the running start-or-wake pass and got
      // no attempt of its own (one resolve). Now it gets master's outcome
      // (drafter's ruling 1): its own pass, queued at acceptance, which tries
      // today's arm again after the first attempt failed.
      const waiting = waitingDouble(true);
      let otherAiCalls = 0;
      let bin: string | null = process.execPath;
      let resolves = 0;
      let gate: Promise<void> | null = null;
      let open!: () => void;
      const { h } = await idleStopped({
        workWaiting: waiting.fn,
        otherAiAttached: () => {
          otherAiCalls += 1;
          return false;
        },
        resolveClaudeCommand: () => {
          resolves += 1;
          return bin;
        },
        readSettings: async () => {
          if (gate) await gate;
          return readLauncherSettings(baseDir);
        },
      });
      bin = null;
      resolves = 0;
      gate = new Promise<void>((r) => {
        open = r;
      });
      h.sup.startOrWake?.("document");
      await until(() => waiting.calls === 1, "the pass");
      await settle();
      const before = otherAiCalls;
      h.emit(chatEvent()); // the watch is still armed: accepted, its own pass
      // Accepted: the watch reached its last check (see H2).
      expect(otherAiCalls - before).toBe(1);
      gate = null;
      open();
      await lockBarrier(h);
      await lockBarrier(h);
      expect(h.seam.diagnosticsForTests().startPasses).toBe(2);
      expect(resolves).toBe(2);
      expect(children).toHaveLength(1);
    });
  });

  it("burst: five calls give one pass and one spawn", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    for (let i = 0; i < 5; i++) h.sup.startOrWake?.("document");
    await lockBarrier(h);
    await childN(2);
    await lockBarrier(h);
    expect(h.seam.diagnosticsForTests().startPasses).toBe(1);
    expect(waiting.calls).toBe(1);
    expect(children).toHaveLength(2);
  });

  it("a chat that finds a start-or-wake pass queued gets its own pass behind it (3b-2b1a R3.1)", async () => {
    // Before 3b-2b1a the chat joined the queued pass (one pass, the waiting
    // double never asked). Now the start-or-wake pass runs alone and asks the
    // waiting double (false: it declines), and the chat's own pass starts
    // Claude.
    const waiting = waitingDouble(false);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    h.sup.startOrWake?.("document");
    h.emit(chatEvent()); // accepted: its own pass, queued behind the first
    await lockBarrier(h);
    await childN(2);
    await lockBarrier(h);
    expect(h.seam.diagnosticsForTests().startPasses).toBe(2);
    expect(waiting.calls).toBe(1);
    expect(children).toHaveLength(2);
  });

  it("R2.9: an absent waiting decision starts and wakes nothing", async () => {
    const { h } = await idleStopped();
    h.sup.startOrWake?.("document");
    await lockBarrier(h);
    expect(h.seam.diagnosticsForTests().startPasses).toBe(1);
    expect(children).toHaveLength(1);
    const h2 = makeSupervisor();
    const c = await runningIdle(h2);
    h2.sup.startOrWake?.("document");
    await lockBarrier(h2);
    expect(c.stdin.writes).toHaveLength(1);
  });

  it("R2.9's positive twin: a waiting decision answering true starts, and wakes a live child", async () => {
    const { h } = await idleStopped({ workWaiting: () => true });
    h.sup.startOrWake?.("document");
    await lockBarrier(h);
    await childN(2);
    const h2 = makeSupervisor({ workWaiting: () => true });
    const c = await runningIdle(h2);
    h2.sup.startOrWake?.("document");
    await lockBarrier(h2);
    expect(wakes(c)).toBe(1);
  });

  it("R2.9: a throwing waiting decision starts and wakes nothing", async () => {
    const throwing = () => {
      throw new Error("waiting boom doc_secret");
    };
    const { h } = await idleStopped({ workWaiting: throwing });
    h.sup.startOrWake?.("document");
    await lockBarrier(h);
    expect(children).toHaveLength(1);
    // Caught where the decision is read, not further out (the pass's
    // `.catch` would log "The start pass failed" instead).
    expect(logText()).toMatch(/The waiting decision threw \(read as nothing waiting\): Error/);
    expect(logText()).not.toMatch(/The start pass failed/);
    const h2 = makeSupervisor({ workWaiting: throwing });
    const c = await runningIdle(h2);
    h2.sup.startOrWake?.("document");
    await lockBarrier(h2);
    expect(c.stdin.writes).toHaveLength(1);
    expect(logText()).not.toMatch(/doc_secret/);
  });

  it("R2.1, R2.12: throwing decisions never throw to the caller or leave a rejection unhandled", async () => {
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const { h } = await idleStopped({
        workWaiting: () => {
          throw new Error("waiting boom");
        },
      });
      expect(() => h.sup.startOrWake?.("document")).not.toThrow();
      await lockBarrier(h);
      const lic = licenceDouble();
      const h2 = makeSupervisor({ aiRefusal: lic.fn });
      await runningIdle(h2);
      lic.throwing = true;
      expect(() => h2.sup.startOrWake?.("document")).not.toThrow();
      expect(() => h2.sup.requestWake?.()).not.toThrow();
      await lockBarrier(h2);
      await settle(10);
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  describe("R2.10: the Starting status", () => {
    it("a start-or-wake-only pass does not read as Starting; a chat accepted behind it does, at once", async () => {
      // The chat no longer joins the queued pass (3b-2b1a R3.1): it has its
      // own, so two passes reach the lock.
      const waiting = waitingDouble(true);
      const { h } = await idleStopped({ workWaiting: waiting.fn });
      h.sup.startOrWake?.("document");
      expect(pendingOf(h)).toBeUndefined();
      h.emit(chatEvent());
      expect(pendingOf(h)).toBe(true);
      await lockBarrier(h);
      expect(h.seam.diagnosticsForTests().startPasses).toBe(2);
    });

    it("a start-or-wake-only pass that declines, with a setup Apply meanwhile: the Apply decides as on master", async () => {
      const waiting = waitingDouble(false);
      const { h } = await idleStopped({ workWaiting: waiting.fn });
      // The Apply first, so its `restartPending()` read runs while the pass is
      // queued behind it (the order in which a wrong build answers "running").
      const applying = h.sup.startAfterSetup();
      h.sup.startOrWake?.("document");
      expect(await applying).toBe("held"); // idle is a choice; "running" would be the queued pass's
      await lockBarrier(h);
      expect(waiting.calls).toBe(1);
    });
  });

  describe("R2.11: during a local-model period", () => {
    it("no child, something waiting: no spawn, and the hold's log line", async () => {
      const lp = localDouble();
      const waiting = waitingDouble(true);
      const { h } = await idleStopped({ workWaiting: waiting.fn, localPeriod: lp.opts });
      lp.held = true;
      lp.switchTo({ to: "local" });
      h.sup.startOrWake?.("document");
      await lockBarrier(h);
      expect(children).toHaveLength(1);
      // Held as Tandem's Claude's own work, not as a chat's start (piece 36).
      expect(logText()).toMatch(/not starting Claude \(work\)/);
      expect(logText()).not.toMatch(/not starting Claude \(message\)/);
    });

    it("positive twin: no local period, something waiting, no child: one spawn", async () => {
      const lp = localDouble();
      const waiting = waitingDouble(true);
      const { h } = await idleStopped({ workWaiting: waiting.fn, localPeriod: lp.opts });
      h.sup.startOrWake?.("document");
      await lockBarrier(h);
      await childN(2);
      expect(logText()).not.toMatch(/not starting Claude \((message|work)\)/);
    });

    it("a live child: nothing written", async () => {
      const lp = localDouble();
      const waiting = waitingDouble(true);
      const h = makeSupervisor({ workWaiting: waiting.fn, localPeriod: lp.opts });
      const c = await runningIdle(h);
      lp.held = true;
      lp.switchTo({ to: "local" });
      h.sup.startOrWake?.("document");
      await lockBarrier(h);
      expect(waiting.calls).toBe(1);
      expect(c.stdin.writes).toHaveLength(1);
    });
  });

  // #2358 piece 36: the user's switch back runs a start held for Tandem's
  // Claude's own work only if something is still waiting (Bryan, 2026-11-17:
  // "Yes, only if still waiting"), whether or not another AI is attached
  // ("Yes, unless Claude is Off"), and never when Off.
  describe("piece 36: the switch back and a start held for waiting work", () => {
    /** Idle-stopped, the local period on, one start-or-wake held as work. */
    async function heldForWork(extra: ExtraOpts & { waiting: () => boolean }) {
      const lp = localDouble();
      const waiting = waitingDouble(extra.waiting);
      const { h } = await idleStopped({ ...extra, workWaiting: waiting.fn, localPeriod: lp.opts });
      lp.held = true;
      lp.switchTo({ to: "local" });
      h.sup.startOrWake?.("document");
      await lockBarrier(h);
      expect(children).toHaveLength(1);
      expect(logText()).toMatch(/not starting Claude \(work\)/);
      const asked = waiting.calls;
      return { h, lp, waiting, asked };
    }

    async function switchBack(
      h: ReturnType<typeof makeSupervisor>,
      lp: ReturnType<typeof localDouble>,
      asked = true,
    ) {
      lp.held = false;
      lp.switchTo({ to: "claude", asked });
      await lockBarrier(h);
      await settle();
    }

    it("still waiting, another AI attached: one resumed spawn whose first turn is the wake", async () => {
      const { h, lp, waiting, asked } = await heldForWork({
        waiting: () => true,
        otherAiAttached: () => true,
      });
      await switchBack(h, lp);
      const c2 = await childN(2);
      await settle();
      expect(children).toHaveLength(2);
      expect(waiting.calls).toBe(asked + 1);
      expect(argAfter(c2, "--resume")).toBeDefined();
      expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
      expect(logText()).toMatch(/answered by Claude again — starting Claude for waiting work/);
    });

    it("twin, no other AI: one spawn", async () => {
      const { h, lp } = await heldForWork({ waiting: () => true });
      await switchBack(h, lp);
      await childN(2);
      await settle();
      expect(children).toHaveLength(2);
    });

    it("the work is gone by the switch back: asked again, no spawn, the not-starting line", async () => {
      let still = true;
      const { h, lp, waiting, asked } = await heldForWork({
        waiting: () => still,
        otherAiAttached: () => true,
      });
      still = false;
      await switchBack(h, lp);
      expect(waiting.calls).toBe(asked + 1);
      expect(children).toHaveLength(1);
      expect(logText()).toMatch(/nothing is waiting for Claude, not starting it/);
      // Still startable by the user's next chat, as any idle standby.
      expect(h.sup.status()).toMatchObject({ running: false, standby: "idle" });
    });

    it("the waiting decision throws at the switch back: read as nothing waiting, no spawn", async () => {
      let boom = false;
      const { h, lp } = await heldForWork({
        waiting: () => {
          if (boom) throw new Error("waiting boom doc_secret");
          return true;
        },
      });
      boom = true;
      await switchBack(h, lp);
      expect(children).toHaveLength(1);
      expect(logText()).toMatch(/The waiting decision threw \(read as nothing waiting\)/);
      expect(logText()).toMatch(/nothing is waiting for Claude, not starting it/);
      expect(logText()).not.toMatch(/doc_secret/);
    });

    it("Off during the period: no spawn, and waiting is not asked again", async () => {
      const { h, lp, waiting, asked } = await heldForWork({ waiting: () => true });
      await h.sup.updateSettings({ startMode: "off" });
      await settle();
      await switchBack(h, lp);
      expect(children).toHaveLength(1);
      expect(waiting.calls).toBe(asked);
      expect(h.sup.status()).toMatchObject({ running: false, standby: "off" });
    });

    it("source pin: every local-period hold in the respawn path records the kind it was given", async () => {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync(
        new URL("../../../src/server/launcher/supervisor.ts", import.meta.url),
        "utf8",
      );
      // A hold recorded as a literal "message" would send a held work start
      // through the chat rule at the switch back (piece 36).
      expect(src).not.toMatch(/holdForLocalPeriod\("message"\)/);
      expect(src.match(/holdForLocalPeriod\(heldAs\)/g)).toHaveLength(4);
    });

    it("Off written to the settings file during the period (not through Turn off): the switch back's own read refuses", async () => {
      const { h, lp, waiting, asked } = await heldForWork({ waiting: () => true });
      await updateLauncherSettings(baseDir, { startMode: "off" }, null);
      await switchBack(h, lp);
      expect(children).toHaveLength(1);
      expect(waiting.calls).toBe(asked);
    });

    it("an unasked switch back: no spawn, and waiting is not asked again", async () => {
      const { h, lp, waiting, asked } = await heldForWork({ waiting: () => true });
      await switchBack(h, lp, false);
      expect(children).toHaveLength(1);
      expect(waiting.calls).toBe(asked);
    });

    it("a chat's held start, another AI attached by the switch back: nothing (today's rule); with work also held: one spawn", async () => {
      for (const alsoWork of [false, true]) {
        const lp = localDouble();
        const waiting = waitingDouble(true);
        let otherAi = false;
        const { h } = await idleStopped({
          workWaiting: waiting.fn,
          localPeriod: lp.opts,
          otherAiAttached: () => otherAi,
        });
        const before = children.length;
        lp.held = true;
        lp.switchTo({ to: "local" });
        h.emit(chatEvent());
        await lockBarrier(h);
        if (alsoWork) h.sup.startOrWake?.("document");
        await lockBarrier(h);
        expect(children).toHaveLength(before);
        expect(logText()).toMatch(/not starting Claude \(message\)/);
        otherAi = true;
        await switchBack(h, lp);
        if (alsoWork) {
          await childN(before + 1);
          await settle();
        }
        expect(children).toHaveLength(alsoWork ? before + 1 : before);
        await h.sup.stop();
      }
    });
  });

  it("flag off: nothing recorded, no pass, never Starting, no log line", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    const logged = errSpy.mock.calls.length;
    const timers = vi.getTimerCount();
    h.sup.startOrWake?.("document");
    // What is observed: no Starting status, no pass reached the lock, no
    // spawn, no log line, no timer. The evidence that no pass ran is the
    // waiting double's call count: a pass with the call recorded asks it,
    // while nothing else can (waiting true, idle-stopped). The pass counter
    // cannot show it: it counts flag on only, so it is 0 here under any
    // build. `restartPending` would read false here even flag on (a
    // start-or-wake-only pass is not a pending restart), so it does not show
    // it either.
    expect(pendingOf(h)).toBeUndefined();
    await lockBarrier(h);
    expect(pendingOf(h)).toBeUndefined();
    expect(waiting.calls).toBe(0);
    expect(children).toHaveLength(1);
    expect(errSpy.mock.calls.length).toBe(logged);
    expect(vi.getTimerCount()).toBe(timers);
  });
});

// --- #2358 PR 3b-2b1a: today's arm coalesces only with today's arm ----------

describe("3b-2b1a R3: a chat's start is decided by its own pass", () => {
  const passes = (h: ReturnType<typeof makeSupervisor>) => h.seam.diagnosticsForTests().startPasses;
  const messageStartLines = () =>
    (logText().match(/A message arrived while Claude was stopped/g) ?? []).length;
  const queuedLines = () => (logText().match(/Start-or-wake queued/g) ?? []).length;

  describe("Coalescing with a running pass", () => {
    // The cli-unusable construction: the pass does not spawn, so a leaked
    // second pass shows as a second resolve. `status()` is not called
    // mid-case (it resolves again while `lastError` is `cli-unusable`).
    async function coalesce(afterEnd = false): Promise<number> {
      let bin: string | null = process.execPath;
      let resolves = 0;
      let gate: Promise<void> | null = null;
      let entered = false;
      let open!: () => void;
      const { h } = await idleStopped({
        resolveClaudeCommand: () => {
          resolves += 1;
          return bin;
        },
        readSettings: async () => {
          if (gate) {
            entered = true;
            await gate;
          }
          return readLauncherSettings(baseDir);
        },
      });
      bin = null;
      resolves = 0;
      gate = new Promise<void>((r) => {
        open = r;
      });
      h.emit(chatEvent()); // accepted: its pass queues and runs
      await until(() => entered, "the pass's gated settings read");
      expect(logText()).toMatch(/A message arrived while Claude was stopped/);
      if (!afterEnd) h.emit(chatEvent()); // the pass is running: coalesced into it
      gate = null;
      open();
      await lockBarrier(h);
      if (afterEnd) {
        // The twin: the first pass has ended, so this chat gets a pass of
        // its own, and the construction shows its second attempt.
        h.emit(chatEvent());
        await lockBarrier(h);
      }
      await lockBarrier(h);
      expect(children).toHaveLength(1);
      return resolves;
    }
    it("flag off: one resolve, no second attempt", async () => {
      vi.stubEnv("TANDEM_OWNERSHIP", "");
      expect(await coalesce()).toBe(1);
    });
    it("flag on: one resolve, no second attempt", async () => {
      expect(await coalesce()).toBe(1);
    });
    it("positive twin, flag off: a chat after that pass has ended gets a second attempt", async () => {
      vi.stubEnv("TANDEM_OWNERSHIP", "");
      expect(await coalesce(true)).toBe(2);
    });
    it("positive twin, flag on: the same, two resolves", async () => {
      expect(await coalesce(true)).toBe(2);
    });
  });

  describe("the row's case: idle-stopped, a start-or-wake pass queued, the user's Off, then a chat", () => {
    async function row(opts: { call: boolean; waiting: boolean }) {
      const waiting = waitingDouble(opts.waiting);
      const { h } = await idleStopped({ workWaiting: waiting.fn });
      let offSettled = false;
      const offAtSpawn: boolean[] = [];
      onSpawn = () => offAtSpawn.push(offSettled);
      if (opts.call) h.sup.startOrWake?.("document"); // P
      const off = h.sup.updateSettings({ startMode: "off" }).then(() => {
        offSettled = true;
      });
      h.emit(chatEvent()); // the standby still reads idle: accepted, Q behind the Off
      await off;
      await lockBarrier(h);
      const last = await childN(children.length);
      await settle();
      return { h, offAtSpawn, last };
    }
    it("waiting false: one spawn, after the Off, from Off: on-click saved, running, the chat's wake on it", async () => {
      const { h, offAtSpawn, last } = await row({ call: true, waiting: false });
      expect(children).toHaveLength(2);
      expect(offAtSpawn).toEqual([true]);
      expect(await savedStartMode()).toBe("on-click");
      expect(h.sup.status().running).toBe(true);
      expect(argAfter(last, "--resume")).toBeDefined();
      expect(turnTexts(last)).toEqual([SUPERVISOR_WAKE_PROMPT]);
      expect(passes(h)).toBe(2);
      pushJson(last, RESULT_OK); // its first turn: anything left owed follows
      await settle();
      expect(wakes(last)).toBe(1);
    });
    it("twin, flag off with no startOrWake: the same outcome", async () => {
      vi.stubEnv("TANDEM_OWNERSHIP", "");
      const { h, offAtSpawn, last } = await row({ call: false, waiting: false });
      expect(children).toHaveLength(2);
      expect(offAtSpawn).toEqual([true]);
      expect(await savedStartMode()).toBe("on-click");
      expect(h.sup.status().running).toBe(true);
      expect(turnTexts(last)).toEqual([SUPERVISOR_WAKE_PROMPT]);
      pushJson(last, RESULT_OK);
      await settle();
      expect(wakes(last)).toBe(1);
    });
    it("waiting true: the pass starts Claude, the Off stops it, the chat's pass starts it again from Off (two spawns, Accepted)", async () => {
      const { h, offAtSpawn } = await row({ call: true, waiting: true });
      expect(children).toHaveLength(3);
      expect(offAtSpawn).toEqual([false, true]);
      expect(children[1].killed).toBe(true);
      expect(await savedStartMode()).toBe("on-click");
      expect(h.sup.status().running).toBe(true);
    });
  });

  it("status across the start-or-wake pass's end: Starting while the chat's pass waits behind the Off", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    let p: FakeChild | null = null;
    onSpawn = (c) => {
      c.holdExit = true; // P's child holds its exit, so the Off waits on it
      p = c;
      onSpawn = null;
    };
    h.sup.startOrWake?.("document"); // P
    const off = h.sup.updateSettings({ startMode: "off" });
    h.emit(chatEvent()); // Q, behind the Off
    const c2 = await until(() => p, "P's spawn");
    await until(() => c2.killed, "the Off's SIGTERM");
    // P has ended (the Off runs after it on the FIFO lock); Q is queued.
    expect(passes(h)).toBe(1);
    expect(pendingOf(h)).toBe(true);
    c2.releaseExit();
    await off;
    await lockBarrier(h);
    expect(pendingOf(h)).toBeUndefined();
    expect(passes(h)).toBe(2);
    expect(children).toHaveLength(3);
  });

  it("positive twin: with no chat, the same construction does not read as Starting once P has ended", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    let p: FakeChild | null = null;
    onSpawn = (c) => {
      c.holdExit = true;
      p = c;
      onSpawn = null;
    };
    h.sup.startOrWake?.("document");
    const off = h.sup.updateSettings({ startMode: "off" });
    const c2 = await until(() => p, "P's spawn");
    await until(() => c2.killed, "the Off's SIGTERM");
    expect(pendingOf(h)).toBeUndefined();
    c2.releaseExit();
    await off;
  });

  // The two "queued between" cases cannot fail on a single guard term's
  // removal (#2458's table): the chat's pass declines on `standby ===
  // undefined`. The pass's `isAlive()` term has no case of its own since
  // the child re-check in `planAndSpawn` removed the one known state it alone
  // decided ("3b-2b1b-R0, R0.5, closed"); it stays as a defensive re-check.
  describe("between the start-or-wake pass and the chat's (waiting false)", () => {
    it("a relaunch queued between: the chat's pass runs after it and finds the standby cleared: one spawn", async () => {
      const waiting = waitingDouble(false);
      const { h } = await idleStopped({ workWaiting: waiting.fn });
      h.sup.startOrWake?.("document"); // P
      const relaunching = h.sup.relaunch();
      h.emit(chatEvent()); // Q
      await relaunching;
      await lockBarrier(h);
      await settle();
      expect(passes(h)).toBe(2);
      expect(children).toHaveLength(2);
      expect(messageStartLines()).toBe(0);
    });
    it("the user's Start queued between: the Start spawns, and the chat's pass starts nothing (no message-start line)", async () => {
      const waiting = waitingDouble(false);
      const { h } = await idleStopped({ workWaiting: waiting.fn });
      h.sup.startOrWake?.("document"); // P
      const starting = h.sup.startByUser();
      h.emit(chatEvent()); // Q
      await starting;
      await lockBarrier(h);
      await settle();
      expect(passes(h)).toBe(2);
      expect(children).toHaveLength(2);
      expect(messageStartLines()).toBe(0);
    });
    it("positive twin: with nothing between, the chat's pass starts Claude (the message-start line)", async () => {
      const waiting = waitingDouble(false);
      const { h } = await idleStopped({ workWaiting: waiting.fn });
      h.sup.startOrWake?.("document");
      h.emit(chatEvent());
      await lockBarrier(h);
      await childN(2);
      expect(messageStartLines()).toBe(1);
    });
  });

  it("L1: a chat accepted while a declining start-or-wake pass runs gets one more pass, which starts Claude", async () => {
    let onAsk: (() => void) | null = null;
    const waiting = waitingDouble(() => {
      const ask = onAsk;
      onAsk = null;
      ask?.();
      return false;
    });
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    onAsk = () => h.emit(chatEvent()); // once, from P's waiting decision
    h.sup.startOrWake?.("document");
    await lockBarrier(h);
    await childN(2);
    await lockBarrier(h);
    expect(passes(h)).toBe(2);
    expect(children).toHaveLength(2);
  });

  it("L1's twin: the same declining pass with no chat starts nothing", async () => {
    const waiting = waitingDouble(false);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    h.sup.startOrWake?.("document");
    await lockBarrier(h);
    expect(passes(h)).toBe(1);
    expect(children).toHaveLength(1);
  });

  it("a chat inside the start-or-wake pass's respawn: one spawn, and the chat's pass finds the standby cleared", async () => {
    // Q stops at `standby === undefined` (P's spawn cleared it), before
    // `isAlive()` is read: removing `isAlive()` alone fails nothing here;
    // removing the guard does. No known state is decided by `isAlive()` alone
    // since "3b-2b1b-R0, R0.5, closed" below.
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    onSpawn = () => {
      onSpawn = null;
      h.emit(chatEvent()); // the watch is still armed: accepted, Q
    };
    h.sup.startOrWake?.("document");
    const c2 = await childN(2);
    await lockBarrier(h);
    await lockBarrier(h);
    expect(passes(h)).toBe(2);
    expect(children).toHaveLength(2);
    expect(messageStartLines()).toBe(0);
    expect(c2.killed).toBe(false);
    // And Q writes nothing: the one wake is the one owed on P's spawn.
    pushJson(c2, RESULT_OK);
    await settle();
    expect(wakes(c2)).toBe(1);
  });

  it("3b-2b1b-R0, R0.5, closed: the crash restart no longer holds itself beside a live child (planAndSpawn re-checks `child`)", async () => {
    // Since the flip-blocker row "A crash restart can hold itself beside a
    // live child" closed: the sequence below used to leave an
    // `awaiting-start` standby and an armed standby watch beside B. Now the
    // restart sees B after its reads and does not spawn or hold.
    // It was the state the start pass's `isAlive()` re-check alone decided: a
    // standby set while a child is live. A crash
    // restart (unlocked) waits on its settings read; the user's Start is
    // refused by the licence (`respawn` throws before `stopInternal`, so the
    // stop epoch does not move); licence activation spawns B under the lock; a
    // local period begins; the restart resumes past `planAndSpawn`'s epoch and
    // stop re-checks, and (before the fix, which looked at no `child`) held
    // itself, setting `awaiting-start` beside B. The switch back finds B alive and leaves the
    // standby. A chat is then accepted by the standby watch and its pass must
    // decline: without `isAlive()` it stops B and starts a third child.
    //
    // Flag on only (this file's default): the positive anchor that the
    // standby watch accepted the chat is the pass counter, which counts flag
    // on only. Flag off there is no observable that tells the standby
    // watch's acceptance apart: its other effect, an owed wake across spawns,
    // is raised by the gap watch the held restart left armed too, and
    // `messageStartQueued` is not shown while a child runs.
    const lic = licenceDouble();
    const lp = localDouble();
    let holdNextRead = false;
    let readHeld = false;
    let releaseRead = (): void => {};
    const h = makeSupervisor({
      aiRefusal: lic.fn,
      localPeriod: lp.opts,
      readSettings: async () => {
        if (holdNextRead) {
          holdNextRead = false;
          readHeld = true;
          await new Promise<void>((r) => {
            releaseRead = r;
          });
        }
        return {
          source: "default" as const,
          settings: { startMode: "auto" as const, lifetime: "always" as const, idleMinutes: 30 },
        };
      },
    });
    await h.sup.start();
    const c1 = await childN(1);
    await settle();
    holdNextRead = true;
    c1.exitWith(1, null); // a crash: the restart's settings read is held
    await settle();
    advance(1); // the [0] backoff is a (faked) timer
    await until(() => readHeld, "the crash restart's settings read");
    lic.refusing = true;
    await expect(h.sup.startByUser()).rejects.toThrow(); // records the refusal, stops nothing
    lic.refusing = false;
    await h.sup.resumeAfterLicence(); // B, under the lock; the epoch is unchanged
    const b = await childN(2);
    await settle();
    lp.held = true;
    lp.switchTo({ to: "local" });
    releaseRead();
    await until(
      () => /A Claude started while building the spawn plan — not spawning/.test(logText()),
      "the restart's child re-check",
    );
    expect(logText()).not.toMatch(
      /not starting Claude \(crash\) until it is answered by Claude again/,
    );
    expect(children).toHaveLength(2);
    lp.held = false;
    lp.switchTo({ to: "claude", asked: true });
    await settle();
    const before = passes(h);
    h.emit(chatEvent());
    await lockBarrier(h);
    await settle();
    // No standby was set beside B, so the watch is not armed: no pass at all.
    expect(passes(h)).toBe(before);
    expect(messageStartLines()).toBe(0);
    expect(children).toHaveLength(2);
    expect(b.killed).toBe(false);
  });

  it("R3.3: P running, Q queued, then a call: the call joins Q (two passes, two waiting calls)", async () => {
    let onAsk: (() => void) | null = null;
    const waiting = waitingDouble(() => {
      const ask = onAsk;
      onAsk = null;
      ask?.();
      return true;
    });
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    onAsk = () => {
      h.emit(chatEvent()); // Q queued while P runs
      h.sup.startOrWake?.("document"); // a call: joins
    };
    h.sup.startOrWake?.("document"); // P
    const c2 = await childN(2);
    await lockBarrier(h);
    await lockBarrier(h);
    await settle();
    expect(passes(h)).toBe(2);
    expect(waiting.calls).toBe(2); // P's own, then Q's share for the joined call
    expect(queuedLines()).toBe(1);
    expect(children).toHaveLength(2);
    pushJson(c2, RESULT_OK);
    await settle();
    // One wake owed by the chat on P's spawn, one from Q's share for the
    // joined call.
    expect(wakes(c2)).toBe(2);
  });

  it("R3.3: P ended, Q queued, then a call: the call joins Q (two passes, no second queued line)", async () => {
    const waiting = waitingDouble(false);
    let gate: Promise<void> | null = null;
    let entered = false;
    let open!: () => void;
    const { h } = await idleStopped({
      workWaiting: waiting.fn,
      readSettings: async () => {
        if (gate) {
          entered = true;
          await gate;
        }
        return readLauncherSettings(baseDir);
      },
    });
    gate = new Promise<void>((r) => {
      open = r;
    });
    h.sup.startOrWake?.("document"); // 1: P
    const relaunching = h.sup.relaunch(); // 2: paused in its settings read
    h.emit(chatEvent()); // 3: Q
    await until(() => entered, "the relaunch's gated settings read");
    expect(passes(h)).toBe(1); // P has ended; the relaunch holds the lock
    h.sup.startOrWake?.("document"); // 4
    gate = null;
    open(); // 5
    await relaunching;
    await lockBarrier(h);
    await lockBarrier(h);
    expect(passes(h)).toBe(2);
    expect(waiting.calls).toBe(2);
    expect(queuedLines()).toBe(1);
  });

  it("coalescing with Q: a second chat while Q is queued gives one pass and one spawn", async () => {
    const waiting = waitingDouble(false);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    h.sup.startOrWake?.("document"); // P ahead, so Q stays queued
    h.emit(chatEvent()); // Q
    h.emit(chatEvent()); // coalesced into Q
    await lockBarrier(h);
    await childN(2);
    await lockBarrier(h);
    await settle();
    expect(passes(h)).toBe(2); // P and one Q
    expect(children).toHaveLength(2);
  });
});

// --- #2358 PR 3b-2b2: the widened arm ---------------------------------------

describe("3b-2b2: a new user comment or any user thread reply asks start-or-wake", () => {
  function commentEvent(annotationType = "comment", documentId: string | null = "d1") {
    eventSeq++;
    return {
      id: `evt_${eventSeq}`,
      type: "annotation:created",
      timestamp: Date.now(),
      ...(documentId === null ? {} : { documentId }),
      payload: {
        annotationId: `ann_${eventSeq}`,
        annotationType,
        content: "look",
        textSnippet: "x",
      },
    } as TandemEvent;
  }
  function replyEvt(parentAuthor: "user" | "claude", replyAuthor: "user" | "claude" = "user") {
    eventSeq++;
    return {
      id: `evt_${eventSeq}`,
      type: "annotation:reply",
      timestamp: Date.now(),
      documentId: "d1",
      payload: {
        annotationId: `ann_${eventSeq}`,
        replyId: `rep_${eventSeq}`,
        replyText: "and this?",
        replyAuthor,
        textSnippet: "x",
        parentAuthor,
      },
    } as TandemEvent;
  }
  const queuedLines = () =>
    (logText().match(/Start-or-wake queued \(user-annotation\)/g) ?? []).length;

  it("W1: idle-stopped, work waiting, a user comment: one resumed spawn whose first turn is the wake", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    h.emit(commentEvent());
    await lockBarrier(h);
    const c2 = await childN(2);
    await settle();
    expect(children).toHaveLength(2);
    expect(argAfter(c2, "--resume")).toBeDefined();
    expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    expect(queuedLines()).toBe(1);
  });

  it("W2: another AI attached: still one spawn (whether or not another AI is on)", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn, otherAiAttached: () => true });
    h.emit(commentEvent());
    await lockBarrier(h);
    await childN(2);
    await settle();
    expect(children).toHaveLength(2);
  });

  it("W3: nothing waiting for Tandem's Claude (e.g. the comment is on a document another session holds): asked, no spawn", async () => {
    const waiting = waitingDouble(false);
    const { h } = await idleStopped({ workWaiting: waiting.fn, otherAiAttached: () => true });
    h.emit(commentEvent());
    await lockBarrier(h);
    expect(waiting.calls).toBe(1);
    expect(children).toHaveLength(1);
  });

  it("W4: a user reply on the user's own comment (not Claude's thread): one spawn", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    h.emit(replyEvt("user"));
    await lockBarrier(h);
    await childN(2);
    await settle();
    expect(children).toHaveLength(2);
  });

  it("W5: a user reply on Claude's thread with another AI on (today's arm declines): one spawn", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn, otherAiAttached: () => true });
    h.emit(replyEvt("claude"));
    await lockBarrier(h);
    await childN(2);
    await settle();
    expect(children).toHaveLength(2);
  });

  it("W6: not asked for a highlight, a synthetic wake (no document), a Claude reply or a chat beside another AI", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn, otherAiAttached: () => true });
    const seen: number[] = [];
    for (const e of [
      commentEvent("highlight"),
      commentEvent("comment", null),
      replyEvt("user", "claude"),
      chatEvent(),
    ]) {
      h.emit(e);
      await lockBarrier(h);
      seen.push(waiting.calls);
    }
    expect(seen).toEqual([0, 0, 0, 0]);
    expect(waiting.calls).toBe(0);
    expect(queuedLines()).toBe(0);
    expect(children).toHaveLength(1);
  });

  it("W7: Off: nothing asked, no spawn, the mode stays off", async () => {
    const waiting = waitingDouble(true);
    const { h } = await offStopped({ workWaiting: waiting.fn });
    h.emit(commentEvent());
    h.emit(replyEvt("user"));
    await lockBarrier(h);
    expect(waiting.calls).toBe(0);
    expect(children).toHaveLength(1);
    expect(await savedStartMode()).toBe("off");
  });

  it("W8: the licence refuses: nothing asked, no spawn", async () => {
    const lic = licenceDouble();
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn, aiRefusal: lic.fn });
    lic.refusing = true;
    h.emit(commentEvent());
    await lockBarrier(h);
    expect(waiting.calls).toBe(0);
    expect(children).toHaveLength(1);
  });

  it("W9: flag off: a user comment does exactly what master does (nothing)", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn, otherAiAttached: () => true });
    const logged = errSpy.mock.calls.length;
    h.emit(commentEvent());
    h.emit(replyEvt("user"));
    await lockBarrier(h);
    expect(waiting.calls).toBe(0);
    expect(children).toHaveLength(1);
    expect(errSpy.mock.calls.length).toBe(logged);
  });

  it("W10, the presence gate decided: before the first Start (on-click, never started, not present) a waiting comment starts Tandem's Claude ('Yes, even before my first Start')", async () => {
    await updateLauncherSettings(baseDir, { startMode: "on-click" }, null);
    const waiting = waitingDouble(true);
    const h = makeSupervisor({ workWaiting: waiting.fn });
    await h.sup.start();
    await settle();
    expect(children).toHaveLength(0);
    expect(h.sup.status()).toMatchObject({ running: false, standby: "awaiting-start" });
    h.emit(commentEvent());
    await lockBarrier(h);
    await childN(1);
    await settle();
    expect(children).toHaveLength(1);
  });

  it("W11: a burst of comments is one pass and one spawn", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    for (let i = 0; i < 5; i++) h.emit(commentEvent());
    await lockBarrier(h);
    await childN(2);
    await settle();
    expect(children).toHaveLength(2);
    expect(h.seam.diagnosticsForTests().startPasses).toBe(1);
  });
});

describe("the own-spawn seam's reads (#2358 PR 3b-2b3a; wired by index.ts since 3b-2b4a)", () => {
  it("ownSpawn names the live child's spawn and id; a resumed spawn has the same id and a new number; isOwnChildSession folds case", async () => {
    const h = makeSupervisor();
    expect(h.sup.ownSpawn?.()).toBeNull();
    const c1 = await boundFreshRun(h);
    const id = argAfter(c1, "--session-id") as string;
    expect(h.sup.ownSpawn?.()).toEqual({ n: 1, sessionId: id });
    expect(h.sup.isOwnChildSession?.(id.toUpperCase())).toBe(true);
    expect(h.sup.isOwnChildSession?.("someone-else")).toBe(false);
    await crashToResumed(c1);
    expect(h.sup.ownSpawn?.()).toEqual({ n: 2, sessionId: id });
    await h.sup.stop();
    expect(h.sup.ownSpawn?.()).toBeNull();
    expect(h.sup.isOwnChildSession?.(id)).toBe(true);
  });

  it("flag off: no spawn is named", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    await childN(1);
    expect(h.sup.ownSpawn?.()).toBeNull();
  });
});

describe("the spawn-started event and the switch-on as index.ts wires it (#2358 PR 3b-2b4a)", () => {
  let view: TransportViewEntry[];
  beforeEach(() => {
    view = [];
    setTransportView(() => view);
  });
  afterEach(() => {
    resetOwnershipForTests();
    setOpenDocumentIdsSource(() => []);
  });

  /** `index.ts`'s wiring, against this supervisor (3b-2b4b: the run start and both sinks too; 3b-2b5: the failed bind). */
  function wire(h: ReturnType<typeof makeSupervisor>): void {
    setTandemPresenceSource(() => h.sup.tandemPresence?.().isPresent() === true);
    h.seam.subscribe(noteTandemPresence);
    h.seam.onSpawnStarted(noteOwnSpawnStarted);
    h.seam.onRunStart(noteTandemRunStart);
    h.seam.onFailedBind(noteFailedBind);
    setOwnSpawnSource(
      () => h.sup.ownSpawn?.() ?? null,
      (id) => h.sup.isOwnChildSession?.(id) === true,
    );
    setStartOrWakeSink((cause) => h.sup.startOrWake?.(cause));
    setRequestWakeSink(() => h.sup.requestWake?.());
  }

  it("3b-2b4b: a run start with work waiting on a held document wakes the child once, after its first turn", async () => {
    const h = makeSupervisor();
    wire(h);
    setOpenDocumentIdsSource(() => ["doc"]);
    setWaitingProbe((documentId) => documentId === "doc");
    const c1 = await boundFreshRun(h);
    expect(getDocOwner("doc")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    expect(wakes(c1)).toBe(0); // the bootstrap turn is in flight
    pushJson(c1, RESULT_OK);
    await settle();
    expect(wakes(c1)).toBe(1);
    pushJson(c1, RESULT_OK);
    await settle();
    expect(wakes(c1)).toBe(1);
  });

  it("3b-2b4b: the same run start with the licence refusing writes no wake", async () => {
    const lic = licenceDouble();
    const h = makeSupervisor({ aiRefusal: lic.fn });
    wire(h);
    setOpenDocumentIdsSource(() => ["doc"]);
    setWaitingProbe((documentId) => documentId === "doc");
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    lic.refusing = true;
    expect(await bind(c1)).toBe(true);
    pushJson(c1, RESULT_OK);
    await settle();
    expect(wakes(c1)).toBe(0);
  });

  it("3b-2b4b: nothing waiting at the run start, no wake", async () => {
    const h = makeSupervisor();
    wire(h);
    setOpenDocumentIdsSource(() => ["doc"]);
    const c1 = await boundFreshRun(h);
    pushJson(c1, RESULT_OK);
    await settle();
    expect(wakes(c1)).toBe(0);
  });

  it("3b-2b4b: the Solo-release check starts a stopped Tandem's Claude for waiting work", async () => {
    const waiting = waitingDouble(true);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    setStartOrWakeSink((cause) => h.sup.startOrWake?.(cause));
    noteSoloReleased();
    await lockBarrier(h);
    const c2 = await childN(2);
    await settle();
    expect(waiting.calls).toBe(1);
    expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    expect(logText()).toContain("Work is waiting for Tandem's Claude (solo-release)");
  });

  it("3b-2b4b: the Solo-release check while Off, or with nothing waiting, starts nothing", async () => {
    const waiting = waitingDouble(true);
    const { h } = await offStopped({ workWaiting: waiting.fn });
    setStartOrWakeSink((cause) => h.sup.startOrWake?.(cause));
    noteSoloReleased();
    await lockBarrier(h);
    expect(waiting.calls).toBe(0);
    expect(children).toHaveLength(1);
    const idle = waitingDouble(false);
    const { h: h2 } = await idleStopped({ workWaiting: idle.fn });
    setStartOrWakeSink((cause) => h2.sup.startOrWake?.(cause));
    noteSoloReleased();
    await lockBarrier(h2);
    expect(idle.calls).toBe(1);
    expect(children).toHaveLength(2);
  });

  describe("the mode-unknown observer (#2358, the restart question; Bryan: 'Build an observer')", () => {
    // What the CTRL_ROOM observer reports, called as it calls it: the mode
    // read unknown at install (a restart), then a client's first `tandem`.
    // The observer itself is in tests/server/ownership-mode-known.test.ts.
    it("the first Tandem mode after an unknown one starts a stopped Tandem's Claude for waiting work", async () => {
      const waiting = waitingDouble(true);
      const { h } = await idleStopped({ workWaiting: waiting.fn });
      setStartOrWakeSink((cause) => h.sup.startOrWake?.(cause));
      noteModeObserved("indeterminate");
      noteModeObserved("tandem");
      await lockBarrier(h);
      const c2 = await childN(2);
      await settle();
      expect(waiting.calls).toBe(1);
      expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
      expect(logText()).toContain("Work is waiting for Tandem's Claude (mode-known)");
    });

    it("Off drops it, the licence refusing drops it, and nothing waiting starts nothing", async () => {
      const waiting = waitingDouble(true);
      const { h } = await offStopped({ workWaiting: waiting.fn });
      setStartOrWakeSink((cause) => h.sup.startOrWake?.(cause));
      noteModeObserved("indeterminate");
      noteModeObserved("tandem");
      await lockBarrier(h);
      expect(waiting.calls).toBe(0);
      expect(children).toHaveLength(1);

      resetOwnershipForTests();
      const lic = licenceDouble();
      const refused = waitingDouble(true);
      const { h: h2 } = await idleStopped({ workWaiting: refused.fn, aiRefusal: lic.fn });
      lic.refusing = true;
      setStartOrWakeSink((cause) => h2.sup.startOrWake?.(cause));
      noteModeObserved("indeterminate");
      noteModeObserved("tandem");
      await lockBarrier(h2);
      expect(refused.calls).toBe(0);
      expect(children).toHaveLength(2);

      resetOwnershipForTests();
      const idle = waitingDouble(false);
      const { h: h3 } = await idleStopped({ workWaiting: idle.fn });
      setStartOrWakeSink((cause) => h3.sup.startOrWake?.(cause));
      noteModeObserved("indeterminate");
      noteModeObserved("tandem");
      await lockBarrier(h3);
      expect(idle.calls).toBe(1);
      expect(children).toHaveLength(3);
    });
  });

  describe("3b-2b5: the failed-bind wake (ownership design §8.7, R2.5)", () => {
    /**
     * A bound run holds `doc`; it crashes and its resumed spawn (child 2), a
     * stub that never presents its handle, gets a user comment's wake, which
     * starts its bind window. Child 2's stray transport sits on its
     * `unbound-child` record, `spawn:2`, refused on Tandem's Claude's
     * document until the bind fails.
     */
    async function strandedByFailedBind(
      h: ReturnType<typeof makeSupervisor>,
      waitingAtFailure = true,
    ): Promise<FakeChild> {
      wire(h);
      setOpenDocumentIdsSource(() => ["doc"]);
      let waiting = false;
      setWaitingProbe((documentId) => waiting && documentId === "doc");
      const c1 = await boundFreshRun(h);
      expect(getDocOwner("doc")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
      pushJson(c1, RESULT_OK);
      await settle();
      const c2 = await crashToResumed(c1);
      view.push({ ownerId: "spawn:2", sessionId: "m-c2", openStreams: 1 });
      noteTransportRegistered("spawn:2", { recordKind: "unbound-child" });
      expect(checkWrite("doc", "spawn:2")).toMatchObject({ ok: false, reason: "unbound-child" });
      h.emit(annotationEvent()); // its first turn: the window starts
      await settle();
      expect(wakes(c2)).toBe(1);
      pushJson(c2, RESULT_OK); // idle again
      await settle();
      waiting = waitingAtFailure;
      return c2;
    }

    it("the window expires: presence ends, the document goes unowned, and the live unbound child is woken once and may then claim the stranded item", async () => {
      const h = makeSupervisor();
      const c2 = await strandedByFailedBind(h);
      advance(WINDOW);
      await settle();
      expect(h.log.slice(-2)).toEqual(["failed:window-expired", "not-present"]);
      expect(getDocOwner("doc")).toBeUndefined();
      expect(wakes(c2)).toBe(2);
      // The woken child, as its unbound-child record, is no longer blocked.
      expect(checkWrite("doc", "spawn:2")).toEqual({ ok: true, claim: "claimed" });
      await settle();
      expect(wakes(c2)).toBe(2);
    });

    it("the wake is deferred out of the supervisor's emit: nothing is written in the judging site's own turn", async () => {
      const h = makeSupervisor();
      const c2 = await strandedByFailedBind(h);
      let inEmit = -1;
      h.seam.onFailedBind(() => {
        inEmit = wakes(c2);
      });
      advance(WINDOW);
      expect(inEmit).toBe(1);
      await settle();
      expect(wakes(c2)).toBe(2);
    });

    it("the licence refusing: no wake is written", async () => {
      const lic = licenceDouble();
      const h = makeSupervisor({ aiRefusal: lic.fn });
      const c2 = await strandedByFailedBind(h);
      lic.refusing = true;
      advance(WINDOW);
      await settle();
      expect(h.log).toContain("failed:window-expired");
      expect(getDocOwner("doc")).toBeUndefined();
      expect(wakes(c2)).toBe(1);
    });

    it("negative (anchor: the first row): nothing stranded, no wake", async () => {
      const h = makeSupervisor();
      const c2 = await strandedByFailedBind(h, false);
      advance(WINDOW);
      await settle();
      expect(h.log).toContain("failed:window-expired");
      expect(getDocOwner("doc")).toBeUndefined();
      expect(wakes(c2)).toBe(1);
    });

    it("flag off: noteFailedBind wakes nothing, even with work waiting and the sink wired", async () => {
      vi.stubEnv("TANDEM_OWNERSHIP", "");
      let sunk = 0;
      setRequestWakeSink(() => {
        sunk += 1;
      });
      setOpenDocumentIdsSource(() => ["doc"]);
      setWaitingProbe(() => true);
      noteFailedBind();
      await settle();
      expect(sunk).toBe(0);
      expect(logText()).not.toMatch(/ownership/);
    });
  });

  describe("3b-2b5: a holder's lapse beside a running Tandem's Claude (the own-Claude 'another session' row's first test)", () => {
    async function heldByTerminalBesideIdleTandem(
      h: ReturnType<typeof makeSupervisor>,
    ): Promise<FakeChild> {
      wire(h);
      setOpenDocumentIdsSource(() => ["doc"]);
      let waiting = false;
      setWaitingProbe((documentId) => waiting && documentId === "doc");
      const c1 = await boundFreshRun(h);
      pushJson(c1, RESULT_OK);
      await settle();
      // Its bound transport, where rule 0 routes it (3b-2b4a): the built-in
      // `tandem` record, which never counts as another session.
      view.push({ ownerId: TANDEM_OWNER_ID, sessionId: "m-c1", openStreams: 1 });
      view.push({ ownerId: "claude:term-a", openStreams: 1 });
      noteTransportRegistered("claude:term-a", { recordKind: "claude" });
      setDocOwner("doc", { ownerId: "claude:term-a", kind: "opened" }, "take", "claude:term-a");
      waiting = true;
      return c1;
    }

    function lapseTerminal(): void {
      setGraceMsForTests(10);
      view.splice(
        view.findIndex((e) => e.ownerId === "claude:term-a"),
        1,
      );
      noteTransportChanged("claude:term-a");
      advance(10);
    }

    it("with no other session: the document goes to Tandem's Claude and the idle child is woken once", async () => {
      const h = makeSupervisor({ workWaiting: tandemWorkWaiting });
      const c1 = await heldByTerminalBesideIdleTandem(h);
      expect(wakes(c1)).toBe(0);
      lapseTerminal();
      await lockBarrier(h);
      expect(getDocOwner("doc")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
      expect(wakes(c1)).toBe(1);
    });

    it("negative (anchor: the row above): another terminal attached, so the lapse forwards nothing and the child is not woken", async () => {
      const h = makeSupervisor({ workWaiting: tandemWorkWaiting });
      const c1 = await heldByTerminalBesideIdleTandem(h);
      view.push({ ownerId: "claude:term-b", openStreams: 1 });
      noteTransportRegistered("claude:term-b", { recordKind: "claude" });
      lapseTerminal();
      await lockBarrier(h);
      expect(getDocOwner("doc")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
      expect(wakes(c1)).toBe(0);
    });
  });

  it("spawn 1, then a resumed spawn 2 with the same id and a new number", async () => {
    const h = makeSupervisor();
    const seen: Array<{ n: number; sessionId: string }> = [];
    h.seam.onSpawnStarted((s) => seen.push(s));
    const c1 = await boundFreshRun(h);
    const id = argAfter(c1, "--session-id") as string;
    expect(seen).toEqual([{ n: 1, sessionId: id }]);
    await crashToResumed(c1);
    expect(seen).toEqual([
      { n: 1, sessionId: id },
      { n: 2, sessionId: id },
    ]);
  });

  it("wired: presence gives an open document nobody holds to Tandem's Claude, and spawn 2 retires spawn 1's record", async () => {
    const h = makeSupervisor();
    wire(h);
    setOpenDocumentIdsSource(() => ["doc"]);
    const c1 = await boundFreshRun(h);
    expect(getDocOwner("doc")).toMatchObject({ ownerId: TANDEM_OWNER_ID, kind: "default" });
    const stray: TransportViewEntry = { ownerId: "spawn:1", sessionId: "m-stray", openStreams: 0 };
    view.push(stray);
    noteTransportRegistered("spawn:1", { recordKind: "unbound-child" });
    await crashToResumed(c1);
    expect(stray.ownerId).toBe("private:m-stray");
    expect(getDocOwner("doc")?.ownerId).toBe(TANDEM_OWNER_ID);
  });

  it("a throwing spawn-started subscriber is contained: the next one still hears it", async () => {
    const h = makeSupervisor();
    const seen: number[] = [];
    h.seam.onSpawnStarted(() => {
      throw new Error("boom");
    });
    h.seam.onSpawnStarted((s) => seen.push(s.n));
    await boundFreshRun(h);
    expect(seen).toEqual([1]);
    expect(logText()).toMatch(/A spawn-started subscriber threw \(ignored\): Error: boom/);
  });

  it("flag off, wired as index.ts wires it: no event, no presence, nothing created", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const h = makeSupervisor();
    const seen: unknown[] = [];
    h.seam.onSpawnStarted((s) => seen.push(s));
    wire(h);
    setOpenDocumentIdsSource(() => ["doc"]);
    await h.sup.startFresh(cwdDir);
    await childN(1);
    await settle();
    expect(seen).toEqual([]);
    expect(h.log).toEqual([]);
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    expect(ownershipSnapshotForTests().records).toEqual([]);
    expect(ownershipSnapshotForTests().ownerByDoc).toEqual([]);
    expect(logText()).not.toMatch(/ownership|spawn-started/);
  });
});

// --- #2358 PR 3b-2e1: the failed-bind reason in status() -----------------------

describe("3b-2e1: status() reports a failed bind (ownership design §8.7)", () => {
  const bindFailedOf = (sup: Supervisor) => (sup.status() as { bindFailed?: unknown }).bindFailed;

  it("a stub that never binds: absent inside its window, `bindFailed` once judged, on the running arm", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    await childN(1);
    advance(WINDOW - 1);
    await settle();
    expect(h.sup.status().running).toBe(true);
    expect(bindFailedOf(h.sup)).toBeUndefined();
    advance(1);
    await settle();
    expect(h.log).toEqual(["failed:window-expired"]);
    expect(h.sup.status()).toMatchObject({ running: true, bindFailed: true });
  });

  it("a bound run reports nothing, before or after a crash-resume", async () => {
    const h = makeSupervisor();
    const c1 = await boundFreshRun(h);
    expect("bindFailed" in h.sup.status()).toBe(false);
    const c2 = await crashToResumed(c1);
    expect(await bind(c2)).toBe(true);
    expect("bindFailed" in h.sup.status()).toBe(false);
  });

  it("a late bind after the judgement is a run start, and clears it", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    const creds = credentialsOf(c1);
    advance(WINDOW);
    await settle();
    expect(bindFailedOf(h.sup)).toBe(true);
    expect(await bind(c1, creds)).toBe(true);
    expect(bindFailedOf(h.sup)).toBeUndefined();
  });

  it("a crash of an unbound spawn (site a) reports it, and it outlasts Off on the stopped arm, beside `standby`", async () => {
    const h = makeSupervisor({ resumeConfirmMs: WINDOW / 10 });
    const c2 = await crashToResumed(await boundFreshRun(h));
    advance(WINDOW / 10);
    h.emit(annotationEvent());
    advance(WINDOW / 10);
    c2.exitWith(1, null);
    await settle();
    expect(h.log).toContain("failed:torn-down-unbound");
    await h.sup.updateSettings({ startMode: "off" });
    await until(() => !h.sup.status().running, "Off's stop");
    expect(h.sup.status()).toMatchObject({ running: false, standby: "off", bindFailed: true });
  });

  it("a `lastError` outranks it on the stopped arm, as it outranks `standby`", async () => {
    let command: string | null = process.execPath;
    const h = makeSupervisor({ resolveClaudeCommand: () => command });
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    advance(WINDOW);
    await settle();
    expect(bindFailedOf(h.sup)).toBe(true);
    command = null; // the crash restart finds no Claude Code to start
    c1.exitWith(1, null);
    await settle();
    advance(1);
    await until(() => h.sup.status().lastError === "cli-unusable", "cli-unusable");
    expect("bindFailed" in h.sup.status()).toBe(false);
    command = process.execPath; // the lapse: the error clears, the reason shows again
    expect(h.sup.status()).toMatchObject({ running: false, bindFailed: true });
  });

  it("flag off: a stub that never binds reports nothing, and a judgement made flag on is not reported once it is off", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const dark = makeSupervisor();
    await dark.sup.startFresh(cwdDir);
    await childN(1);
    advance(WINDOW * 2);
    await settle();
    expect("bindFailed" in dark.sup.status()).toBe(false);
    await dark.sup.stop();

    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    await childN(2);
    advance(WINDOW);
    await settle();
    expect(bindFailedOf(h.sup)).toBe(true);
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    expect("bindFailed" in h.sup.status()).toBe(false);
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
  });
});

describe("3b-2e2: wokenAt, for the stall banner's hide (the owner's 2026-11-17 answer 3)", () => {
  /** Spin on real `Date.now()` until it has moved past `t`, so two reads of
   * the clock taken either side of this cannot be equal. No timer: the file
   * fakes `setTimeout`, and `Date` stays real. */
  function pastMs(t: number): number {
    while (Date.now() <= t + 1) {
      // busy wait, a couple of milliseconds at most
    }
    return Date.now();
  }

  it("reads the bootstrap turn's write time while it runs, and null once its result lands", async () => {
    const h = makeSupervisor();
    const before = Date.now();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    const after = Date.now();
    const at = h.sup.wokenAt?.();
    expect(typeof at).toBe("number");
    expect(at as number).toBeGreaterThanOrEqual(before);
    expect(at as number).toBeLessThanOrEqual(after);
    // The same value on a later read: the write time, not the read time.
    pastMs(after);
    expect(h.sup.wokenAt?.()).toBe(at);
    pushJson(c1, RESULT_OK);
    await settle();
    const status = h.sup.status();
    expect(status.running && status.busy).toBe(false);
    expect(h.sup.wokenAt?.()).toBeNull();
  });

  it("a wake written to an idle child reads its own write time", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    pushJson(c1, RESULT_OK);
    await settle();
    expect(h.sup.wokenAt?.()).toBeNull();
    const before = pastMs(Date.now());
    h.emit(annotationEvent());
    expect(c1.stdin.writes.at(-1)).toContain(SUPERVISOR_WAKE_PROMPT);
    const at = h.sup.wokenAt?.() as number;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it("a wake queued behind the turn in flight reads as woken now, not at that turn's write", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    await childN(1);
    const bootstrapAt = h.sup.wokenAt?.() as number;
    const before = pastMs(bootstrapAt);
    // Mid-bootstrap: the event can only queue its wake behind the turn.
    h.emit(annotationEvent());
    const at = h.sup.wokenAt?.() as number;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeGreaterThan(bootstrapAt);
  });

  it("null once the turn in flight has run as long as the stall threshold, even with a wake queued behind it", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    await childN(1);
    const bootstrapAt = h.sup.wokenAt?.() as number;
    h.emit(annotationEvent());
    expect(h.sup.wokenAt?.()).not.toBeNull();
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(bootstrapAt + DELIVERY_STALL_MS - 1);
      expect(h.sup.wokenAt?.()).toBe(bootstrapAt + DELIVERY_STALL_MS - 1);
      nowSpy.mockReturnValue(bootstrapAt + DELIVERY_STALL_MS);
      expect(h.sup.wokenAt?.()).toBeNull();
      // Another message meanwhile does not bring the hide back.
      h.emit(annotationEvent());
      expect(h.sup.wokenAt?.()).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("null with no child, and null once the child is gone", async () => {
    const h = makeSupervisor();
    expect(h.sup.wokenAt?.()).toBeNull();
    await h.sup.startFresh(cwdDir);
    await childN(1);
    expect(h.sup.wokenAt?.()).not.toBeNull();
    await h.sup.stop();
    await settle();
    expect(h.sup.wokenAt?.()).toBeNull();
  });

  it("flag off: null, even while a turn is in flight", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    await childN(1);
    const status = h.sup.status();
    expect(status.running && status.busy).toBe(true);
    expect(h.sup.wokenAt?.()).toBeNull();
  });
});

describe("the published state's launcher facts (#2358 PR 5a-3)", () => {
  it("a bound run: running, nothing pending, startable; each change is told after presence", async () => {
    const h = makeSupervisor();
    const told: string[] = [];
    h.seam.onFactsChanged(() => told.push(h.seam.isPresent() ? "present" : "not-present"));
    await boundFreshRun(h);
    await settle();
    expect(h.seam.launcherFacts()).toEqual({
      running: true,
      startPending: false,
      off: false,
      notSetUp: false,
      stayingDown: false,
      bindFailed: false,
      startable: true,
    });
    // Told at least once, and the last notice already reads presence as announced.
    expect(told.length).toBeGreaterThan(0);
    expect(told.at(-1)).toBe("present");
  });

  it("Off: off, not running, still startable", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    expect(h.seam.launcherFacts()).toMatchObject({ off: true, running: false, startable: true });
  });

  it("no integration configured: not set up, not startable", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
    await writeIntegration(false);
    await h.sup.refreshConfigured();
    await settle();
    expect(h.seam.launcherFacts()).toMatchObject({ notSetUp: true, startable: false });
  });

  it("a failed bind: bindFailed, not startable", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    await childN(1);
    advance(WINDOW);
    await settle();
    expect(h.log).toEqual(["failed:window-expired"]);
    expect(h.seam.launcherFacts()).toMatchObject({ bindFailed: true, startable: false });
  });

  it("a crash with a restart scheduled: a start is pending, not staying down", async () => {
    const h = makeSupervisor({ restartBackoffsMs: [1e9] });
    const c1 = await boundFreshRun(h);
    c1.exitWith(1, null);
    await settle();
    expect(h.seam.launcherFacts()).toMatchObject({
      running: false,
      startPending: true,
      stayingDown: false,
    });
  });

  it("flag off: null, and nothing is told", async () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const h = makeSupervisor();
    const told: number[] = [];
    h.seam.onFactsChanged(() => told.push(1));
    await h.sup.startFresh(cwdDir);
    await childN(1);
    await settle();
    expect(h.seam.launcherFacts()).toBeNull();
    expect(told).toEqual([]);
  });
});
