/**
 * The launcher supervisor and the local period (#1123, part A2: R4, R5). Uses
 * the same fake-spawn harness as `supervisor-turn-delivery.test.ts` (copied:
 * a `vi.mock` of `node:child_process` is file-scoped), plus a fake
 * `localPeriod` seam whose `held()` is guard 1 and whose `subscribe` delivers
 * the switches.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  // Spread the original: on win32 `integrations/storage.ts` → `acl-win.ts`
  // imports `execFile`, and a bare `{ spawn }` factory would strip it.
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import {
  _pushEventForTests,
  emitAnswererReturnWake,
  resetForTesting as resetQueue,
  subscribe,
  unsubscribe,
} from "../../../src/server/events/queue.js";
import type { TandemEvent } from "../../../src/server/events/types.js";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import { createSupervisor, type Supervisor } from "../../../src/server/launcher/supervisor.js";
import type { AiRefusal } from "../../../src/server/license/ai-refusal.js";
import {
  __resetChatAnswererForTests,
  primeChatAnswerer,
  setChatAnswerer,
} from "../../../src/server/models/chat-answerer.js";
import {
  __flushLocalModelAnnouncedForTests,
  __resetLocalModelAnnouncedForTests,
} from "../../../src/server/models/local-model-announced.js";
import { primeLocalModelSettings } from "../../../src/server/models/local-model-settings.js";
import {
  __resetLocalPeriodForTests,
  __setHonourLocalPeriodRecordsForTests,
  inLocalPeriod,
  installLocalPeriod,
  subscribeLocalPeriod,
} from "../../../src/server/models/local-period.js";
import {
  SUPERVISOR_GREETING_PROMPT,
  SUPERVISOR_INITIAL_PROMPT,
  SUPERVISOR_WAKE_PROMPT,
} from "../../../src/shared/launcher/contract.js";
import { setCtrlMode } from "../../helpers/ctrl-mode.js";

// --- Fake child -------------------------------------------------------------

type WriteCb = (err?: Error | null) => void;

interface HeldWrite {
  data: string;
  cb?: WriteCb;
  settled: boolean;
}

class FakeStdin extends EventEmitter {
  writable = true;
  writes: HeldWrite[] = [];
  write(data: string, cb?: WriteCb): boolean {
    this.writes.push({ data, cb, settled: false });
    return true;
  }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kills: string[] = [];
  readonly stdin = new FakeStdin();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly pid: number) {
    super();
  }
  kill(sig: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(sig);
    this.killed = true;
    setImmediate(() => {
      if (this.exitCode !== null || this.signalCode !== null) return;
      this.signalCode = sig;
      this.emit("exit", null, sig);
    });
    return true;
  }
}

/** A crash the supervisor did not cause. */
function exitChild(child: FakeChild, code: number | null, signal: NodeJS.Signals | null = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
}

/** The text of each user turn written to this child, in order. */
function texts(child: FakeChild): string[] {
  return child.stdin.writes.map(
    (w) =>
      (JSON.parse(w.data) as { message: { content: { text: string }[] } }).message.content[0].text,
  );
}

function pushLine(child: FakeChild, line: string): void {
  child.stdout.write(`${line}\n`);
}

function pushJson(child: FakeChild, obj: Record<string, unknown>): void {
  pushLine(child, JSON.stringify(obj));
}

const RESULT_OK = { type: "result", subtype: "success", is_error: false, result: "done" };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Long enough for a start that WOULD happen to have spawned: every queued
 *  start reads settings and the integrations file before it spawns. */
async function quiet(): Promise<void> {
  await sleep(300);
  await settle(5);
}

async function settle(n = 3): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, ms = 3_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(5);
  }
}

let eventSeq = 0;
function annotationEvent(): TandemEvent {
  eventSeq++;
  return {
    id: `evt_${eventSeq}`,
    type: "annotation:created",
    timestamp: Date.now(),
    documentId: "d1",
    payload: { annotationId: `ann_${eventSeq}`, content: "look at this", textSnippet: "x" },
  } as TandemEvent;
}

// --- Environment --------------------------------------------------------------

const ENV_KEYS = ["TANDEM_REAPER_PATH", "TANDEM_TAURI_SIDECAR", "NODE_ENV"] as const;
const savedEnv: Record<string, string | undefined> = {};

let baseDir: string;
let cwdDir: string;
let children: FakeChild[];
/** Runs inside the `spawn` mock, after the child exists and before it is
 * returned to the supervisor. */
let onSpawn: ((child: FakeChild, index: number) => void) | null;
let sups: Supervisor[];
let errSpy: MockInstance<typeof console.error>;

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.NODE_ENV = "test";
  delete process.env.TANDEM_TAURI_SIDECAR;
  process.env.TANDEM_REAPER_PATH = process.execPath;

  baseDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tandem-")));
  cwdDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tandem-")));
  children = [];
  onSpawn = null;
  sups = [];
  let pid = 40_000;
  vi.mocked(spawn).mockClear();
  vi.mocked(spawn).mockImplementation(() => {
    const child = new FakeChild(pid++);
    children.push(child);
    onSpawn?.(child, children.length - 1);
    setImmediate(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const file: IntegrationsFile = {
    schemaVersion: 3,
    integrations: [
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
    ],
  };
  await createIntegrationsStore(baseDir).write(file);
});

afterEach(async () => {
  for (const sup of sups) await sup.stop();
  errSpy.mockRestore();
  vi.useRealTimers();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const dir of [baseDir, cwdDir]) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

type ExtraOpts = Omit<
  Parameters<typeof createSupervisor>[0],
  "integrationsBase" | "subscribeToEvents" | "subscribeDuringGap" | "subscribeDuringStandby"
>;

function makeSupervisor(extra: ExtraOpts = {}): {
  sup: Supervisor;
  emit: (e: TandemEvent) => void;
} {
  const callbacks = new Set<(event: TandemEvent) => void>();
  const sup = createSupervisor({
    probeCliUsable: () => true,
    // Spawn is mocked; the command only has to resolve (#2199), whatever the
    // host has installed.
    resolveClaudeCommand: () => process.execPath,
    restartBackoffsMs: [0],
    // The spawn cwd is home-confined (#1822 item 4a), and the fixture's cwd is
    // a temp dir: inside home on Windows, outside it (`/tmp`) on ubuntu.
    // Treating the temp root as home keeps the fixture meaning the same on both.
    homeOverride: fs.realpathSync(os.tmpdir()),
    ...extra,
    integrationsBase: baseDir,
    subscribeToEvents: (cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    // The same fake fan-out, so an event emitted in a gap reaches the watch
    // exactly as the queue would deliver it.
    subscribeDuringGap: (cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
    // And the standby watch (#2196), so a chat emitted in standby starts
    // Claude exactly as the real queue would.
    subscribeDuringStandby: (cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
  });
  sups.push(sup);
  return {
    sup,
    emit: (event) => {
      for (const cb of [...callbacks]) cb(event);
    },
  };
}

async function nthChild(n: number): Promise<FakeChild> {
  return waitFor(() => children.length >= n && children[n - 1], `child ${n} to spawn`);
}

// --- The local period ---------------------------------------------------------

type Change = { to: "local" } | { to: "claude"; asked: boolean };

function localPeriodSeam(initiallyHeld = false) {
  let held = initiallyHeld;
  const cbs = new Set<(c: Change) => void>();
  return {
    seam: {
      held: () => held,
      subscribe: (cb: (c: Change) => void) => {
        cbs.add(cb);
        return () => cbs.delete(cb);
      },
    },
    toLocal() {
      held = true;
      for (const cb of [...cbs]) cb({ to: "local" });
    },
    toClaude(asked: boolean) {
      held = false;
      for (const cb of [...cbs]) cb({ to: "claude", asked });
    },
  };
}

const settingsOf = (startMode: "auto" | "on-click" | "off") => async () => ({
  source: "default" as const,
  settings: { startMode, lifetime: "always" as const, idleMinutes: 30 },
});

function chatEvent(): TandemEvent {
  eventSeq++;
  return {
    id: `evt_${eventSeq}`,
    type: "chat:message",
    timestamp: Date.now(),
    payload: { messageId: `m${eventSeq}`, text: "hi" },
  } as TandemEvent;
}

describe("#1123 A2 — no automatic start during the local period (R4.1)", () => {
  it("boot in auto is held, says so (R4.5), and starts at the user's switch back with one first turn (R5.1)", async () => {
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("auto") });
    await sup.start();
    await settle();
    expect(children).toHaveLength(0);
    const status = sup.status();
    expect(status).toMatchObject({ running: false, heldForLocalModel: true });
    expect((status as { startsOnMessage?: true }).startsOnMessage).toBeUndefined();
    lp.toClaude(true);
    const child = await nthChild(1);
    await settle();
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    expect((sup.status() as { heldForLocalModel?: true }).heldForLocalModel).toBeUndefined();
  });

  it("an unasked switch back starts nothing; the held boot waits in awaiting-start, and the next chat starts Claude", async () => {
    const lp = localPeriodSeam(true);
    const { sup, emit } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: settingsOf("auto"),
    });
    await sup.start();
    await settle();
    lp.toClaude(false);
    await quiet();
    expect(children).toHaveLength(0);
    expect(sup.status()).toMatchObject({
      running: false,
      standby: "awaiting-start",
      startsOnMessage: true,
    });
    emit(chatEvent());
    const child = await nthChild(1);
    await settle();
    expect(texts(child).length).toBe(1);
  });

  it("on-click: no boot start, and the user's switch back starts nothing", async () => {
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("on-click") });
    await sup.start();
    lp.toClaude(true);
    await quiet();
    expect(children).toHaveLength(0);
  });

  it("a crash during the local period is not restarted until the user's switch back, in on-click too", async () => {
    const lp = localPeriodSeam(false);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("on-click") });
    await sup.startByUser();
    const child1 = await nthChild(1);
    lp.toLocal();
    exitChild(child1, 1);
    await waitFor(
      () => (sup.status() as { heldForLocalModel?: true }).heldForLocalModel,
      "the crash restart to be held",
    );
    expect(children).toHaveLength(1);
    expect(sup.status()).toMatchObject({ running: false, heldForLocalModel: true });
    lp.toClaude(true);
    await nthChild(2);
  });

  it("Off: the user's switch back starts nothing", async () => {
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("off") });
    await sup.start();
    lp.toClaude(true);
    await quiet();
    expect(children).toHaveLength(0);
    expect((sup.status() as { heldForLocalModel?: true }).heldForLocalModel).toBeUndefined();
  });

  it("the user's Start during the local period is honoured: a fresh spawn writes the bootstrap turn and no greeting (R4.4)", async () => {
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: settingsOf("on-click"),
      greeting: { isOwed: () => true, markDone: async () => {} },
    });
    await sup.start();
    await sup.startByUser();
    const child = await nthChild(1);
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    expect(sup.status()).toMatchObject({ running: true, heldForLocalModel: true });
    lp.toClaude(false);
    expect((sup.status() as { heldForLocalModel?: true }).heldForLocalModel).toBeUndefined();
  });
});

describe("#1123 A2 — diff review B1/B2", () => {
  it("B1: a switch back immediately undone keeps the held start for the next switch back", async () => {
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("auto") });
    await sup.start();
    await settle();
    lp.toClaude(true);
    lp.toLocal(); // before the switch back's locked body runs
    await quiet();
    expect(children).toHaveLength(0);
    expect(sup.status()).toMatchObject({ running: false, heldForLocalModel: true });
    lp.toClaude(true);
    await nthChild(1);
  });

  it("B2: a held start is not reported, and does not run, once the user turns Claude off", async () => {
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("auto") });
    await sup.start();
    await settle();
    await sup.updateSettings({ startMode: "off" });
    const status = sup.status() as { heldForLocalModel?: true; standby?: string };
    expect(status.standby).toBe("off");
    expect(status.heldForLocalModel).toBeUndefined();
    lp.toClaude(true);
    await quiet();
    expect(children).toHaveLength(0);
  });
});

describe("#1123 A2 — a running Claude (R4.2, R5.1)", () => {
  it("a wake owed at the switch is cleared; nothing wakes it during the period; the user's switch back's wake is its one wake", async () => {
    const lp = localPeriodSeam(false);
    const { sup, emit } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: settingsOf("on-click"),
    });
    await sup.startFresh(cwdDir);
    const child = children[0];
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    // A turn in flight, and an event while it runs: a wake is pending.
    emit(annotationEvent());
    lp.toLocal();
    // The turn in flight finishes (decision 9): no wake follows it.
    pushJson(child, RESULT_OK);
    await settle();
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    lp.toClaude(true);
    // The switch-back wake arrives through the push path.
    emit(annotationEvent());
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT, SUPERVISOR_WAKE_PROMPT]);
  });

  it("a running Claude's switch back owes nothing to a later spawn: a relaunch afterwards writes no extra wake", async () => {
    const lp = localPeriodSeam(false);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("on-click") });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, RESULT_OK);
    await settle();
    lp.toLocal();
    lp.toClaude(true);
    await sup.relaunch(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([]);
  });

  it("an unasked switch back clears a wake the supervisor raised itself during the period", async () => {
    const lp = localPeriodSeam(false);
    const { sup, emit } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: settingsOf("on-click"),
    });
    await sup.startFresh(cwdDir);
    const child = children[0];
    lp.toLocal();
    emit(annotationEvent()); // reaches the fake fan-out only in this harness
    lp.toClaude(false);
    pushJson(child, RESULT_OK);
    await settle();
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
  });

  it("the greeting stays owed during the local period and fires at a later spawn (R4.3)", async () => {
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: settingsOf("on-click"),
      greeting: { isOwed: () => true, markDone: async () => {} },
    });
    await sup.startFresh(cwdDir);
    expect(texts(children[0])).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    lp.toClaude(false);
    await sup.startFresh(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_GREETING_PROMPT]);
  });
});

// --- Review round 1 (items 5, 6, 13, 14, 15) ----------------------------------

const INIT = { type: "system", subtype: "init" };
const NOT_SIGNED_IN = {
  type: "result",
  subtype: "success",
  is_error: true,
  result: "Not logged in · Please run /login",
  terminal_reason: "api_error",
};
const REFUSED: AiRefusal = {
  error: "LICENSE_REQUIRED",
  kind: "unlicensed",
  message: "unlicensed",
} as unknown as AiRefusal;

function writeSettings(settings: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(baseDir, "launcher-settings.json"),
    JSON.stringify({ version: 1, ...settings }),
  );
}

describe("#1123 A2 — each held start kind runs at the user's switch back (R5.1, test each)", () => {
  it("a held licence resume", async () => {
    writeSettings({ startMode: "auto", lifetime: "always", idleMinutes: 30 });
    let refused = true;
    const lp = localPeriodSeam(false);
    const { sup } = makeSupervisor({
      localPeriod: lp.seam,
      aiRefusal: () => (refused ? REFUSED : null),
    });
    await sup.start(); // refused: recorded for the licence resume
    expect(children).toHaveLength(0);
    lp.toLocal();
    refused = false;
    await sup.resumeAfterLicence(); // held by the local period
    expect(children).toHaveLength(0);
    expect(sup.status()).toMatchObject({ running: false, heldForLocalModel: true });
    lp.toClaude(true);
    await nthChild(1);
  });

  it("a held message start", async () => {
    writeSettings({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    const lp = localPeriodSeam(true);
    const { sup, emit } = makeSupervisor({ localPeriod: lp.seam });
    await sup.start();
    // A chat that reached the standby watch before the switch, its start
    // running after it (this harness's fan-out has no forward gate).
    emit(chatEvent());
    // Wait for the start itself to finish (in on-click the field is already
    // true for the standby, so it cannot say the start was held).
    await waitFor(
      () => !(sup.status() as { restartPending?: true }).restartPending,
      "the message start to be held",
    );
    await quiet();
    expect(children).toHaveLength(0);
    lp.toClaude(true);
    await nthChild(1);
  });

  it("round-2 item 9: a held message start is held before anything is stopped or resolved — Claude Code is not even looked up until the switch back", async () => {
    writeSettings({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    const lp = localPeriodSeam(true);
    let lookups = 0;
    const { sup, emit } = makeSupervisor({
      localPeriod: lp.seam,
      resolveClaudeCommand: () => {
        lookups += 1;
        return process.execPath;
      },
    });
    await sup.start();
    const before = lookups;
    emit(chatEvent());
    await waitFor(
      () => !(sup.status() as { restartPending?: true }).restartPending,
      "the message start to be held",
    );
    await quiet();
    expect(children).toHaveLength(0);
    // `stopAndSpawn` looks Claude Code up right after `stopInternal()`: a
    // hold placed after that point would have looked it up.
    expect(lookups).toBe(before);
    // The positive twin: the held start runs at the switch back, and does.
    lp.toClaude(true);
    await nthChild(1);
    expect(lookups).toBeGreaterThan(before);
  });

  it("a held message start from Off leaves Off as it was: still off, mode unsaved, nothing owed to a later resumed spawn (item 15)", async () => {
    writeSettings({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    const lp = localPeriodSeam(false);
    const { sup, emit } = makeSupervisor({ localPeriod: lp.seam });
    await sup.start();
    await sup.startByUser();
    const child1 = await nthChild(1);
    pushJson(child1, RESULT_OK);
    await settle();
    await sup.updateSettings({ startMode: "off" });
    lp.toLocal();
    emit(chatEvent()); // its message start is held
    await waitFor(
      () => !(sup.status() as { restartPending?: true }).restartPending,
      "the message start to finish",
    );
    expect(children).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(baseDir, "launcher-settings.json"), "utf8")).startMode,
    ).toBe("off");
    lp.toClaude(false);
    emit(annotationEvent()); // while Off: owed to nobody
    await sup.startByUser();
    const child2 = await nthChild(2);
    expect(texts(child2), JSON.stringify(texts(child2))).toEqual([]); // resumed, with nothing owed
  });
});

describe("#1123 A2 — resumed spawns and idle stops (R4.4, R5.1)", () => {
  it("a crash restart held through the period resumes at the switch back with the wake prompt as its first turn", async () => {
    writeSettings({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    const lp = localPeriodSeam(false);
    const { sup } = makeSupervisor({ localPeriod: lp.seam });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, RESULT_OK);
    await settle();
    lp.toLocal();
    exitChild(child1, 1);
    await waitFor(() => (sup.status() as { heldForLocalModel?: true }).heldForLocalModel, "held");
    lp.toClaude(true);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("after an unasked switch back, the user's Start resumes with a polling turn", async () => {
    writeSettings({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    const lp = localPeriodSeam(false);
    const { sup } = makeSupervisor({ localPeriod: lp.seam });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, RESULT_OK);
    await settle();
    lp.toLocal();
    exitChild(child1, 1);
    await waitFor(() => (sup.status() as { heldForLocalModel?: true }).heldForLocalModel, "held");
    lp.toClaude(false);
    await quiet();
    expect(children).toHaveLength(1);
    await sup.startByUser();
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("the sign-in re-check still runs during the period; an owed wake does not", async () => {
    const lp = localPeriodSeam(false);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("on-click") });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, INIT);
    pushJson(child1, NOT_SIGNED_IN);
    await waitFor(() => sup.status().lastError === "needs-login", "the sign-in trip");
    lp.toLocal();
    await sup.relaunch(cwdDir); // the user's Check again
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("a user Relaunch during the period carries no wake into the resumed spawn (R4.2)", async () => {
    const lp = localPeriodSeam(false);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("on-click") });
    await sup.startFresh(cwdDir); // its bootstrap turn is still unanswered
    lp.toLocal();
    await sup.relaunch(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([]);
  });

  it("a wake raised during the period is not flushed at the end of the turn in flight", async () => {
    const lp = localPeriodSeam(false);
    const { sup, emit } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: settingsOf("on-click"),
    });
    await sup.startFresh(cwdDir);
    const child = children[0];
    lp.toLocal();
    emit(annotationEvent()); // reaches this harness's fan-out; a turn is in flight
    pushJson(child, RESULT_OK);
    await settle();
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
  });

  it("an idle-stopped Claude stays stopped at the user's switch back", async () => {
    writeSettings({ startMode: "on-click", lifetime: "idle", idleMinutes: 1 });
    const lp = localPeriodSeam(false);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, idleMinuteMs: 30 });
    await sup.start();
    await sup.startByUser();
    const child1 = await nthChild(1);
    pushJson(child1, RESULT_OK);
    await waitFor(() => child1.killed, "the idle stop");
    lp.toLocal();
    lp.toClaude(true);
    await quiet();
    expect(children).toHaveLength(1);
  });

  it("an idle-stopped Claude starts at the switch back when a held message start runs for it", async () => {
    writeSettings({ startMode: "on-click", lifetime: "idle", idleMinutes: 1 });
    const lp = localPeriodSeam(false);
    const { sup, emit } = makeSupervisor({ localPeriod: lp.seam, idleMinuteMs: 30 });
    await sup.start();
    await sup.startByUser();
    const child1 = await nthChild(1);
    pushJson(child1, RESULT_OK);
    await waitFor(() => child1.killed, "the idle stop");
    await waitFor(
      () => (sup.status() as { standby?: string }).standby === "idle",
      "the idle standby",
    );
    lp.toLocal();
    emit(chatEvent());
    await waitFor(() => !(sup.status() as { restartPending?: true }).restartPending, "held");
    await quiet();
    expect(children).toHaveLength(1);
    expect((sup.status() as { standby?: string }).standby).toBe("idle");
    lp.toClaude(true);
    await nthChild(2);
  });
});

describe("#1123 A2 — review items 5, 13, 14", () => {
  it("item 5: a switch-back start that waits on its settings read does not run after a later unasked switch back", async () => {
    const lp = localPeriodSeam(true);
    let releaseRead = (): void => {};
    let readStarted = false;
    let holdReads = false;
    const { sup } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: async () => {
        if (holdReads) {
          readStarted = true;
          await new Promise<void>((r) => {
            releaseRead = r;
          });
        }
        return {
          source: "default",
          settings: { startMode: "auto", lifetime: "always", idleMinutes: 30 },
        };
      },
    });
    await sup.start(); // boot held
    holdReads = true;
    lp.toClaude(true);
    await waitFor(() => readStarted, "the switch back's settings read");
    lp.toLocal();
    lp.toClaude(false); // unasked, while the start waits
    holdReads = false;
    releaseRead();
    await quiet();
    expect(children).toHaveLength(0);
  });

  it("item 13: a boot an unasked switch back parked is started at the user's own next switch back, after a later period", async () => {
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("auto") });
    await sup.start();
    lp.toClaude(false);
    await quiet();
    expect(children).toHaveLength(0);
    lp.toLocal();
    expect(sup.status()).toMatchObject({ heldForLocalModel: true });
    lp.toClaude(true);
    await nthChild(1);
  });

  it("item 14: a setup Apply is honoured during the period and after an unasked switch back", async () => {
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("auto") });
    await sup.start();
    lp.toClaude(false);
    expect(await sup.startAfterSetup()).toBe("starting");
    await nthChild(1);
  });
});

describe("#1123 A2 — the switch-back start paths (tests review)", () => {
  it("decision 10 / R5.1: a held boot is started only when the mode still reads auto", async () => {
    let mode: "auto" | "on-click" = "auto";
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: async () => ({
        source: "default",
        settings: { startMode: mode, lifetime: "always", idleMinutes: 30 },
      }),
    });
    await sup.start();
    mode = "on-click";
    lp.toClaude(true);
    await quiet();
    expect(children).toHaveLength(0);
  });

  it("a held boot does not start when the mode reads Off at the switch back", async () => {
    let mode: "auto" | "off" = "auto";
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: async () => ({
        source: "default",
        settings: { startMode: mode, lifetime: "always", idleMinutes: 30 },
      }),
    });
    await sup.start();
    mode = "off";
    lp.toClaude(true);
    await quiet();
    expect(children).toHaveLength(0);
  });

  it("R5.1 'except Off': a held message start does not run when the mode reads Off at the switch back", async () => {
    let mode: "on-click" | "off" = "on-click";
    const lp = localPeriodSeam(true);
    const { sup, emit } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: async () => ({
        source: "default",
        settings: { startMode: mode, lifetime: "always", idleMinutes: 30 },
      }),
    });
    await sup.start();
    emit(chatEvent());
    await waitFor(
      () => !(sup.status() as { restartPending?: true }).restartPending,
      "the message start to be held",
    );
    mode = "off";
    lp.toClaude(true);
    await quiet();
    expect(children).toHaveLength(0);
  });

  it("a held message start does not run beside another AI", async () => {
    let other = false;
    const lp = localPeriodSeam(true);
    const { sup, emit } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: settingsOf("on-click"),
      otherAiAttached: () => other,
    });
    await sup.start();
    emit(chatEvent());
    await waitFor(
      () => !(sup.status() as { restartPending?: true }).restartPending,
      "the message start to be held",
    );
    other = true;
    lp.toClaude(true);
    await quiet();
    expect(children).toHaveLength(0);
  });

  it("re-review B2: the user's second own switch back, while the first's start still waits, starts Claude", async () => {
    const lp = localPeriodSeam(true);
    let releaseRead = (): void => {};
    let readStarted = false;
    let holdReads = false;
    const { sup } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: async () => {
        if (holdReads) {
          readStarted = true;
          holdReads = false;
          await new Promise<void>((r) => {
            releaseRead = r;
          });
        }
        return {
          source: "default",
          settings: { startMode: "auto", lifetime: "always", idleMinutes: 30 },
        };
      },
    });
    await sup.start();
    holdReads = true;
    lp.toClaude(true);
    await waitFor(() => readStarted, "the first switch back's settings read");
    lp.toLocal();
    lp.toClaude(true); // the user's own, again
    releaseRead();
    await nthChild(1);
    await quiet();
    expect(children).toHaveLength(1);
  });

  it("R4.5: in on-click with no held start, a standby a chat would start reports the field and no startsOnMessage", async () => {
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({ localPeriod: lp.seam, readSettings: settingsOf("on-click") });
    await sup.start();
    const status = sup.status() as { heldForLocalModel?: true; startsOnMessage?: true };
    expect(status.heldForLocalModel).toBe(true);
    expect(status.startsOnMessage).toBeUndefined();
    lp.toClaude(false);
    const after = sup.status() as { heldForLocalModel?: true; startsOnMessage?: true };
    expect(after.heldForLocalModel).toBeUndefined();
    expect(after.startsOnMessage).toBe(true);
  });

  it("R4.5: a lastError outranks the field even with a start held", async () => {
    let cli: string | null = process.execPath;
    const lp = localPeriodSeam(true);
    const { sup } = makeSupervisor({
      localPeriod: lp.seam,
      readSettings: settingsOf("auto"),
      resolveClaudeCommand: () => cli,
    });
    await sup.start(); // boot held
    cli = null;
    await sup.startByUser(); // the user's Start finds no Claude Code
    const status = sup.status() as { lastError?: string; heldForLocalModel?: true };
    expect(status.lastError).toBe("cli-unusable");
    expect(status.heldForLocalModel).toBeUndefined();
  });
});

describe("#1123 A2 — the real queue, the real switch and the real supervisor", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tandem-sup-lp-"));
    resetQueue();
    __resetLocalPeriodForTests();
    __setHonourLocalPeriodRecordsForTests(true);
    __resetLocalModelAnnouncedForTests(dir);
    __resetChatAnswererForTests(dir);
    fs.writeFileSync(path.join(dir, "local-model-baseline.json"), '{"version":1}\n');
    primeLocalModelSettings();
    primeChatAnswerer();
    setCtrlMode("tandem");
    installLocalPeriod({
      unansweredUserChat: () => [],
      chatKeys: () => [],
      currentSelections: () => [],
      suspendDeliveryRound: () => {},
      discardSuspendedRound: () => {},
      clearBufferedSelections: () => {},
      emitReturnWake: emitAnswererReturnWake,
      persist: () => {},
    });
  });
  afterEach(async () => {
    await __flushLocalModelAnnouncedForTests();
    __resetLocalPeriodForTests();
    __setHonourLocalPeriodRecordsForTests(null);
    __resetChatAnswererForTests();
    resetQueue();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  function realSupervisor(startMode: "auto" | "on-click"): Supervisor {
    const sup = createSupervisor({
      probeCliUsable: () => true,
      resolveClaudeCommand: () => process.execPath,
      restartBackoffsMs: [0],
      homeOverride: fs.realpathSync(os.tmpdir()),
      integrationsBase: baseDir,
      readSettings: settingsOf(startMode),
      localPeriod: { held: inLocalPeriod, subscribe: subscribeLocalPeriod },
    });
    sups.push(sup);
    return sup;
  }

  it("a turn in flight across the user's switch back still gets its one wake (the supervisor is told before the wake is pushed)", async () => {
    const sup = realSupervisor("on-click");
    await sup.startFresh(cwdDir);
    const child = children[0];
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT]); // turn in flight
    await setChatAnswerer("local", "own-window");
    await setChatAnswerer("claude", "own-window");
    pushJson(child, RESULT_OK);
    await settle();
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT, SUPERVISOR_WAKE_PROMPT]);
  });

  it("a held auto Claude beside a hand-launched watch: no Claude is started during the period and the watch gets nothing; at the switch back the fresh child gets its bootstrap turn and no wake after it, the watch one wake", async () => {
    const sup = realSupervisor("auto");
    await setChatAnswerer("local", "own-window");
    await sup.start();
    // During the period no child exists to reach: what is asserted is that
    // none is started, and that the external watch is handed nothing.
    expect(children).toHaveLength(0);
    const watch: TandemEvent[] = [];
    const watchCb = (e: TandemEvent) => watch.push(e);
    subscribe(watchCb, "external");
    _pushEventForTests(chatEvent());
    expect(watch).toEqual([]);
    expect(children).toHaveLength(0);
    await setChatAnswerer("claude", "own-window");
    const child = await nthChild(1);
    await settle();
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    // End the bootstrap turn (round-2 item 6): a wake wrongly owed to the
    // fresh spawn would be written only now, at its first result.
    pushJson(child, RESULT_OK);
    await settle();
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    expect(watch.map((e) => e.type)).toEqual(["annotation:created"]);
    unsubscribe(watchCb);
  });
});
