/**
 * Tandem's Claude's run state in the supervisor (#2358 PR 3b-1, ships dark):
 * the spawn record, the bind window and the failed-bind judgement (R1), and
 * presence with its announcements (R2). Computed, consumed by nothing yet.
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
    c2.releaseExit(1); // the #1169 shape: resuming, code 1, unconfirmed
    await settle();
    await h.sup.updateSettings({ startMode: "off" });
    await settle();
    expect(h.log.filter((e) => e.startsWith("failed:"))).toEqual([]);
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

  it("no child: nothing written", async () => {
    // Only "nothing written" can fail here: the next spawn is fresh, and a
    // fresh spawn's bootstrap clears any owed wake, so "the next spawn writes
    // no wake on its account" is asserted on the Off-released sibling below,
    // whose next spawn resumes.
    const h = makeSupervisor();
    h.sup.requestWake?.();
    expect(children).toHaveLength(0);
    const c1 = await runningIdle(h);
    expect(turnTexts(c1)).toHaveLength(1); // the bootstrap only
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
    inOffWait?: (c2: FakeChild) => void,
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
    inOffWait?.(c2);
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

  describe("H4: a chat accepted from Off joins the queued pass", () => {
    async function h4(otherAiAtPass: boolean) {
      const order: string[] = [];
      let otherAi = false;
      const waiting = waitingDouble(() => {
        order.push("pass");
        return true;
      });
      const h = makeSupervisor({ workWaiting: waiting.fn, otherAiAttached: () => otherAi });
      await runningIdle(h);
      await offAhead(h, order, () => {
        const st = h.sup.status();
        if (!st.running && st.standby === "off") order.push("standby-off");
        const before = pendingOf(h);
        h.emit(chatEvent());
        order.push("chat");
        // Accepted: it marked the queued pass owed by today's arm.
        expect(before).toBeUndefined();
        expect(pendingOf(h)).toBe(true);
        onSpawn = () => order.push("spawn");
        otherAi = otherAiAtPass;
      });
      return { h, order };
    }
    it("no other AI at the pass: one spawn, mode saved on-click", async () => {
      const { order } = await h4(false);
      await childN(3);
      expect(order.slice(0, 4)).toEqual(["relaunch", "off", "standby-off", "chat"]);
      expect(order).toContain("spawn");
      expect(order.indexOf("spawn")).toBeGreaterThan(order.indexOf("chat"));
      expect(children).toHaveLength(3);
      expect(await savedStartMode()).toBe("on-click");
    });
    it("another AI at the pass: no spawn, mode still Off (start-or-wake did not carry it)", async () => {
      const { order } = await h4(true);
      expect(order).toEqual(["relaunch", "off", "standby-off", "chat", "pass"]);
      expect(children).toHaveLength(2);
      expect(await savedStartMode()).toBe("off");
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

    it("a tripped breaker (standby unset, no restart timer): nothing", async () => {
      const waiting = waitingDouble(true);
      const h = makeSupervisor({ workWaiting: waiting.fn });
      await tripBreaker(h, await runningIdle(h));
      const n = children.length;
      h.sup.startOrWake?.("document");
      await lockBarrier(h);
      expect(children).toHaveLength(n);
      // Nothing owed: the user's Start (which resets the breaker) writes no
      // wake (it may be fresh — the crash loop can drop the saved session).
      await h.sup.startByUser();
      const next = await childN(n + 1);
      await settle();
      expect(wakes(next)).toBe(0);
    });

    it("a tripped breaker with a standby set (trip, Off, mode on): no spawn", async () => {
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
    });

    it("positive twin: the same after the user's Start has reset the breaker: one spawn", async () => {
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
    });
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

    it("a chat during a pass whose respawn answers cli-unusable: no second attempt", async () => {
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
      h.emit(chatEvent()); // the watch is still armed: accepted, joins
      // Accepted: the watch reached its last check (see H2).
      expect(otherAiCalls - before).toBe(1);
      gate = null;
      open();
      await lockBarrier(h);
      await lockBarrier(h);
      expect(h.seam.diagnosticsForTests().startPasses).toBe(1);
      expect(resolves).toBe(1);
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

  it("a chat that finds a start-or-wake pass queued joins it: no second pass", async () => {
    const waiting = waitingDouble(false);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    h.sup.startOrWake?.("document");
    h.emit(chatEvent()); // accepted: joins the queued pass, which today's arm now owes
    await lockBarrier(h);
    await childN(2);
    await lockBarrier(h);
    expect(h.seam.diagnosticsForTests().startPasses).toBe(1);
    expect(waiting.calls).toBe(0); // today's arm started it; start-or-wake's share did not run
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
    it("a start-or-wake-only pass does not read as Starting; a chat joining it does, at once", async () => {
      const waiting = waitingDouble(true);
      const { h } = await idleStopped({ workWaiting: waiting.fn });
      h.sup.startOrWake?.("document");
      expect(pendingOf(h)).toBeUndefined();
      h.emit(chatEvent());
      expect(pendingOf(h)).toBe(true);
      await lockBarrier(h);
      expect(h.seam.diagnosticsForTests().startPasses).toBe(1);
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
      expect(logText()).toMatch(/not starting Claude \(message\)/);
    });

    it("positive twin: no local period, something waiting, no child: one spawn", async () => {
      const lp = localDouble();
      const waiting = waitingDouble(true);
      const { h } = await idleStopped({ workWaiting: waiting.fn, localPeriod: lp.opts });
      h.sup.startOrWake?.("document");
      await lockBarrier(h);
      await childN(2);
      expect(logText()).not.toMatch(/not starting Claude \(message\)/);
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

  it("Accepted (concurrency review M2): a chat that joins a start-or-wake pass queued ahead of an Off is started by that pass, then the Off stops it", async () => {
    const waiting = waitingDouble(false);
    const { h } = await idleStopped({ workWaiting: waiting.fn });
    h.sup.startOrWake?.("document"); // pass P queued
    const off = h.sup.updateSettings({ startMode: "off" }); // behind P
    h.emit(chatEvent()); // standby still idle: accepted, joins P
    await off;
    await lockBarrier(h);
    expect(children).toHaveLength(2); // P started Claude; the Off stopped it
    expect(children[1].killed).toBe(true);
    expect(await savedStartMode()).toBe("off");
    expect(h.sup.status()).toMatchObject({ running: false, standby: "off" });
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
