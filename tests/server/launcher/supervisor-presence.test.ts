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
import { updateLauncherSettings } from "../../../src/server/launcher/settings.js";
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
let reaperPath: string | undefined;

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
  reaperPath = process.execPath;
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
    subscribeDuringStandby: sub,
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

  it("idle-stop: not judged", async () => {
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
    const h = makeSupervisor();
    const c1 = await boundFreshRun(h);
    c1.emit("error", EPIPE()); // not ENOENT: spawn-failed, a restart scheduled
    await settle();
    await writeIntegration(false); // the restart's plan finds nothing
    advance(1); // the restart timer fires; planAndSpawn returns early
    await until(() => logText().includes("No claude-code integration"), "the early return");
    await settle();
    expect(h.log).toEqual(["present", "run-start"]);
    advance(SETTLE);
    await settle();
    expect(h.log).toEqual(["present", "run-start", "not-present"]);
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
    reaperPath = undefined;
    await expect(h.sup.relaunch()).rejects.toThrow();
    expect(h.sup.status().lastError).toBe("binary-not-found");
    void reaperPath;
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
  it("stop() from present: nothing announced, no settle timer pending", async () => {
    const h = makeSupervisor();
    await boundFreshRun(h);
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
    await h.sup.stop();
    c1.emit("error", ENOENT()); // a late error trips the breaker (superseded: ignored)
    // Trip it on a live path instead: a start whose child errors ENOENT.
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

  it("once stop() has begun: a bind landing before shutdown's kill emits no run-start event", async () => {
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    const creds = credentialsOf(c1);
    c1.holdExit = true;
    const stopping = h.sup.stop();
    expect(await bind(c1, creds)).toBe(true);
    c1.releaseExit();
    await stopping;
    await settle();
    expect(h.log).toEqual([]);
  });
});

describe("R2.7: the live standby read", () => {
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

describe("the dark requirement: flag off, nothing", () => {
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
