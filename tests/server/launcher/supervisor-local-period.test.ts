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
import type { TandemEvent } from "../../../src/server/events/types.js";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import { createSupervisor, type Supervisor } from "../../../src/server/launcher/supervisor.js";
import {
  SUPERVISOR_GREETING_PROMPT,
  SUPERVISOR_INITIAL_PROMPT,
  SUPERVISOR_WAKE_PROMPT,
} from "../../../src/shared/launcher/contract.js";

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
    await settle(10);
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
    await settle(10);
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
    await settle(10);
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
