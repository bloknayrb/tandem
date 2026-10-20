/**
 * Deterministic turn-delivery coverage for the launcher supervisor (#1866,
 * #1868, #1867, #1780).
 *
 * `stream-json-protocol.test.ts` drives a real stub process, which is the right
 * tool for the wire shape and the wrong one for ORDERING: a failed-write
 * callback landing after teardown, two `'error'` emits before one exit, a child
 * that accepts a write and never reads it. None of those can be scheduled
 * against a real pipe. So `spawn` is mocked here, for the whole file (a
 * `vi.mock` is file-scoped, which is why this is its own file), and each child
 * is a fake whose write callbacks, stream errors and exits the test fires by
 * hand. The same mock makes restart-path ordering observable, which is why the
 * #2125 cases (a crash restart whose integrations read fails) live here too.
 *
 * The fake follows real Node where the supervisor depends on it:
 *   - `kill()` sets `killed` synchronously but `signalCode` and `exit` only on a
 *     later tick, as Node does. `stopInternal` calls `kill` before it registers
 *     `once("exit")`, so a synchronous emit would be missed.
 *   - stdin keeps its listeners, so the `'error'` listener
 *     `attachChildStreamErrorHandlers` installs is live, and `failWrite` fires
 *     the callbacks first and the stream `'error'` a tick later — the order the
 *     docblock there records as measured.
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
import { _pushEventForTests, resetForTesting } from "../../../src/server/events/queue.js";
import type { TandemEvent } from "../../../src/server/events/types.js";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import {
  createSupervisor,
  LicenseRefusedError,
  type Supervisor,
} from "../../../src/server/launcher/supervisor.js";
import type { AiRefusal } from "../../../src/server/license/ai-refusal.js";
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

const EPIPE = (): NodeJS.ErrnoException =>
  Object.assign(new Error("write EPIPE"), { code: "EPIPE" }) as NodeJS.ErrnoException;

/** A crash the supervisor did not cause. */
function exitChild(child: FakeChild, code: number | null, signal: NodeJS.Signals | null = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
}

function held(child: FakeChild): HeldWrite[] {
  return child.stdin.writes.filter((w) => !w.settled);
}

/** Run the given write callbacks with EPIPE, and emit no stream error. */
function failCallbacksOnly(entries: HeldWrite[]): void {
  for (const w of entries) {
    if (w.settled) continue;
    w.settled = true;
    w.cb?.(EPIPE());
  }
}

/** Resolve the given write callbacks successfully. */
function succeedWrites(entries: HeldWrite[]): void {
  for (const w of entries) {
    if (w.settled) continue;
    w.settled = true;
    w.cb?.();
  }
}

/** The real failure order: stdin stops being writable, every callback fails,
 * then ONE stream `'error'` on a later tick. */
function failWrite(child: FakeChild, entries: HeldWrite[] = held(child)): void {
  child.stdin.writable = false;
  failCallbacksOnly(entries);
  setImmediate(() => child.stdin.emit("error", EPIPE()));
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

const INIT = { type: "system", subtype: "init" };
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

function logText(): string {
  return errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
}

/** Child 1 is fresh, its bootstrap turn answered, and an event wrote W1 (held). */
async function freshChildWithHeldWake(sup: Supervisor, emit: (e: TandemEvent) => void) {
  await sup.startFresh(cwdDir);
  const child1 = children[0];
  expect(texts(child1)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
  const bootstrap = child1.stdin.writes[0];
  pushJson(child1, RESULT_OK);
  await settle();
  emit(annotationEvent());
  expect(texts(child1)).toEqual([SUPERVISOR_INITIAL_PROMPT, SUPERVISOR_WAKE_PROMPT]);
  const w1 = child1.stdin.writes[1];
  return { child1, bootstrap, w1 };
}

// --- #1866 --------------------------------------------------------------------

describe("#1866 — a failed-write callback that lands after teardown", () => {
  it("teardown before the callback still carries exactly one wake to the next spawn", async () => {
    const { sup, emit } = makeSupervisor();
    const { child1, bootstrap, w1 } = await freshChildWithHeldWake(sup, emit);

    exitChild(child1, 1);
    failCallbacksOnly([bootstrap, w1]);

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("a callback before teardown is unchanged", async () => {
    const { sup, emit } = makeSupervisor();
    const { child1, w1 } = await freshChildWithHeldWake(sup, emit);

    failCallbacksOnly([w1]);
    exitChild(child1, 1);

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("a stale callback cannot reach the successor", async () => {
    const { sup, emit } = makeSupervisor();
    const { child1, bootstrap, w1 } = await freshChildWithHeldWake(sup, emit);

    exitChild(child1, 1);
    failCallbacksOnly([w1]);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);

    failCallbacksOnly([bootstrap]);
    await settle();

    expect(texts(child1)).toEqual([SUPERVISOR_INITIAL_PROMPT, SUPERVISOR_WAKE_PROMPT]);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    expect(child2.kills).toEqual([]);
  });

  it("user stop: a late callback carries nothing, even after start() lowered the flags", async () => {
    const { sup, emit } = makeSupervisor();
    const { w1 } = await freshChildWithHeldWake(sup, emit);

    await sup.stop();
    // After `startInternal` lowered the flags, before the resumed branch reads
    // the wake flag.
    onSpawn = (_child, index) => {
      if (index === 1) failCallbacksOnly([w1]);
    };
    await sup.start();

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([]);
  });

  it("user stop: a wake pending at teardown is not promoted", async () => {
    const { sup, emit } = makeSupervisor();
    const { w1 } = await freshChildWithHeldWake(sup, emit);
    failCallbacksOnly([w1]);

    await sup.stop();
    await sup.start();

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([]);
  });

  it("user stop drops a wake owed by a crash", async () => {
    const { sup, emit } = makeSupervisor({ restartBackoffsMs: [5_000] });
    const { child1, w1 } = await freshChildWithHeldWake(sup, emit);
    failCallbacksOnly([w1]);
    exitChild(child1, 1);

    await sup.stop();
    await sup.start();

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([]);
  });

  it("user stop after a crash: a callback landing after the stop carries nothing", async () => {
    const { sup, emit } = makeSupervisor({ restartBackoffsMs: [5_000] });
    const { child1, w1 } = await freshChildWithHeldWake(sup, emit);
    exitChild(child1, 1);

    await sup.stop();
    failCallbacksOnly([w1]);
    await sup.start();

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([]);
  });

  it("relaunch keeps a wake owed by a crash", async () => {
    const { sup, emit } = makeSupervisor({ restartBackoffsMs: [5_000] });
    const { child1, w1 } = await freshChildWithHeldWake(sup, emit);
    failCallbacksOnly([w1]);
    exitChild(child1, 1);

    await sup.relaunch(cwdDir);

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("relaunch keeps a wake pending on the live child", async () => {
    const { sup, emit } = makeSupervisor();
    const { w1 } = await freshChildWithHeldWake(sup, emit);
    failCallbacksOnly([w1]);

    await sup.relaunch(cwdDir);

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });
});

// --- #2181 --------------------------------------------------------------------

describe("#2181 — an event while no spawn is subscribed", () => {
  /** Child 1 fresh, bootstrap answered, so it is idle with nothing owed. */
  async function idleFreshChild(sup: Supervisor): Promise<FakeChild> {
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, RESULT_OK);
    await settle();
    return child1;
  }

  it("a chat during a crash restart's backoff wakes the resumed successor", async () => {
    const { sup, emit } = makeSupervisor();
    const child1 = await idleFreshChild(sup);
    exitChild(child1, 1);
    emit(annotationEvent());

    const child2 = await nthChild(2);
    await settle();
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("control: with no event in the gap, the resumed successor gets no turn", async () => {
    const { sup } = makeSupervisor();
    const child1 = await idleFreshChild(sup);
    exitChild(child1, 1);

    const child2 = await nthChild(2);
    await settle();
    expect(texts(child2)).toEqual([]);
  });

  it("a wake written into a child being relaunched is carried to the successor", async () => {
    // The dying child is still subscribed until its exit, so the event reaches
    // it and the write lands in a pipe nobody will read. Nothing fails, so
    // only the unanswered turn records that the wake was not delivered.
    const { sup, emit } = makeSupervisor();
    const child1 = await idleFreshChild(sup);
    const relaunched = sup.relaunch(cwdDir);
    emit(annotationEvent());
    await relaunched;

    expect(texts(child1).at(-1)).toBe(SUPERVISOR_WAKE_PROMPT);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("an event between start() and the spawn's own subscribe is owed", async () => {
    const { sup, emit } = makeSupervisor();
    await idleFreshChild(sup);
    await sup.stop();
    // `onSpawn` runs inside `spawn()`, before `spawnOnce` subscribes.
    onSpawn = (_child, index) => {
      if (index === 1) emit(annotationEvent());
    };
    await sup.start();

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("a fresh successor gets its bootstrap only, not a second wake", async () => {
    const { sup, emit } = makeSupervisor({ restartBackoffsMs: [5_000] });
    const child1 = await idleFreshChild(sup);
    exitChild(child1, 1);
    emit(annotationEvent());

    await sup.startFresh(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
  });

  it("user stop disarms a watch a crash armed (#1866 still holds)", async () => {
    const { sup, emit } = makeSupervisor({ restartBackoffsMs: [5_000] });
    const child1 = await idleFreshChild(sup);
    exitChild(child1, 1);
    await sup.stop();
    emit(annotationEvent());

    await sup.start();
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([]);
  });

  it("a relaunch after a user stop owes an event that lands before its spawn subscribes", async () => {
    const { sup, emit } = makeSupervisor();
    await idleFreshChild(sup);
    await sup.stop();
    onSpawn = (_child, index) => {
      if (index === 1) emit(annotationEvent());
    };
    await sup.relaunch(cwdDir);

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("an event a live child answered is not carried to a crash successor", async () => {
    // Pins the disarm at subscribe: a watch left armed beside a live child
    // would record every event it already handled.
    const { sup, emit } = makeSupervisor();
    const child1 = await idleFreshChild(sup);
    emit(annotationEvent());
    pushJson(child1, RESULT_OK);
    await settle();
    exitChild(child1, 1);

    const child2 = await nthChild(2);
    await settle();
    expect(texts(child2)).toEqual([]);
  });

  it("a crash does not carry the unanswered turn it died on", async () => {
    // The turn may be what crashed it; re-sending it to every resumed successor
    // would keep a slow crash loop alive past the restart breaker.
    const { sup, emit } = makeSupervisor();
    const child1 = await idleFreshChild(sup);
    emit(annotationEvent());
    expect(texts(child1).at(-1)).toBe(SUPERVISOR_WAKE_PROMPT);
    exitChild(child1, 1);

    const child2 = await nthChild(2);
    await settle();
    expect(texts(child2)).toEqual([]);
  });

  it("a user stop of a child with an unanswered turn carries nothing", async () => {
    const { sup, emit } = makeSupervisor();
    const child1 = await idleFreshChild(sup);
    emit(annotationEvent());
    expect(texts(child1).at(-1)).toBe(SUPERVISOR_WAKE_PROMPT);
    await sup.stop();

    await sup.start();
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([]);
  });
});

// --- #2180 --------------------------------------------------------------------

describe("#2180 — status().restartPending: Tandem is already bringing Claude back", () => {
  function pending(sup: Supervisor): boolean {
    const st = sup.status();
    return !st.running && st.restartPending === true;
  }

  /** Stop this child's `kill()` from exiting on its own; the test fires it. */
  function holdExit(child: FakeChild): void {
    child.kill = (sig: NodeJS.Signals = "SIGTERM") => {
      child.kills.push(sig);
      child.killed = true;
      return true;
    };
  }

  it("is true during a crash restart's backoff", async () => {
    const { sup } = makeSupervisor({ restartBackoffsMs: [5_000] });
    await sup.startFresh(cwdDir);
    exitChild(children[0], 1);
    expect(sup.status().running).toBe(false);
    expect(pending(sup)).toBe(true);
  });

  it("is true while a relaunch waits for the old child to exit", async () => {
    // `kill()` marks the child killed at once, so status already reads
    // not-running for the whole SIGTERM wait: the window that used to offer a
    // Restart button.
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    holdExit(child1);
    const relaunched = sup.relaunch(cwdDir);
    await waitFor(() => child1.kills.length > 0, "the relaunch's SIGTERM");
    expect(sup.status().running).toBe(false);
    expect(pending(sup)).toBe(true);

    exitChild(child1, null, "SIGTERM");
    await relaunched;
    expect(sup.status().running).toBe(true);
  });

  it("is true while the relaunch builds its next spawn", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    let seen: boolean | null = null;
    onSpawn = (_child, index) => {
      if (index === 1) seen = pending(sup);
    };
    await sup.relaunch(cwdDir);
    expect(seen).toBe(true);
  });

  it("is true between a delivery kill and its exit", async () => {
    const { sup, emit } = makeSupervisor({ turnReceiptMs: 100 });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    succeedWrites(held(child1));
    pushJson(child1, RESULT_OK);
    await settle();
    holdExit(child1);
    emit(annotationEvent());
    succeedWrites(held(child1));
    await waitFor(() => child1.kills.length > 0, "the receipt kill", 2_000);
    expect(pending(sup)).toBe(true);
    exitChild(child1, null, "SIGTERM");
  });

  it("guard: false once the new child is running", async () => {
    const { sup } = makeSupervisor({ restartBackoffsMs: [0] });
    await sup.startFresh(cwdDir);
    exitChild(children[0], 1);
    await nthChild(2);
    await waitFor(() => sup.status().running, "the restart");
    expect(pending(sup)).toBe(false);
  });

  it("guard: false once the breaker trips, so the failure can show", async () => {
    const { sup } = makeSupervisor({ restartBackoffsMs: [0] });
    await sup.startFresh(cwdDir);
    for (let n = 1; ; n++) {
      exitChild(children[n - 1], 1);
      const st = sup.status();
      if (!st.running && st.lastError !== undefined) break;
      await nthChild(n + 1);
      await waitFor(() => sup.status().running, `restart ${n}`);
    }
    const st = sup.status();
    expect(st.running).toBe(false);
    expect(st.running === false && st.lastError).toBe("circuit-open");
    expect(pending(sup)).toBe(false);
  });
});

// --- #1868 --------------------------------------------------------------------

const DELIVERY_TRIP_REPORT = "launcher: wake delivery failed on consecutive sessions";

describe("#1868 — consecutive stdin-error kills trip their own breaker", () => {
  /** Delivery-kill children `from`..`to` in turn: each fails its held writes
   * the real way, is ended by the supervisor, and its successor comes back. */
  async function deliveryKill(from: number, to: number, between?: () => void): Promise<void> {
    for (let i = from; i <= to; i++) {
      const c = await nthChild(i);
      expect(held(c).length, `child ${i} has a turn to fail`).toBeGreaterThan(0);
      failWrite(c);
      await waitFor(() => c.exitCode !== null || c.signalCode !== null, `child ${i} to exit`);
      between?.();
    }
  }

  async function expectStableSpawnCount(n: number): Promise<void> {
    await sleep(50);
    await settle();
    expect(children).toHaveLength(n);
  }

  it("trips at a slow cadence that the windowed breaker and the latch never see", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const reportDeliveryTrip = vi.fn();
    const { sup } = makeSupervisor({ reportDeliveryTrip });
    await sup.startFresh(cwdDir);

    await deliveryKill(1, 3, () => vi.setSystemTime(Date.now() + 11 * 60_000));

    await waitFor(() => sup.status().lastError === "wake-delivery-failed", "the trip");
    expect(sup.status()).toEqual({ running: false, lastError: "wake-delivery-failed" });
    await expectStableSpawnCount(3);
    expect(reportDeliveryTrip).toHaveBeenCalledExactlyOnceWith(DELIVERY_TRIP_REPORT);
    expect(logText()).toContain("stopped accepting turns — giving up");
  });

  it("trips at the same count at a fast cadence", async () => {
    const reportDeliveryTrip = vi.fn();
    const { sup } = makeSupervisor({ reportDeliveryTrip });
    await sup.startFresh(cwdDir);

    await deliveryKill(1, 3);

    await waitFor(() => sup.status().lastError === "wake-delivery-failed", "the trip");
    await expectStableSpawnCount(3);
    expect(reportDeliveryTrip).toHaveBeenCalledOnce();
  });

  it("a completed turn resets the streak", async () => {
    const reportDeliveryTrip = vi.fn();
    const { sup } = makeSupervisor({ reportDeliveryTrip });
    await sup.startFresh(cwdDir);
    await deliveryKill(1, 2);

    const child3 = await nthChild(3);
    expect(texts(child3)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    pushJson(child3, INIT);
    pushJson(child3, RESULT_OK);
    await settle();
    exitChild(child3, 1);

    const child4 = await nthChild(4);
    expect(texts(child4)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    await deliveryKill(4, 5);

    await nthChild(6);
    await expectStableSpawnCount(6);
    const status = sup.status();
    expect(status.running).toBe(true);
    expect(status.lastError).toBeUndefined();
    expect(reportDeliveryTrip).not.toHaveBeenCalled();
  });

  it("init alone is not proof of delivery", async () => {
    const { sup } = makeSupervisor({ reportDeliveryTrip: vi.fn() });
    await sup.startFresh(cwdDir);
    await deliveryKill(1, 2);

    const child3 = await nthChild(3);
    pushJson(child3, INIT);
    await settle();
    await deliveryKill(3, 3);

    await waitFor(() => sup.status().lastError === "wake-delivery-failed", "the trip at child 3");
    await expectStableSpawnCount(3);
  });

  it("counts one spawn once, however many times its stdin errors before it exits", async () => {
    const { sup } = makeSupervisor({ reportDeliveryTrip: vi.fn() });
    await sup.startFresh(cwdDir);

    for (const i of [1, 2]) {
      const c = await nthChild(i);
      failCallbacksOnly(held(c));
      c.stdin.writable = false;
      c.stdin.emit("error", EPIPE());
      c.stdin.emit("error", EPIPE());
      await waitFor(() => c.signalCode !== null, `child ${i} to exit`);
    }

    const child3 = await nthChild(3);
    expect(texts(child3)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    await expectStableSpawnCount(3);
    const status = sup.status();
    expect(status.running).toBe(true);
    expect(status.lastError).toBeUndefined();
  });

  it("ordinary exits are not delivery kills", async () => {
    const { sup } = makeSupervisor({ reportDeliveryTrip: vi.fn() });
    await sup.startFresh(cwdDir);
    for (const i of [1, 2, 3]) exitChild(await nthChild(i), 1);

    await nthChild(4);
    expect(sup.status().lastError).not.toBe("wake-delivery-failed");
    expect(sup.status().running).toBe(true);
  });

  it("a missing CLI whose stdin error beats its exit routes to Setup, and reports nothing", async () => {
    const reportDeliveryTrip = vi.fn();
    const { sup } = makeSupervisor({ reportDeliveryTrip, probeCliUsable: () => false });
    await sup.startFresh(cwdDir);

    for (const i of [1, 2, 3]) {
      const c = await nthChild(i);
      failCallbacksOnly(held(c));
      c.stdin.writable = false;
      c.stdin.emit("error", EPIPE());
      expect(c.kills, `child ${i} was ended by the handler`).toEqual(["SIGTERM"]);
      exitChild(c, 127);
    }

    await waitFor(() => sup.status().lastError === "cli-unusable", "the setup trip");
    await expectStableSpawnCount(3);
    expect(reportDeliveryTrip).not.toHaveBeenCalled();
  });

  it("a user relaunch resets the streak", async () => {
    const { sup } = makeSupervisor({ reportDeliveryTrip: vi.fn() });
    await sup.startFresh(cwdDir);
    await deliveryKill(1, 3);
    await waitFor(() => sup.status().lastError === "wake-delivery-failed", "the trip");

    await sup.relaunch(cwdDir);
    await deliveryKill(4, 4);

    await nthChild(5);
    await expectStableSpawnCount(5);
    const status = sup.status();
    expect(status.running).toBe(true);
    expect(status.lastError).toBeUndefined();
  });
});

// --- #1867 --------------------------------------------------------------------

describe("#1867 — an alive child that has stopped reading its input", () => {
  const RECEIPT_MS = 200;

  /** Child 1 answers its bootstrap turn, so it is idle and the next write is
   * receipt-checked. */
  async function idleFreshChild(sup: Supervisor): Promise<FakeChild> {
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    succeedWrites(held(child1));
    pushJson(child1, INIT);
    pushJson(child1, RESULT_OK);
    await settle();
    return child1;
  }

  it("is ended, and one wake is carried to a successor that does read", async () => {
    const { sup, emit } = makeSupervisor({ turnReceiptMs: RECEIPT_MS });
    const child1 = await idleFreshChild(sup);
    emit(annotationEvent());
    expect(texts(child1)).toEqual([SUPERVISOR_INITIAL_PROMPT, SUPERVISOR_WAKE_PROMPT]);
    succeedWrites(held(child1));

    await waitFor(() => child1.kills.includes("SIGTERM"), "the receipt kill", 2_000);
    expect(logText()).toContain("No turn receipt within");

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    pushJson(child2, INIT);
    await sleep(2 * RECEIPT_MS);
    expect(child2.kills).toEqual([]);
  });

  it("a long turn that acknowledged receipt is not ended", async () => {
    const { sup, emit } = makeSupervisor({ turnReceiptMs: RECEIPT_MS, wakeLatchMs: 5_000 });
    const child1 = await idleFreshChild(sup);
    emit(annotationEvent());
    await sleep(50);
    pushJson(child1, INIT);

    await sleep(1_000);
    expect(child1.kills).toEqual([]);
  });

  it("coalesces events during the stall instead of queueing writes", async () => {
    const { sup, emit } = makeSupervisor({ turnReceiptMs: RECEIPT_MS });
    const child1 = await idleFreshChild(sup);
    emit(annotationEvent());
    for (let i = 0; i < 5; i++) emit(annotationEvent());

    await waitFor(() => child1.kills.includes("SIGTERM"), "the receipt kill", 2_000);
    expect(texts(child1)).toEqual([SUPERVISOR_INITIAL_PROMPT, SUPERVISOR_WAKE_PROMPT]);
  });

  it("stdout noise is not receipt", async () => {
    const { sup } = makeSupervisor({ turnReceiptMs: RECEIPT_MS });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushLine(child1, "banner text");
    pushLine(child1, "{not json");

    await waitFor(() => child1.kills.includes("SIGTERM"), "the receipt kill", 2_000);
  });

  it("does not receipt-check the flush after the latch expires on an unresolved turn", async () => {
    const { sup, emit } = makeSupervisor({ turnReceiptMs: RECEIPT_MS, wakeLatchMs: 300 });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, INIT);
    await settle();
    emit(annotationEvent());

    await waitFor(() => texts(child1).length === 2, "the latch-expiry flush", 2_000);
    await sleep(1_000);
    expect(child1.kills).toEqual([]);
    expect(texts(child1)).toEqual([SUPERVISOR_INITIAL_PROMPT, SUPERVISOR_WAKE_PROMPT]);
  });

  it("the first of two outstanding turns resolving does not re-arm the receipt check", async () => {
    const { sup, emit } = makeSupervisor({ turnReceiptMs: RECEIPT_MS, wakeLatchMs: 300 });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, INIT);
    await settle();
    emit(annotationEvent());
    await waitFor(() => texts(child1).length === 2, "the latch-expiry flush", 2_000);

    // Turn 1 resolves while the flushed turn may still be in a silent tool call.
    pushJson(child1, RESULT_OK);
    await settle();
    emit(annotationEvent());
    expect(texts(child1)).toHaveLength(3);
    await sleep(1_000);
    expect(child1.kills).toEqual([]);

    // Once every outstanding turn has resolved, the next write is checked again.
    pushJson(child1, RESULT_OK);
    pushJson(child1, RESULT_OK);
    await settle();
    emit(annotationEvent());
    expect(texts(child1)).toHaveLength(4);
    await waitFor(() => child1.kills.includes("SIGTERM"), "the receipt kill", 2_000);
  });
});

// --- #1780 --------------------------------------------------------------------

/** Verbatim from a real claude 2.1.272 with an empty config dir (2026-09-15). */
const NOT_SIGNED_IN = {
  type: "result",
  subtype: "success",
  is_error: true,
  result: "Not logged in · Please run /login",
  terminal_reason: "api_error",
};

describe("#1780 — a Claude Code that is not signed in", () => {
  /** A fresh child refuses its bootstrap turn, with no event emitted, so no
   * wake is pending and `wakeOwedAcrossSpawns` cannot explain what follows. */
  async function tripFresh(sup: Supervisor): Promise<FakeChild> {
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, INIT);
    pushJson(child1, NOT_SIGNED_IN);
    await waitFor(() => sup.status().lastError === "needs-login", "the sign-in trip");
    expect(texts(child1)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    return child1;
  }

  async function expectNoMoreSpawns(n: number): Promise<void> {
    await sleep(50);
    await settle();
    expect(children.length, `launcher log:\n${logText()}`).toBe(n);
  }

  it("trips on the measured envelope, ends the child and stops retrying", async () => {
    const { sup, emit } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    // Mid-bootstrap, so a wake is pending: the refusal must not be followed by
    // its doomed write. (That wake is carried across by teardown, #1866; it is
    // not the re-check — see the Check again cases below.)
    emit(annotationEvent());
    pushJson(child1, INIT);
    pushJson(child1, NOT_SIGNED_IN);

    await waitFor(() => sup.status().lastError === "needs-login", "the sign-in trip");
    expect(sup.status()).toEqual({ running: false, lastError: "needs-login" });
    expect(child1.kills).toEqual(["SIGTERM"]);
    expect(texts(child1)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    expect(logText()).toContain("Claude Code is not signed in");
    await expectNoMoreSpawns(1);
  });

  it("does not trip on another error result", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, INIT);
    pushJson(child1, { ...NOT_SIGNED_IN, result: "API Error: 529 overloaded" });
    await settle();

    expect(child1.kills).toEqual([]);
    const status = sup.status();
    expect(status.running).toBe(true);
    expect(status.lastError).toBeUndefined();
  });

  it("does not trip on a tool's own 'not logged in' inside a result", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, INIT);
    pushJson(child1, { ...NOT_SIGNED_IN, result: "Tool failed: gh says you are not logged in" });
    await settle();

    expect(child1.kills).toEqual([]);
    expect(sup.status().running).toBe(true);
  });

  it("does not trip on the exact refusal text inside a longer result", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, INIT);
    pushJson(child1, {
      ...NOT_SIGNED_IN,
      result: "Tool failed: Not logged in · Please run /login",
    });
    await settle();

    expect(child1.kills).toEqual([]);
    expect(sup.status().running).toBe(true);
  });

  it("does not trip on a successful answer that starts with the refusal text", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, INIT);
    pushJson(child1, {
      ...NOT_SIGNED_IN,
      is_error: false,
      result: "Not logged in to GitHub — run gh auth login",
    });
    await settle();

    expect(child1.kills).toEqual([]);
    expect(sup.status().running).toBe(true);
  });

  it("ignores a sign-in refusal from a superseded child", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    exitChild(child1, 1);
    const child2 = await nthChild(2);

    pushJson(child1, NOT_SIGNED_IN);
    await settle();
    expect(child1.kills).toEqual([]);
    expect(child2.kills).toEqual([]);

    // Nothing was tripped behind the live child's back: its crash still restarts.
    exitChild(child2, 1);
    await nthChild(3);
    const status = sup.status();
    expect(status.running).toBe(true);
    expect(status.lastError).toBeUndefined();
  });

  it("Check again sends the resumed session a turn, and a second refusal trips again", async () => {
    const { sup } = makeSupervisor();
    await tripFresh(sup);

    await sup.relaunch(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);

    pushJson(child2, INIT);
    pushJson(child2, NOT_SIGNED_IN);
    await waitFor(() => sup.status().lastError === "needs-login", "the second trip");
    await expectNoMoreSpawns(2);
  });

  it("a signed-in answer clears the owed re-check", async () => {
    const { sup } = makeSupervisor();
    await tripFresh(sup);
    await sup.relaunch(cwdDir);
    const child2 = await nthChild(2);

    pushJson(child2, INIT);
    pushJson(child2, RESULT_OK);
    await settle();
    const status = sup.status();
    expect(status.running).toBe(true);
    expect(status.lastError).toBeUndefined();

    exitChild(child2, null, "SIGTERM");
    const child3 = await nthChild(3);
    expect(texts(child3)).toEqual([]);
  });

  it("a stop between the trip and Check again does not disarm the re-check", async () => {
    const { sup } = makeSupervisor();
    await tripFresh(sup);
    await sup.stop();
    await sup.relaunch(cwdDir);

    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  function savedSession(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(baseDir, "launcher-session.json"), "utf8"));
  }

  // Review finding: the flag lived only in the supervisor's closure, while the
  // trip's SIGTERM keeps the saved session — so quitting Tandem before signing
  // in made the next launch resume silently and read as ready.
  it("the owed re-check survives a Tandem restart", async () => {
    const first = makeSupervisor().sup;
    await tripFresh(first);
    await first.stop();
    expect(savedSession()).toMatchObject({ cwd: cwdDir, loginRecheckOwed: true });

    const { sup } = makeSupervisor();
    await sup.start();
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);

    pushJson(child2, INIT);
    pushJson(child2, NOT_SIGNED_IN);
    await waitFor(() => sup.status().lastError === "needs-login", "the trip after restart");
    await expectNoMoreSpawns(2);
  });

  it("a signed-in answer after a restart drops the persisted re-check", async () => {
    const first = makeSupervisor().sup;
    await tripFresh(first);
    await first.stop();

    const second = makeSupervisor().sup;
    await second.start();
    const child2 = await nthChild(2);
    pushJson(child2, INIT);
    pushJson(child2, RESULT_OK);
    await settle();
    expect(savedSession()).not.toHaveProperty("loginRecheckOwed");
    await second.stop();

    const third = makeSupervisor().sup;
    await third.start();
    const child3 = await nthChild(3);
    expect(texts(child3)).toEqual([]);
  });
});

// --- A superseded spawn's late exit -----------------------------------------------

describe("a killed child whose exit lands after a relaunch replaced it", () => {
  // Found while writing the #1780 Check again cases: the sign-in trip kills the
  // child, `stopInternal` skips waiting for an already-`killed` handle, and
  // `respawn` lowers `stopRequested` and the breaker — so the old child's exit,
  // arriving during the relaunch, scheduled a restart of its own. Measured in
  // this file: a third spawn behind a tripped breaker.
  it("does not schedule a restart of its own", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    // A reaper that takes its time to exit: killed now, exit only when released.
    child1.kill = (sig: NodeJS.Signals = "SIGTERM") => {
      child1.kills.push(sig);
      child1.killed = true;
      return true;
    };
    pushJson(child1, INIT);
    pushJson(child1, NOT_SIGNED_IN);
    await waitFor(() => child1.killed, "the sign-in kill");

    await sup.relaunch(cwdDir);
    await nthChild(2);
    exitChild(child1, null, "SIGTERM");
    await sleep(50);
    await settle();

    expect(logText()).not.toContain("Restarting Claude in");
    expect(children).toHaveLength(2);
    expect(sup.status().running).toBe(true);
  });
});

// --- #2125 --------------------------------------------------------------------

/** Routes every `integrations.json` read to `handler`, which receives the read's
 * 1-based index and a `pass` that performs the real read. Other files pass
 * through. Arm it AFTER the first spawn so only restart reads are affected,
 * and restore it in a `finally`. */
function interceptIntegrationsReads(
  handler: (n: number, pass: () => Promise<string>) => Promise<string>,
): { restore: () => void; count: () => number } {
  let n = 0;
  const realReadFile = fs.promises.readFile;
  const spy = vi.spyOn(fs.promises, "readFile").mockImplementation(((
    ...args: Parameters<typeof realReadFile>
  ) => {
    if (!String(args[0]).endsWith("integrations.json")) return realReadFile(...args);
    n++;
    return handler(n, () => realReadFile(...args) as Promise<string>);
  }) as typeof realReadFile);
  return { restore: () => spy.mockRestore(), count: () => n };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const EPERM = (): NodeJS.ErrnoException =>
  Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });

function occurrences(needle: string): number {
  return logText().split(needle).length - 1;
}

describe("#2125 — a crash restart whose integrations read fails", () => {
  // The restart timer runs `startInternal` with nobody awaiting it, so a read
  // failure there must not escape as an unhandled rejection: `index.ts` exits
  // the server on one. Cases that schedule a restart wait out a settle window
  // before asserting (with any interceptor still armed), so a late retry or
  // spawn is counted.

  it("retries a transient I/O error through the crash loop's backoff", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const reads = interceptIntegrationsReads((n, pass) =>
      n === 1 ? Promise.reject(EPERM()) : pass(),
    );
    try {
      exitChild(children[0], 1);
      await nthChild(2);
      await sleep(100);
      await settle();
    } finally {
      reads.restore();
    }

    expect(reads.count()).toBe(2);
    expect(occurrences("Restarting Claude in")).toBe(2);
    expect(children).toHaveLength(2);
    expect(sup.status().running).toBe(true);
  });

  it("stays down with spawn-failed on a file a retry cannot fix", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const file = path.join(baseDir, "integrations.json");
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as { schemaVersion: number };
    json.schemaVersion = 99;
    fs.writeFileSync(file, JSON.stringify(json));

    exitChild(children[0], 1);
    await sleep(100);
    await settle();

    expect(occurrences("Restarting Claude in")).toBe(1);
    expect(logText()).toContain("IntegrationsFutureSchemaError");
    expect(children).toHaveLength(1);
    expect(sup.status()).toEqual({ running: false, lastError: "spawn-failed" });
  });

  it("stays down with spawn-failed on an errno a retry cannot fix", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const eisdir = Object.assign(new Error("EISDIR: illegal operation on a directory"), {
      code: "EISDIR",
    });
    const reads = interceptIntegrationsReads(() => Promise.reject(eisdir));
    try {
      exitChild(children[0], 1);
      await sleep(100);
      await settle();
    } finally {
      reads.restore();
    }

    expect(reads.count()).toBe(1);
    expect(occurrences("Restarting Claude in")).toBe(1);
    expect(children).toHaveLength(1);
    expect(sup.status()).toEqual({ running: false, lastError: "spawn-failed" });
  });

  it("a stop during the read leaves no error, no retry and no spawn", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const read = deferred<string>();
    const reads = interceptIntegrationsReads((n, pass) => (n === 1 ? read.promise : pass()));
    try {
      exitChild(children[0], 1);
      await waitFor(() => reads.count() >= 1, "the restart's read");
      await sup.stop();
      read.reject(EPERM());
      await sleep(100);
      await settle();
    } finally {
      reads.restore();
    }

    expect(reads.count()).toBe(1);
    expect(occurrences("Restarting Claude in")).toBe(1);
    expect(children).toHaveLength(1);
    expect(sup.status()).toEqual({ running: false });
  });

  it("a relaunch during a failing read leaves no stale error behind", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const read = deferred<string>();
    const reads = interceptIntegrationsReads((n, pass) => (n === 1 ? read.promise : pass()));
    try {
      exitChild(children[0], 1);
      await waitFor(() => reads.count() >= 1, "the restart's read");
      await sup.relaunch(cwdDir);
      read.reject(EPERM());
      await sleep(100);
      await settle();
    } finally {
      reads.restore();
    }

    expect(sup.status().running).toBe(true);
    expect(children).toHaveLength(2);
    await sup.stop();
    expect(sup.status()).toEqual({ running: false });
  });

  it("a read that fails while a relaunch's own read is in flight schedules nothing", async () => {
    // The relaunch has passed `stopInternal` but not spawned, so `child` is
    // still null here: only the epoch tells this failure it was superseded.
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const staleRead = deferred<string>();
    const relaunchRead = deferred<string>();
    let relaunchPass: (() => Promise<string>) | undefined;
    const reads = interceptIntegrationsReads((n, pass) => {
      if (n === 1) return staleRead.promise;
      if (n === 2) {
        relaunchPass = pass;
        return relaunchRead.promise;
      }
      return pass();
    });
    try {
      exitChild(children[0], 1);
      await waitFor(() => reads.count() >= 1, "the restart's read");
      const relaunched = sup.relaunch(cwdDir);
      await waitFor(() => reads.count() >= 2, "the relaunch's read");
      staleRead.reject(EPERM());
      await sleep(50);
      await settle();
      relaunchRead.resolve(await (relaunchPass as () => Promise<string>)());
      await relaunched;
      await sleep(100);
      await settle();
    } finally {
      reads.restore();
    }

    expect(occurrences("Restarting Claude in")).toBe(1);
    expect(children).toHaveLength(2);
    expect(sup.status().running).toBe(true);
  });

  it("a restart whose read resolves during a relaunch does not spawn over it", async () => {
    // The stale restart's read lands while the relaunch's own read is still in
    // flight. Without the epoch check, the restart spawns from its old plan and
    // the user's relaunch fails "Supervisor already running".
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const staleRead = deferred<string>();
    const relaunchRead = deferred<string>();
    const passes: (() => Promise<string>)[] = [];
    const reads = interceptIntegrationsReads((n, pass) => {
      passes.push(pass);
      if (n === 1) return staleRead.promise;
      if (n === 2) return relaunchRead.promise;
      return pass();
    });
    let relaunchResult: string;
    try {
      exitChild(children[0], 1);
      await waitFor(() => reads.count() >= 1, "the restart's read");
      const relaunched = sup.relaunch(cwdDir).then(
        () => "ok",
        (err: unknown) => `rejected: ${String(err)}`,
      );
      await waitFor(() => reads.count() >= 2, "the relaunch's read");
      staleRead.resolve(await passes[0]());
      await sleep(50);
      await settle();
      relaunchRead.resolve(await passes[1]());
      relaunchResult = await relaunched;
      await settle();
    } finally {
      reads.restore();
    }

    expect(relaunchResult).toBe("ok");
    expect(children).toHaveLength(2);
    expect(sup.status().running).toBe(true);
  });

  it("a boot start() still rejects on a read failure", async () => {
    // Pins the catch at the restart timer: `index.ts` reports a failed boot
    // only because `start()` throws.
    const { sup } = makeSupervisor();
    const reads = interceptIntegrationsReads(() => Promise.reject(EPERM()));
    try {
      await expect(sup.start()).rejects.toMatchObject({ code: "EPERM" });
    } finally {
      reads.restore();
    }
  });

  it("a persistent I/O error trips the breaker instead of looping", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const reads = interceptIntegrationsReads(() => Promise.reject(EPERM()));
    try {
      exitChild(children[0], 1);
      await waitFor(
        () => sup.status().running === false && "lastError" in sup.status(),
        "the trip",
      );
      await sleep(100);
      await settle();
    } finally {
      reads.restore();
    }

    expect(reads.count()).toBe(10);
    expect(logText()).toContain("Giving up: integrations.json stayed unreadable");
    expect(children).toHaveLength(1);
    expect(sup.status()).toEqual({ running: false, lastError: "circuit-open" });
  });

  // The three below drive a locked `start()` while a crash restart's read is
  // held. In production `start()` runs once per supervisor, at its first
  // start, before any crash restart can exist, so the interleaving is
  // artificial, but it is the harness's way to reach these branches.

  it("a read that fails after another spawn took over neither retries nor reports", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const staleRead = deferred<string>();
    const reads = interceptIntegrationsReads((n, pass) => (n === 1 ? staleRead.promise : pass()));
    try {
      exitChild(children[0], 1);
      await waitFor(() => reads.count() >= 1, "the restart's read");
      await sup.start();
      staleRead.reject(EPERM());
      await sleep(100);
      await settle();
    } finally {
      reads.restore();
    }

    expect(occurrences("Superseded restart's plan read failed")).toBe(1);
    expect(occurrences("Restarting Claude in")).toBe(1);
    expect(children).toHaveLength(2);
    expect(sup.status().running).toBe(true);
  });

  it("a read that fails after the breaker tripped keeps the breaker's code", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const staleRead = deferred<string>();
    const reads = interceptIntegrationsReads((n, pass) => (n === 1 ? staleRead.promise : pass()));
    try {
      exitChild(children[0], 1);
      await waitFor(() => reads.count() >= 1, "the restart's read");
      await sup.start();
      // A missing binary trips the breaker and drops the child.
      children[1].emit("error", Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" }));
      // Non-transient, so without the breaker arm this would overwrite the
      // breaker's code with spawn-failed.
      staleRead.reject(Object.assign(new Error("EISDIR"), { code: "EISDIR" }));
      await sleep(100);
      await settle();
    } finally {
      reads.restore();
    }

    expect(occurrences("after the breaker tripped")).toBe(1);
    expect(sup.status()).toEqual({ running: false, lastError: "binary-not-found" });
  });

  it("a start() whose read straddles a breaker trip does not spawn", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const startRead = deferred<string>();
    let startPass: (() => Promise<string>) | undefined;
    const reads = interceptIntegrationsReads((n, pass) => {
      if (n === 1) {
        startPass = pass;
        return startRead.promise;
      }
      return Promise.reject(EPERM());
    });
    try {
      exitChild(children[0], 1);
      const started = sup.start();
      await waitFor(() => "lastError" in sup.status(), "the trip");
      startRead.resolve(await (startPass as () => Promise<string>)());
      await started;
      await sleep(50);
      await settle();
    } finally {
      reads.restore();
    }

    expect(occurrences("Breaker tripped while building the spawn plan")).toBe(1);
    expect(children).toHaveLength(1);
    expect(sup.status()).toEqual({ running: false, lastError: "circuit-open" });
  });
});

// The status route matches MCP connections opened at or after this, so a stale
// or zero value would let the previous child's leftover entry turn the pill green.
describe("status().spawnedAt — when the current child started", () => {
  function spawnedAt(sup: Supervisor): number | undefined {
    const status = sup.status();
    return status.running ? status.spawnedAt : undefined;
  }

  it("is stamped at each spawn, not once per supervisor", async () => {
    const { sup } = makeSupervisor();
    const before = Date.now();
    await sup.startFresh(cwdDir);
    const first = spawnedAt(sup);
    expect(first).toBeGreaterThanOrEqual(before);
    expect(first).toBeLessThanOrEqual(Date.now());

    await new Promise((r) => setTimeout(r, 5));
    const beforeSecond = Date.now();
    await sup.startFresh(cwdDir);
    expect(spawnedAt(sup)).toBeGreaterThanOrEqual(beforeSecond);
  });
});

describe("status().busy — the launched child's turn-in-flight flag", () => {
  function busy(sup: Supervisor): boolean | undefined {
    const status = sup.status();
    return status.running ? status.busy : undefined;
  }

  it("is true while the bootstrap turn runs and false once its result arrives", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    expect(busy(sup)).toBe(true);
    pushJson(child1, RESULT_OK);
    await settle();
    expect(busy(sup)).toBe(false);
  });

  it("goes true again on a wake written to an idle child", async () => {
    const { sup, emit } = makeSupervisor();
    await freshChildWithHeldWake(sup, emit);
    expect(busy(sup)).toBe(true);
  });

  it("stays true across a result when a wake was coalesced behind the turn", async () => {
    const { sup, emit } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    // Mid-bootstrap: this event can only set `pendingWake`.
    emit(annotationEvent());
    pushJson(child1, RESULT_OK);
    await settle();
    // `flushPendingWake` wrote the owed wake on that result, re-raising the flag.
    expect(texts(child1)).toEqual([SUPERVISOR_INITIAL_PROMPT, SUPERVISOR_WAKE_PROMPT]);
    expect(busy(sup)).toBe(true);
  });

  it("clears when the latch expires with nothing owed", async () => {
    const { sup } = makeSupervisor({ wakeLatchMs: 100 });
    await sup.startFresh(cwdDir);
    pushJson(children[0], INIT);
    expect(busy(sup)).toBe(true);
    await waitFor(() => busy(sup) === false, "the latch expiry", 2_000);
  });

  it("clears on a failed write while the child is still up", async () => {
    // Without this, a dead pipe would leave the pill pulsing until the latch.
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    expect(busy(sup)).toBe(true);
    failCallbacksOnly(held(child1));
    expect(sup.status().running).toBe(true);
    expect(busy(sup)).toBe(false);
  });
});

// --- #2195 --------------------------------------------------------------------

function chatEvent(): TandemEvent {
  eventSeq++;
  return {
    id: `evt_${eventSeq}`,
    type: "chat:message",
    timestamp: Date.now(),
    documentId: "d1",
    payload: { messageId: `msg_${eventSeq}`, text: "are you there?", replyTo: null, anchor: null },
  } as TandemEvent;
}

function writeLauncherSettingsFile(settings: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(baseDir, "launcher-settings.json"),
    JSON.stringify({ version: 1, ...settings }),
  );
}

function readLauncherSettingsFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(baseDir, "launcher-settings.json"), "utf8"));
}

const LICENCE_REFUSAL: AiRefusal = {
  error: "LICENSE_REQUIRED",
  kind: "unlicensed",
  message: "Tandem is unlicensed, so its AI features are turned off.",
};

describe("#2195 — the start mode holds boot back", () => {
  it("with no settings file, boot starts Claude exactly as before", async () => {
    const { sup } = makeSupervisor();
    await sup.start();
    await nthChild(1);
    expect(sup.status().running).toBe(true);
  });

  it("on-click: boot spawns nothing and reads as awaiting-start, not restarting or failed", async () => {
    writeLauncherSettingsFile({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    const { sup } = makeSupervisor();
    await sup.start();
    await settle();
    expect(children).toHaveLength(0);
    expect(sup.status()).toEqual({
      running: false,
      standby: "awaiting-start",
      startsOnMessage: true,
    });
  });

  it("off: boot spawns nothing and reads as off", async () => {
    writeLauncherSettingsFile({ startMode: "off", lifetime: "always", idleMinutes: 30 });
    const { sup } = makeSupervisor();
    await sup.start();
    await settle();
    expect(children).toHaveLength(0);
    expect(sup.status()).toEqual({ running: false, standby: "off", startsOnMessage: true });
  });

  it("an unreadable settings file holds boot back rather than defaulting to auto", async () => {
    fs.writeFileSync(path.join(baseDir, "launcher-settings.json"), "{ truncated");
    const { sup } = makeSupervisor();
    await sup.start();
    await settle();
    expect(children).toHaveLength(0);
    expect(sup.status()).toEqual({
      running: false,
      standby: "awaiting-start",
      startsOnMessage: true,
    });
  });

  it("decides the standby even with no integration yet, so the chip is Start once setup writes one", async () => {
    writeLauncherSettingsFile({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    fs.writeFileSync(
      path.join(baseDir, "integrations.json"),
      JSON.stringify({ schemaVersion: 3, integrations: [] }),
    );
    const { sup } = makeSupervisor();
    await sup.start();
    expect(sup.status()).toMatchObject({ running: false, configured: false });
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
    await sup.refreshConfigured();
    expect(sup.status()).toEqual({
      running: false,
      standby: "awaiting-start",
      startsOnMessage: true,
    });
  });

  it("a crash restart whose settings read fails keeps the last good settings, not the fallback", async () => {
    // A held or half-written file for a moment says nothing about what the user
    // chose: the restarted Claude keeps its idle lifetime rather than the
    // fallback's "always".
    writeLauncherSettingsFile({ startMode: "auto", lifetime: "idle", idleMinutes: 1 });
    const { sup } = makeSupervisor({ idleMinuteMs: 40 });
    await sup.start();
    const child1 = await nthChild(1);
    fs.writeFileSync(path.join(baseDir, "launcher-settings.json"), "{ truncated");
    exitChild(child1, 1);
    const child2 = await nthChild(2);
    // Resumed with nothing owed, so it writes no turn and its idle clock starts
    // at spawn — and only an idle lifetime ends it.
    await waitFor(() => child2.killed, "the restarted child's idle stop");
    expect(sup.status()).toEqual({ running: false, standby: "idle", startsOnMessage: true });
  });

  it("on-click holds only boot: a crash restart of a Claude the user started brings it back", async () => {
    writeLauncherSettingsFile({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    const { sup } = makeSupervisor();
    await sup.start();
    await sup.startByUser();
    exitChild(await nthChild(1), 1);
    await nthChild(2);
    expect(sup.status().running).toBe(true);
  });
});

describe("#2195 — Start (startByUser)", () => {
  it("starts from awaiting-start", async () => {
    writeLauncherSettingsFile({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    const { sup } = makeSupervisor();
    await sup.start();
    expect(await sup.startByUser()).toEqual({ spawned: true });
    await nthChild(1);
    expect(sup.status().running).toBe(true);
    // The mode was not off, so Start leaves it alone.
    expect(readLauncherSettingsFile().startMode).toBe("on-click");
  });

  it("from off, starts Claude and saves the mode as on-click (Bryan, 2026-10-13)", async () => {
    writeLauncherSettingsFile({ startMode: "off", lifetime: "always", idleMinutes: 30 });
    const { sup } = makeSupervisor();
    await sup.start();
    await sup.startByUser();
    await nthChild(1);
    expect(readLauncherSettingsFile().startMode).toBe("on-click");
  });

  it("from off over an unreadable file, keeps the lifetime it last read — on disk and in the child", async () => {
    writeLauncherSettingsFile({ startMode: "off", lifetime: "idle", idleMinutes: 1 });
    const { sup } = makeSupervisor({ idleMinuteMs: 40 });
    await sup.start();
    fs.writeFileSync(path.join(baseDir, "launcher-settings.json"), "{ truncated");
    await sup.startByUser();
    const child1 = await nthChild(1);
    expect(readLauncherSettingsFile()).toMatchObject({
      startMode: "on-click",
      lifetime: "idle",
      idleMinutes: 1,
    });
    expect(sup.appliedSettings()).toEqual({
      startMode: "on-click",
      lifetime: "idle",
      idleMinutes: 1,
    });
    // The child runs by "stop when idle", not the fallback's "always".
    pushJson(child1, RESULT_OK);
    await waitFor(() => child1.killed, "the idle stop");
  });

  it("a relaunch from off saves on-click too, so Settings never says Off beside a running Claude", async () => {
    writeLauncherSettingsFile({ startMode: "off", lifetime: "always", idleMinutes: 30 });
    const { sup } = makeSupervisor();
    await sup.start();
    await sup.relaunch();
    await nthChild(1);
    expect(readLauncherSettingsFile().startMode).toBe("on-click");
  });

  it("is a no-op beside a live child — it never relaunches a running Claude", async () => {
    const { sup } = makeSupervisor();
    await sup.start();
    const child1 = await nthChild(1);
    expect(await sup.startByUser()).toEqual({ spawned: true });
    await settle();
    expect(children).toHaveLength(1);
    expect(child1.killed).toBe(false);
  });

  it("a licence refusal changes nothing, the saved mode included", async () => {
    writeLauncherSettingsFile({ startMode: "off", lifetime: "always", idleMinutes: 30 });
    const { sup } = makeSupervisor({ aiRefusal: () => LICENCE_REFUSAL });
    await sup.start();
    await expect(sup.startByUser()).rejects.toBeInstanceOf(LicenseRefusedError);
    expect(children).toHaveLength(0);
    expect(readLauncherSettingsFile().startMode).toBe("off");
  });
});

describe("#2195 — turning Claude off (updateSettings startMode off)", () => {
  it("stops a running Claude, schedules no restart, and reads as off with no error", async () => {
    const { sup } = makeSupervisor();
    await sup.start();
    const child1 = await nthChild(1);
    await sup.updateSettings({ startMode: "off" });
    expect(child1.killed).toBe(true);
    await sleep(50);
    await settle();
    expect(children).toHaveLength(1);
    expect(occurrences("Restarting Claude in")).toBe(0);
    expect(sup.status()).toEqual({ running: false, standby: "off", startsOnMessage: true });
    expect(readLauncherSettingsFile()).toMatchObject({ startMode: "off", lifetime: "always" });
  });

  it("cancels a crash restart that is only scheduled", async () => {
    const { sup } = makeSupervisor({ restartBackoffsMs: [150] });
    await sup.start();
    exitChild(await nthChild(1), 1);
    await settle();
    expect(sup.status()).toMatchObject({ running: false, restartPending: true });
    await sup.updateSettings({ startMode: "off" });
    await sleep(300);
    await settle();
    expect(children).toHaveLength(1);
    expect(sup.status()).toEqual({ running: false, standby: "off", startsOnMessage: true });
  });

  it("cancels a crash restart suspended in its plan read", async () => {
    const { sup } = makeSupervisor();
    await sup.start();
    const read = deferred<string>();
    const reads = interceptIntegrationsReads((n, pass) => (n === 1 ? read.promise : pass()));
    try {
      exitChild(await nthChild(1), 1);
      await waitFor(() => reads.count() === 1, "the restart's integrations read");
      await sup.updateSettings({ startMode: "off" });
      read.resolve(fs.readFileSync(path.join(baseDir, "integrations.json"), "utf8"));
      await sleep(50);
      await settle();
    } finally {
      reads.restore();
    }
    expect(children).toHaveLength(1);
    expect(sup.status()).toEqual({ running: false, standby: "off", startsOnMessage: true });
  });

  it("a crash restart while off never starts Claude, even if the off came first in the file only", async () => {
    // Off written by another path (a second window, a hand edit) between
    // spawns: the restart's own plan read is what holds it back.
    const { sup } = makeSupervisor();
    await sup.start();
    writeLauncherSettingsFile({ startMode: "off", lifetime: "always", idleMinutes: 30 });
    exitChild(await nthChild(1), 1);
    await sleep(50);
    await settle();
    expect(children).toHaveLength(1);
    expect(sup.status()).toEqual({ running: false, standby: "off", startsOnMessage: true });
  });

  it("licence activation does not bring back a Claude the user turned off", async () => {
    let refused = true;
    const { sup } = makeSupervisor({ aiRefusal: () => (refused ? LICENCE_REFUSAL : null) });
    await sup.start();
    expect(sup.licenceRefusal()).not.toBeNull();
    await sup.updateSettings({ startMode: "off" });
    refused = false;
    await sup.resumeAfterLicence();
    await settle();
    expect(children).toHaveLength(0);
  });

  it("owes nothing for what arrives while off (#1866): Start resumes with no turn", async () => {
    const { sup, emit } = makeSupervisor();
    await sup.startFresh(cwdDir);
    pushJson(children[0], RESULT_OK);
    await settle();
    await sup.updateSettings({ startMode: "off" });
    // A new comment, not a chat: a chat now starts Claude by itself (#2196).
    emit(annotationEvent());
    await settle();
    expect(children).toHaveLength(1);
    await sup.startByUser();
    const child2 = await nthChild(2);
    await settle();
    expect(texts(child2)).toEqual([]);
  });

  it("switching the mode back on does not start Claude by itself", async () => {
    writeLauncherSettingsFile({ startMode: "off", lifetime: "always", idleMinutes: 30 });
    const { sup } = makeSupervisor();
    await sup.start();
    await sup.updateSettings({ startMode: "auto" });
    await settle();
    expect(children).toHaveLength(0);
    expect(sup.status()).toEqual({
      running: false,
      standby: "awaiting-start",
      startsOnMessage: true,
    });
  });

  it("merges a partial patch: a lifetime change keeps the saved start mode", async () => {
    writeLauncherSettingsFile({ startMode: "off", lifetime: "always", idleMinutes: 30 });
    const { sup } = makeSupervisor();
    await sup.start();
    await sup.updateSettings({ lifetime: "idle" });
    expect(readLauncherSettingsFile()).toMatchObject({
      startMode: "off",
      lifetime: "idle",
      idleMinutes: 30,
    });
  });
});

describe("#2195 — stopping while idle", () => {
  const IDLE = { startMode: "auto", lifetime: "idle", idleMinutes: 1 } as const;
  /** One configured "minute" lasts this many ms in these tests. */
  const MINUTE = 40;

  it("never stops mid-turn; stops one idle period after the turn's result", async () => {
    writeLauncherSettingsFile(IDLE);
    const { sup } = makeSupervisor({ idleMinuteMs: MINUTE });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    // The bootstrap turn is in flight: well past the limit, still running.
    await sleep(MINUTE * 3);
    expect(child1.killed).toBe(false);
    pushJson(child1, RESULT_OK);
    await waitFor(() => child1.killed, "the idle stop");
    await sleep(50);
    await settle();
    expect(children).toHaveLength(1);
    expect(occurrences("Restarting Claude in")).toBe(0);
    expect(sup.status()).toEqual({ running: false, standby: "idle", startsOnMessage: true });
  });

  it("starts the clock at spawn when a resumed spawn writes no turn", async () => {
    writeLauncherSettingsFile(IDLE);
    const { sup } = makeSupervisor({ idleMinuteMs: MINUTE });
    await sup.startFresh(cwdDir);
    pushJson(children[0], RESULT_OK);
    await waitFor(() => children[0].killed, "the first idle stop");
    await settle();
    await sup.startByUser();
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([]);
    await waitFor(() => child2.killed, "the resumed spawn's idle stop");
  });

  it("an event resets the clock: the wake turn runs, and the clock restarts at its result", async () => {
    writeLauncherSettingsFile({ ...IDLE, idleMinutes: 3 });
    const { sup, emit } = makeSupervisor({ idleMinuteMs: MINUTE });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, RESULT_OK);
    await settle();
    await sleep(MINUTE * 2);
    emit(chatEvent());
    await sleep(MINUTE * 2);
    // 4 "minutes" since the bootstrap result, but a turn is in flight.
    expect(child1.killed).toBe(false);
    pushJson(child1, RESULT_OK);
    await waitFor(() => child1.killed, "the idle stop after the wake");
  });

  it("what the user sends while idle-stopped is owed: Start resumes with a wake turn", async () => {
    writeLauncherSettingsFile(IDLE);
    const { sup, emit } = makeSupervisor({ idleMinuteMs: MINUTE });
    await sup.startFresh(cwdDir);
    pushJson(children[0], RESULT_OK);
    await waitFor(() => children[0].killed, "the idle stop");
    await settle();
    emit(chatEvent());
    await sup.startByUser();
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("an event during the stop's SIGTERM grace is never written into the dying child", async () => {
    writeLauncherSettingsFile(IDLE);
    let releaseExit: (() => void) | null = null;
    onSpawn = (child, index) => {
      if (index !== 0) return;
      // Hold child 1's exit until the test lets it go.
      child.kill = (sig: NodeJS.Signals = "SIGTERM") => {
        child.kills.push(sig);
        child.killed = true;
        releaseExit = () => {
          child.signalCode = sig;
          child.emit("exit", null, sig);
        };
        return true;
      };
    };
    const { sup, emit } = makeSupervisor({ idleMinuteMs: MINUTE });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, RESULT_OK);
    await waitFor(() => child1.killed, "the idle stop's kill");
    const writesBefore = child1.stdin.writes.length;
    emit(chatEvent());
    expect(child1.stdin.writes).toHaveLength(writesBefore);
    (releaseExit as (() => void) | null)?.();
    await settle();
    await sup.startByUser();
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("does not count toward the crash breaker", async () => {
    writeLauncherSettingsFile(IDLE);
    const { sup } = makeSupervisor({ idleMinuteMs: 5 });
    for (let i = 0; i < 12; i++) {
      if (i === 0) await sup.startFresh(cwdDir);
      else await sup.startByUser();
      const child = await nthChild(i + 1);
      pushJson(child, RESULT_OK);
      await waitFor(() => child.killed, `idle stop ${i + 1}`);
      await settle();
    }
    expect(occurrences("Restarting Claude in")).toBe(0);
    expect(occurrences("Circuit breaker tripped")).toBe(0);
    expect(sup.status()).toEqual({ running: false, standby: "idle", startsOnMessage: true });
  });

  it("a Settings change to idle arms the clock on the running child; back to always cancels it", async () => {
    const { sup } = makeSupervisor({ idleMinuteMs: MINUTE });
    await sup.startFresh(cwdDir);
    const child1 = children[0];
    pushJson(child1, RESULT_OK);
    await settle();
    await sup.updateSettings({ lifetime: "idle", idleMinutes: 2 });
    await sup.updateSettings({ lifetime: "always" });
    await sleep(MINUTE * 4);
    expect(child1.killed).toBe(false);
    await sup.updateSettings({ lifetime: "idle", idleMinutes: 1 });
    await waitFor(() => child1.killed, "the idle stop after switching to idle");
  });
});

describe("#2195 — review fixes", () => {
  it("Off still stops Claude when the mode cannot be saved (a file from a newer Tandem)", async () => {
    const { sup } = makeSupervisor();
    await sup.start();
    const child1 = await nthChild(1);
    fs.writeFileSync(
      path.join(baseDir, "launcher-settings.json"),
      JSON.stringify({ version: 2, startMode: "auto" }),
    );
    await expect(sup.updateSettings({ startMode: "off" })).rejects.toThrow(/newer Tandem/);
    expect(child1.killed).toBe(true);
    expect(sup.status()).toEqual({ running: false, standby: "off", startsOnMessage: true });
  });

  it("a lifetime change while the file is unreadable keeps the real start mode, not the fallback's on-click", async () => {
    writeLauncherSettingsFile({ startMode: "auto", lifetime: "always", idleMinutes: 30 });
    const { sup } = makeSupervisor();
    await sup.start();
    await nthChild(1);
    fs.writeFileSync(path.join(baseDir, "launcher-settings.json"), "{ truncated");
    await sup.updateSettings({ lifetime: "idle" });
    expect(readLauncherSettingsFile()).toMatchObject({ startMode: "auto", lifetime: "idle" });
  });

  it("the boot settings read counts as starting, never as a plain stopped launcher", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sup } = makeSupervisor({
      readSettings: async () => {
        await held;
        return {
          source: "default",
          settings: { startMode: "on-click", lifetime: "always", idleMinutes: 30 },
        };
      },
    });
    const booting = sup.start();
    await settle();
    expect(sup.status()).toMatchObject({ running: false, restartPending: true });
    release();
    await booting;
    expect(sup.status()).toEqual({
      running: false,
      standby: "awaiting-start",
      startsOnMessage: true,
    });
  });

  it("a lifetime change that lands while a crash restart reads its plan reaches the restarted child", async () => {
    const { sup } = makeSupervisor({ idleMinuteMs: 40 });
    await sup.start();
    const read = deferred<string>();
    const reads = interceptIntegrationsReads((n, pass) => (n === 1 ? read.promise : pass()));
    let child2: FakeChild;
    try {
      exitChild(await nthChild(1), 1);
      await waitFor(() => reads.count() === 1, "the restart's integrations read");
      // No child is alive, so nothing can take the new idle limit but the spawn.
      await sup.updateSettings({ lifetime: "idle", idleMinutes: 1 });
      read.resolve(fs.readFileSync(path.join(baseDir, "integrations.json"), "utf8"));
      child2 = await nthChild(2);
    } finally {
      reads.restore();
    }
    await waitFor(() => child2.killed, "the restarted child's idle stop");
  });
});

// --- #2196 ----------------------------------------------------------------------

function replyEvent(parentAuthor: "user" | "claude" | "import", replyAuthor = "user"): TandemEvent {
  eventSeq++;
  return {
    id: `evt_${eventSeq}`,
    type: "annotation:reply",
    timestamp: Date.now(),
    documentId: "d1",
    payload: {
      annotationId: `ann_${eventSeq}`,
      replyId: `rep_${eventSeq}`,
      replyText: "yes, do that",
      replyAuthor,
      textSnippet: "x",
      parentAuthor,
    },
  } as TandemEvent;
}

/** Rewrite integrations.json: `[]` for none, `null` for the default entry. */
function writeIntegrations(list: [] | null): void {
  const file = {
    schemaVersion: 3,
    integrations: list ?? [
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
  fs.writeFileSync(path.join(baseDir, "integrations.json"), JSON.stringify(file));
}

/** A supervisor whose Claude ran once (so it has a saved session) and is now
 * in the given standby, with nothing owed. */
async function stoppedByChoice(
  kind: "off" | "idle" | "awaiting-start",
  extra: ExtraOpts = {},
): Promise<ReturnType<typeof makeSupervisor>> {
  if (kind === "awaiting-start") {
    writeLauncherSettingsFile({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    const made = makeSupervisor(extra);
    await made.sup.start();
    return made;
  }
  const idle = kind === "idle";
  writeLauncherSettingsFile({
    startMode: "auto",
    lifetime: idle ? "idle" : "always",
    idleMinutes: 1,
  });
  const made = makeSupervisor({ idleMinuteMs: 40, ...extra });
  await made.sup.startFresh(cwdDir);
  pushJson(children[0], RESULT_OK);
  await settle();
  if (idle) await waitFor(() => children[0].killed, "the idle stop");
  else await made.sup.updateSettings({ startMode: "off" });
  await settle();
  expect(made.sup.status()).toMatchObject({ running: false, standby: kind });
  return made;
}

describe("#2196 — a message starts a Claude that is stopped by choice", () => {
  it.each(["off", "idle"] as const)(
    "%s: a chat starts Claude, resumes the saved session and writes the wake turn",
    async (kind) => {
      const { sup, emit } = await stoppedByChoice(kind);
      expect(children).toHaveLength(1);
      emit(chatEvent());
      const child2 = await nthChild(2);
      await waitFor(() => texts(child2).length > 0, "the wake turn");
      expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
      expect(sup.status().running).toBe(true);
    },
  );

  it("awaiting-start: a chat before the first Start starts Claude", async () => {
    const { sup, emit } = await stoppedByChoice("awaiting-start");
    expect(children).toHaveLength(0);
    emit(chatEvent());
    await nthChild(1);
    await waitFor(() => sup.status().running, "running");
  });

  it("from off, the saved mode becomes on-click (Bryan, 2026-10-13)", async () => {
    const { emit } = await stoppedByChoice("off");
    emit(chatEvent());
    await nthChild(2);
    expect(readLauncherSettingsFile().startMode).toBe("on-click");
  });

  it("a user's reply on Claude's comment starts it", async () => {
    const { emit } = await stoppedByChoice("off");
    emit(replyEvent("claude"));
    await nthChild(2);
  });

  it.each([
    ["a reply on a user-authored parent", () => replyEvent("user")],
    ["a reply on an imported Word comment", () => replyEvent("import")],
    ["Claude's own reply", () => replyEvent("claude", "claude")],
    ["a new comment", () => annotationEvent()],
  ])("%s does not start it", async (_label, make) => {
    const { sup, emit } = await stoppedByChoice("off");
    emit(make());
    await sleep(30);
    await settle();
    expect(children).toHaveLength(1);
    expect(sup.status()).toMatchObject({ running: false, standby: "off" });
  });

  it("the status reads as starting from the moment the message lands", async () => {
    const { sup, emit } = await stoppedByChoice("idle");
    const read = deferred<string>();
    const reads = interceptIntegrationsReads((n, pass) => (n === 1 ? read.promise : pass()));
    try {
      emit(chatEvent());
      // Synchronously, before the start has even taken the lock.
      expect(sup.status()).toMatchObject({ restartPending: true, standby: "idle" });
      read.resolve(fs.readFileSync(path.join(baseDir, "integrations.json"), "utf8"));
    } finally {
      reads.restore();
    }
    await nthChild(2);
  });

  it("a declined start clears the pending status", async () => {
    let other = false;
    const { sup, emit } = await stoppedByChoice("off", { otherAiAttached: () => other });
    emit(chatEvent());
    // Clear when the message landed; attached by the time its start runs
    // (the lock body runs on a later microtask).
    other = true;
    expect(sup.status()).toMatchObject({ restartPending: true });
    await waitFor(() => !("restartPending" in sup.status()), "the pending flag to clear");
    expect(children).toHaveLength(1);
  });

  it("a burst of messages makes exactly one spawn", async () => {
    const { emit } = await stoppedByChoice("idle");
    for (let i = 0; i < 5; i++) emit(chatEvent());
    await nthChild(2);
    await sleep(30);
    await settle();
    expect(children).toHaveLength(2);
  });

  it("once Claude is running, a chat is a wake to it, not another start", async () => {
    const { emit } = await stoppedByChoice("off");
    emit(chatEvent());
    const child2 = await nthChild(2);
    await waitFor(() => texts(child2).length === 1, "the wake turn");
    pushJson(child2, RESULT_OK);
    await settle();
    emit(chatEvent());
    await settle();
    expect(children).toHaveLength(2);
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT, SUPERVISOR_WAKE_PROMPT]);
  });

  it("not while another AI is attached (Bryan: 'Not if another AI is on')", async () => {
    let other = true;
    const seen: Array<ReadonlySet<string>> = [];
    const { sup, emit } = await stoppedByChoice("off", {
      otherAiAttached: (own) => {
        seen.push(own);
        return other;
      },
    });
    emit(chatEvent());
    await sleep(30);
    await settle();
    expect(children).toHaveLength(1);
    // The check is told Tandem's own last session, so that child's leftover
    // entry is not mistaken for someone else's.
    expect([...(seen.at(-1) ?? [])]).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(sup.status()).toEqual({ running: false, standby: "off" });
    // The declined message is not owed either: a later Start writes no turn.
    other = false;
    await sup.startByUser();
    const child2 = await nthChild(2);
    await settle();
    expect(texts(child2)).toEqual([]);
  });

  it("every child it spawned counts as its own, not only the last — a start-fresh leaves no 'other AI'", async () => {
    // The first child's entry is still live (a stopped child's lingers up to a
    // minute); anything live outside the set reads as another AI.
    const live: string[] = [];
    const { sup, emit } = makeSupervisor({
      otherAiAttached: (own) => live.some((id) => !own.has(id)),
    });
    await sup.startFresh(cwdDir);
    const first = sup.status();
    if (!first.running) throw new Error("not running");
    live.push(first.sessionId);
    await sup.startFresh(cwdDir);
    await nthChild(2);
    await sup.updateSettings({ startMode: "off" });
    emit(chatEvent());
    await nthChild(3);
  });

  it("another AI attaching before the start gets the lock still stops it", async () => {
    let calls = 0;
    const { emit } = await stoppedByChoice("off", {
      // Clear when the message arrives, attached by the time the start runs.
      otherAiAttached: () => ++calls > 1,
    });
    calls = 0;
    emit(chatEvent());
    await sleep(30);
    await settle();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(children).toHaveLength(1);
  });

  it("a message that waits behind the user's own Start is still owed to that spawn", async () => {
    const { sup, emit } = await stoppedByChoice("idle");
    const read = deferred<string>();
    const reads = interceptIntegrationsReads((n, pass) => (n === 1 ? read.promise : pass()));
    try {
      const started = sup.startByUser();
      await waitFor(() => reads.count() === 1, "Start's plan read");
      // Start holds the lock and has not spawned: the chat's own start queues
      // behind it, and the chat must ride on Start's spawn.
      emit(chatEvent());
      read.resolve(fs.readFileSync(path.join(baseDir, "integrations.json"), "utf8"));
      await started;
    } finally {
      reads.restore();
    }
    const child2 = await nthChild(2);
    await waitFor(() => texts(child2).length > 0, "the wake turn");
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    await sleep(30);
    expect(children).toHaveLength(2);
  });

  it("a licence refusal starts nothing and does not loop; a later message tries again", async () => {
    let refused = false;
    const { sup, emit } = await stoppedByChoice("off", {
      aiRefusal: () => (refused ? LICENCE_REFUSAL : null),
    });
    refused = true;
    // Before any attempt, the status already says a message would not start it.
    expect(sup.status()).toEqual({ running: false, standby: "off" });
    emit(chatEvent());
    await sleep(30);
    await settle();
    expect(children).toHaveLength(1);
    expect(occurrences("Could not start Claude for the message: unlicensed")).toBe(1);
    expect(readLauncherSettingsFile().startMode).toBe("off");
    refused = false;
    emit(chatEvent());
    await nthChild(2);
  });

  it("with no integration, a chat starts nothing and leaves the mode alone", async () => {
    const { emit } = await stoppedByChoice("off");
    writeIntegrations([]);
    emit(chatEvent());
    await waitFor(
      () => occurrences("Could not start Claude for the message: no-integration") === 1,
      "the no-integration log",
    );
    expect(children).toHaveLength(1);
    expect(readLauncherSettingsFile().startMode).toBe("off");
  });

  it.each([
    ["finds no integration", () => writeIntegrations([])],
    ["throws reading its plan", null],
  ] as const)(
    "a Start from off that %s owes nothing to a later spawn (#1866)",
    async (_label, breakIt) => {
      const { sup, emit } = await stoppedByChoice("off");
      if (breakIt) {
        breakIt();
        expect(await sup.startByUser()).toEqual({ spawned: false, why: "no-integration" });
      } else {
        const reads = interceptIntegrationsReads(() => Promise.reject(new Error("boom")));
        try {
          await expect(sup.startByUser()).rejects.toThrow("boom");
        } finally {
          reads.restore();
        }
      }
      // Still off: a new comment is owed to nothing.
      emit(annotationEvent());
      writeIntegrations(null);
      await sup.startByUser();
      const child2 = await nthChild(2);
      await settle();
      expect(texts(child2)).toEqual([]);
    },
  );

  it("a plan read that throws leaves a visible failure, not a silent Start chip", async () => {
    const { sup, emit } = await stoppedByChoice("off");
    const reads = interceptIntegrationsReads(() => Promise.reject(new Error("boom")));
    try {
      emit(chatEvent());
      await waitFor(() => sup.status().lastError, "lastError");
    } finally {
      reads.restore();
    }
    expect(sup.status()).toMatchObject({ running: false, lastError: "spawn-failed" });
    expect(sup.status()).not.toHaveProperty("standby");
  });

  it("after the public stop() (shutdown), a message starts nothing", async () => {
    const { sup, emit } = await stoppedByChoice("idle");
    await sup.stop();
    emit(chatEvent());
    await sleep(30);
    await settle();
    expect(children).toHaveLength(1);
  });

  it("a message that queued behind shutdown's stop() starts nothing", async () => {
    const { sup, emit } = await stoppedByChoice("idle");
    const stopping = sup.stop();
    emit(chatEvent());
    await stopping;
    await sleep(30);
    await settle();
    expect(children).toHaveLength(1);
  });

  it("a Turn off that takes the lock between the message and its start still leaves the message owed", async () => {
    const { sup, emit } = await stoppedByChoice("idle");
    // Off queues first; the chat's start queues behind it.
    const off = sup.updateSettings({ startMode: "off" });
    emit(chatEvent());
    await off;
    // The message still starts Claude from off, and the start still answers it.
    const child2 = await nthChild(2);
    await waitFor(() => texts(child2).length > 0, "the wake turn");
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("from off, a message that arrives before the user's own Start rides on that Start's spawn", async () => {
    const { sup, emit } = await stoppedByChoice("off");
    // Hold the lock with a plan read, so Start and the message's start both
    // queue behind it — Start first, before it has armed anything.
    const read = deferred<string>();
    const reads = interceptIntegrationsReads((n, pass) => (n === 1 ? read.promise : pass()));
    try {
      const holding = sup.refreshConfigured();
      await waitFor(() => reads.count() === 1, "the held plan read");
      const started = sup.startByUser();
      emit(chatEvent());
      read.resolve(fs.readFileSync(path.join(baseDir, "integrations.json"), "utf8"));
      await holding;
      await started;
    } finally {
      reads.restore();
    }
    const child2 = await nthChild(2);
    await waitFor(() => texts(child2).length > 0, "the wake turn");
    expect(texts(child2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    await sleep(30);
    expect(children).toHaveLength(2);
  });

  it("a message start queued AHEAD of shutdown's stop() spawns nothing", async () => {
    const { sup, emit } = await stoppedByChoice("idle");
    const read = deferred<string>();
    const reads = interceptIntegrationsReads((n, pass) => (n === 1 ? read.promise : pass()));
    let stopping: Promise<void>;
    try {
      const holding = sup.refreshConfigured();
      await waitFor(() => reads.count() === 1, "the held plan read");
      emit(chatEvent()); // queued first
      stopping = sup.stop(); // queued second
      read.resolve(fs.readFileSync(path.join(baseDir, "integrations.json"), "utf8"));
      await holding;
      await stopping;
    } finally {
      reads.restore();
    }
    await sleep(30);
    await settle();
    expect(children).toHaveLength(1);
    // And an Off after shutdown arms nothing either.
    await sup.updateSettings({ startMode: "off" });
    emit(chatEvent());
    await sleep(30);
    await settle();
    expect(children).toHaveLength(1);
  });

  it("a message never starts a Claude whose crash breaker tripped; Start does, and resets it", async () => {
    const { sup, emit } = makeSupervisor({ restartBackoffsMs: [0] });
    await sup.startFresh(cwdDir);
    for (let n = 1; ; n++) {
      exitChild(children[n - 1], 1);
      const st = sup.status();
      if (!st.running && st.lastError !== undefined) break;
      await nthChild(n + 1);
      await waitFor(() => sup.status().running, `restart ${n}`);
    }
    expect(sup.status()).toMatchObject({ running: false, lastError: "circuit-open" });
    // The user turns it off. Nothing promises that a chat starts it…
    await sup.updateSettings({ startMode: "off" });
    expect(sup.status()).toEqual({ running: false, standby: "off" });
    // …and a chat does not.
    const before = children.length;
    emit(chatEvent());
    await sleep(50);
    await settle();
    expect(children).toHaveLength(before);
    // Start does, and clears the breaker: its next crash is restarted.
    await sup.startByUser();
    const next = await nthChild(before + 1);
    exitChild(next, 1);
    await nthChild(before + 2);
  });

  it("status never promises a message start once shutdown has begun", async () => {
    const { sup } = await stoppedByChoice("off", { otherAiAttached: () => false });
    // While the stop is still running, as well as after it.
    const stopping = sup.stop();
    expect(sup.status()).not.toHaveProperty("startsOnMessage");
    await stopping;
    expect(sup.status()).not.toHaveProperty("startsOnMessage");
  });

  it("status says a message would start Claude only in standby with nothing in the way", async () => {
    const { sup } = await stoppedByChoice("off", { otherAiAttached: () => false });
    expect(sup.status()).toEqual({ running: false, standby: "off", startsOnMessage: true });
  });
});

describe("#2196 — the standby watch's DEFAULT subscription, against the real queue", () => {
  // No `subscribeDuringStandby` seam here: the default is what production runs,
  // and the Solo hold is decided by the queue before any fan-out.
  async function offWithRealQueue(): Promise<Supervisor> {
    resetForTesting();
    writeLauncherSettingsFile({ startMode: "off", lifetime: "always", idleMinutes: 30 });
    const sup = createSupervisor({
      probeCliUsable: () => true,
      resolveClaudeCommand: () => process.execPath,
      restartBackoffsMs: [0],
      integrationsBase: baseDir,
      subscribeToEvents: () => () => {},
      subscribeDuringGap: () => () => {},
    });
    sups.push(sup);
    await sup.start();
    expect(sup.status()).toMatchObject({ standby: "off" });
    return sup;
  }

  afterEach(() => setCtrlMode("tandem"));

  it("in Solo, a user's reply on Claude's comment is held and starts nothing; a chat still does", async () => {
    await offWithRealQueue();
    setCtrlMode("solo");
    _pushEventForTests(replyEvent("claude"));
    await sleep(30);
    await settle();
    expect(children).toHaveLength(0);
    _pushEventForTests(chatEvent());
    await nthChild(1);
  });

  it("in Tandem mode, the same reply starts Claude", async () => {
    await offWithRealQueue();
    setCtrlMode("tandem");
    _pushEventForTests(replyEvent("claude"));
    await nthChild(1);
  });
});

// --- #2197 ----------------------------------------------------------------------

describe("#2197 — startAfterSetup: a wizard Apply starts Tandem's Claude when it should", () => {
  /** Boot with no integration (the first-run state), then write one. */
  async function firstRunSupervisor(extra: ExtraOpts = {}, settings?: Record<string, unknown>) {
    if (settings) writeLauncherSettingsFile(settings);
    writeIntegrations([]);
    const made = makeSupervisor(extra);
    await made.sup.start();
    expect(made.sup.status()).toMatchObject({ running: false, configured: false });
    writeIntegrations(null);
    return made;
  }

  it("auto, never configured: starts, fresh, and answers 'starting'", async () => {
    const { sup } = await firstRunSupervisor();
    expect(await sup.startAfterSetup()).toBe("starting");
    const child = await nthChild(1);
    await waitFor(() => sup.status().running, "running");
    expect(texts(child)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
  });

  it.each([
    ["on-click", { startMode: "on-click", lifetime: "always", idleMinutes: 30 }],
    ["off", { startMode: "off", lifetime: "always", idleMinutes: 30 }],
  ])("%s: holds — an Apply is not a Start", async (_l, settings) => {
    const { sup } = await firstRunSupervisor({}, settings);
    expect(await sup.startAfterSetup()).toBe("held");
    await sleep(30);
    expect(children).toHaveLength(0);
  });

  it("a running Claude is left alone: 'running', no relaunch", async () => {
    const { sup } = makeSupervisor();
    await sup.start();
    const child1 = await nthChild(1);
    expect(await sup.startAfterSetup()).toBe("running");
    await sleep(30);
    expect(children).toHaveLength(1);
    expect(child1.killed).toBe(false);
  });

  it("idle-stopped is a choice too: held", async () => {
    const { sup } = await stoppedByChoice("idle");
    expect(await sup.startAfterSetup()).toBe("held");
    await sleep(30);
    expect(children).toHaveLength(1);
  });

  it("no usable entry: 'not-configured'", async () => {
    writeIntegrations([]);
    const { sup } = makeSupervisor();
    await sup.start();
    expect(await sup.startAfterSetup()).toBe("not-configured");
    expect(children).toHaveLength(0);
  });

  it("the licence refuses: 'refused', nothing spawned", async () => {
    const { sup } = await firstRunSupervisor({ aiRefusal: () => LICENCE_REFUSAL });
    expect(await sup.startAfterSetup()).toBe("refused");
    await sleep(30);
    expect(children).toHaveLength(0);
  });

  it("another AI is attached: 'other-ai', nothing spawned (#2196's rule)", async () => {
    const { sup } = await firstRunSupervisor({ otherAiAttached: () => true });
    expect(await sup.startAfterSetup()).toBe("other-ai");
    await sleep(30);
    expect(children).toHaveLength(0);
  });

  it("another AI attached AND the licence refusing: no refusal recorded, so activating starts nothing beside it", async () => {
    let refused = true;
    const { sup } = await firstRunSupervisor({
      aiRefusal: () => (refused ? LICENCE_REFUSAL : null),
      otherAiAttached: () => true,
    });
    expect(await sup.startAfterSetup()).toBe("other-ai");
    expect(sup.licenceRefusal()).toBeNull();
    refused = false;
    await sup.resumeAfterLicence();
    await sleep(30);
    expect(children).toHaveLength(0);
  });

  it("a sign-in stop (a tripped breaker) is a diagnosis: held, nothing spawned", async () => {
    const { sup } = makeSupervisor();
    await sup.startFresh(cwdDir);
    pushJson(children[0], {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    });
    await waitFor(() => !sup.status().running, "the sign-in stop");
    expect(await sup.startAfterSetup()).toBe("held");
    await sleep(30);
    expect(children).toHaveLength(1);
  });

  it("'refused' is recorded, so activating the licence starts it", async () => {
    let refused = true;
    const { sup } = await firstRunSupervisor({
      aiRefusal: () => (refused ? LICENCE_REFUSAL : null),
    });
    expect(await sup.startAfterSetup()).toBe("refused");
    expect(sup.licenceRefusal()).not.toBeNull();
    refused = false;
    await sup.resumeAfterLicence();
    await nthChild(1);
  });

  it("after shutdown's stop(): held", async () => {
    const { sup } = await firstRunSupervisor();
    await sup.stop();
    expect(await sup.startAfterSetup()).toBe("held");
    await sleep(30);
    expect(children).toHaveLength(0);
  });

  it("answers before the spawn finishes", async () => {
    const { sup } = await firstRunSupervisor();
    const read = deferred<string>();
    // Read 1 is the decision's plan; read 2 is the respawn's own plan.
    const reads = interceptIntegrationsReads((n, pass) => (n === 2 ? read.promise : pass()));
    try {
      expect(await sup.startAfterSetup()).toBe("starting");
      expect(children).toHaveLength(0);
      read.resolve(fs.readFileSync(path.join(baseDir, "integrations.json"), "utf8"));
    } finally {
      reads.restore();
    }
    await nthChild(1);
  });

  it("a start that throws after the decision is recorded, not rejected", async () => {
    const { sup } = await firstRunSupervisor();
    const reads = interceptIntegrationsReads((n, pass) =>
      n === 2 ? Promise.reject(new Error("boom")) : pass(),
    );
    try {
      expect(await sup.startAfterSetup()).toBe("starting");
      await waitFor(() => sup.status().lastError, "lastError");
    } finally {
      reads.restore();
    }
    expect(sup.status()).toMatchObject({ running: false, lastError: "spawn-failed" });
  });
});

describe("#2198 — the v1.0 walkthrough holds the boot start", () => {
  const settings = (startMode: string) => ({ startMode, lifetime: "always", idleMinutes: 30 });

  it("automatic, walkthrough owed: the boot waits in awaiting-start, and the confirm starts it", async () => {
    writeLauncherSettingsFile(settings("auto"));
    const { sup } = makeSupervisor({ walkthroughPending: () => true });
    await sup.start();
    await sleep(30);
    expect(children).toHaveLength(0);
    expect(sup.status()).toMatchObject({ running: false, standby: "awaiting-start" });
    expect(await sup.startAfterSetup()).toBe("starting");
    await nthChild(1);
  });

  it("control: nothing owed, the automatic boot starts as before", async () => {
    writeLauncherSettingsFile(settings("auto"));
    const { sup } = makeSupervisor({ walkthroughPending: () => false });
    await sup.start();
    await nthChild(1);
  });

  it("a read that throws does not hold the boot", async () => {
    writeLauncherSettingsFile(settings("auto"));
    const { sup } = makeSupervisor({
      walkthroughPending: () => {
        throw new Error("EACCES");
      },
    });
    await sup.start();
    await nthChild(1);
  });

  it("on-click kept through the walkthrough: the confirm starts nothing", async () => {
    writeLauncherSettingsFile(settings("on-click"));
    const { sup } = makeSupervisor({ walkthroughPending: () => true });
    await sup.start();
    expect(await sup.startAfterSetup()).toBe("held");
    await sleep(30);
    expect(children).toHaveLength(0);
  });

  it.each(["on-click", "off"])(
    "%s at boot, automatic chosen in the walkthrough: the confirm starts it",
    async (mode) => {
      writeLauncherSettingsFile(settings(mode));
      const { sup } = makeSupervisor({ walkthroughPending: () => true });
      await sup.start();
      await sup.updateSettings({ startMode: "auto" });
      expect(await sup.startAfterSetup()).toBe("starting");
      await nthChild(1);
    },
  );

  it("control: the same mode change with no walkthrough owed stays a #2195 hold", async () => {
    writeLauncherSettingsFile(settings("on-click"));
    const { sup } = makeSupervisor({ walkthroughPending: () => false });
    await sup.start();
    await sup.updateSettings({ startMode: "auto" });
    expect(await sup.startAfterSetup()).toBe("held");
    await sleep(30);
    expect(children).toHaveLength(0);
  });

  it("the hold is released once: a later Apply follows the ordinary rules", async () => {
    writeLauncherSettingsFile(settings("on-click"));
    const { sup } = makeSupervisor({ walkthroughPending: () => true });
    await sup.start();
    expect(await sup.startAfterSetup()).toBe("held"); // the confirm, on-click kept
    await sup.updateSettings({ startMode: "auto" });
    expect(await sup.startAfterSetup()).toBe("held");
    await sleep(30);
    expect(children).toHaveLength(0);
  });

  it("a confirm with no Claude Code setup keeps the hold: adding Claude Code later this launch starts it", async () => {
    // A Desktop-only user clicks Continue without connecting, then connects
    // Claude Code from Settings in the same launch.
    writeLauncherSettingsFile(settings("auto"));
    writeIntegrations([]);
    const { sup } = makeSupervisor({ walkthroughPending: () => true });
    await sup.start();
    expect(await sup.startAfterSetup()).toBe("not-configured");
    writeIntegrations(null);
    expect(await sup.startAfterSetup()).toBe("starting");
    await nthChild(1);
  });

  it("a chat during the walkthrough still starts Claude: the user asked (#2196)", async () => {
    writeLauncherSettingsFile(settings("auto"));
    const { sup, emit } = makeSupervisor({ walkthroughPending: () => true });
    await sup.start();
    expect(sup.status()).toMatchObject({ standby: "awaiting-start", startsOnMessage: true });
    emit(chatEvent());
    await nthChild(1);
  });
});

describe("#2197 — the one-time greeting", () => {
  function greetingSeam(owed = true) {
    const state = { owed, throws: false };
    const markDone = vi.fn(async () => {
      state.owed = false;
    });
    const replyCbs = new Set<(sessionId: string | undefined) => void>();
    const extra: ExtraOpts = {
      greeting: {
        isOwed: () => {
          if (state.throws) throw new Error("unreadable");
          return state.owed;
        },
        markDone,
      },
      subscribeTandemReply: (cb) => {
        replyCbs.add(cb);
        return () => replyCbs.delete(cb);
      },
    };
    /** A `tandem_reply` landed; no session id unless one is given. */
    const claudeWrote = (sessionId?: string) => {
      for (const cb of [...replyCbs]) cb(sessionId);
    };
    return { state, markDone, extra, claudeWrote };
  }

  it("a fresh spawn that owes the greeting sends it INSTEAD of the bootstrap", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    expect(texts(children[0])).toEqual([SUPERVISOR_GREETING_PROMPT]);
  });

  it("control: not owed, the ordinary bootstrap", async () => {
    const g = greetingSeam(false);
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    expect(texts(children[0])).toEqual([SUPERVISOR_INITIAL_PROMPT]);
  });

  it("an unreadable marker reads as not owed", async () => {
    const g = greetingSeam();
    g.state.throws = true;
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    expect(texts(children[0])).toEqual([SUPERVISOR_INITIAL_PROMPT]);
  });

  it("a resumed spawn that owes it sends it in place of the wake — one turn, not two", async () => {
    const g = greetingSeam(false);
    const { sup, emit } = makeSupervisor({ ...g.extra, idleMinuteMs: 40 });
    writeLauncherSettingsFile({ startMode: "auto", lifetime: "idle", idleMinutes: 1 });
    await sup.startFresh(cwdDir);
    pushJson(children[0], RESULT_OK);
    await waitFor(() => children[0].killed, "the idle stop");
    // Owed now — the v1.0 re-arm reaches a user with a saved session — and a
    // chat is owed too. The chat starts it (#2196).
    g.state.owed = true;
    emit(chatEvent());
    const child2 = await nthChild(2);
    await waitFor(() => texts(child2).length > 0, "the first turn");
    await settle();
    expect(texts(child2)).toEqual([SUPERVISOR_GREETING_PROMPT]);
  });

  it("a Claude chat message marks it done once; the next spawn gets the ordinary bootstrap", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    g.claudeWrote();
    g.claudeWrote();
    expect(g.markDone).toHaveBeenCalledTimes(1);
    pushJson(children[0], RESULT_OK);
    await settle();
    expect(sup.status()).not.toHaveProperty("greetingLate");
    await sup.startFresh(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
  });

  it("a reply from a session this supervisor did not spawn is not the greeting; its own child's is", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    const own = JSON.parse(
      fs.readFileSync(path.join(baseDir, "launcher-session.json"), "utf8"),
    ) as { sessionId: string };
    g.claudeWrote("someone-else");
    expect(g.markDone).not.toHaveBeenCalled();
    g.claudeWrote(own.sessionId);
    expect(g.markDone).toHaveBeenCalledTimes(1);
  });

  it("matches its own child's session id case-insensitively", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    const own = JSON.parse(
      fs.readFileSync(path.join(baseDir, "launcher-session.json"), "utf8"),
    ) as { sessionId: string };
    g.claudeWrote(own.sessionId.toUpperCase());
    expect(g.markDone).toHaveBeenCalledTimes(1);
  });

  it("in Solo the hello waits: the ordinary first turn, still owed, then greeted in Tandem mode", async () => {
    const g = greetingSeam();
    let solo = true;
    const { sup } = makeSupervisor({ ...g.extra, greetingHeldBySolo: () => solo });
    await sup.startFresh(cwdDir);
    expect(texts(children[0])).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    pushJson(children[0], RESULT_OK);
    await settle();
    expect(sup.status()).not.toHaveProperty("greetingLate");
    expect(g.state.owed).toBe(true);
    solo = false;
    await sup.startFresh(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_GREETING_PROMPT]);
  });

  it("a mode read that throws holds the hello too", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor({
      ...g.extra,
      greetingHeldBySolo: () => {
        throw new Error("ctrl doc gone");
      },
    });
    await sup.startFresh(cwdDir);
    expect(texts(children[0])).toEqual([SUPERVISOR_INITIAL_PROMPT]);
  });

  it("a marker write that fails cannot make this process greet twice", async () => {
    const g = greetingSeam();
    g.markDone.mockImplementation(async () => {
      throw new Error("EPERM");
    });
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    g.claudeWrote();
    await settle();
    // The file still says owed.
    expect(g.state.owed).toBe(true);
    await sup.startFresh(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
    expect(occurrences("Could not record that the greeting was sent")).toBe(1);
  });

  it("a greeting turn that ends with no chat message is late, but spent: never sent again", async () => {
    // "Once" must not hang on spotting the reply (a hello posted in a comment
    // thread, a session id we could not match): a miss would re-send it on
    // every later spawn.
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    expect(sup.status()).not.toHaveProperty("greetingLate");
    pushJson(children[0], RESULT_OK);
    await settle();
    expect(sup.status()).toMatchObject({ running: true, greetingLate: true });
    expect(g.markDone).toHaveBeenCalledTimes(1);
    expect(g.state.owed).toBe(false);
    // A later reply from the child still clears the note.
    g.claudeWrote();
    expect(sup.status()).not.toHaveProperty("greetingLate");
    expect(g.markDone).toHaveBeenCalledTimes(1);
    await sup.startFresh(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_INITIAL_PROMPT]);
  });

  it("the restart the note advises retires the note, though the hello is spent", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    pushJson(children[0], RESULT_OK);
    await settle();
    expect(sup.status()).toMatchObject({ greetingLate: true });
    await sup.relaunch(cwdDir);
    await nthChild(2);
    expect(sup.status()).not.toHaveProperty("greetingLate");
  });

  it("an errored greeting turn leaves it owed, and the next spawn greets", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    pushJson(children[0], { type: "result", subtype: "error_during_execution", is_error: true });
    await settle();
    expect(g.markDone).not.toHaveBeenCalled();
    await sup.startFresh(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_GREETING_PROMPT]);
    // A new greeting turn is pending again, not late.
    expect(sup.status()).not.toHaveProperty("greetingLate");
  });

  it("an error subtype with no is_error flag also leaves it owed", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    pushJson(children[0], { type: "result", subtype: "error_during_execution" });
    await settle();
    expect(g.markDone).not.toHaveBeenCalled();
  });

  it("a subtype this build doesn't know spends the greeting — never greet on every spawn", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    pushJson(children[0], { type: "result", subtype: "some_new_kind", is_error: false });
    await settle();
    expect(g.markDone).toHaveBeenCalled();
  });

  it("a malformed subtype on the greeting's result is survived, not thrown", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    pushJson(children[0], { type: "result", subtype: 42 });
    await settle();
    expect(g.markDone).toHaveBeenCalled();
    expect(sup.status().running).toBe(true);
  });

  it("a crash before the greeting turn ends: the crash restart does not greet again", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    exitChild(children[0], 1);
    const child2 = await nthChild(2);
    await settle();
    expect(texts(child2)).not.toContain(SUPERVISOR_GREETING_PROMPT);
    // Still owed on disk: the next Tandem launch tries again.
    expect(g.state.owed).toBe(true);
    await sup.stop();
  });

  it("a restart we asked for while the greeting is pending greets again", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    await sup.startFresh(cwdDir);
    const child2 = await nthChild(2);
    expect(texts(child2)).toEqual([SUPERVISOR_GREETING_PROMPT]);
  });

  it("no note while stopped by choice: Off after an unanswered greeting", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    pushJson(children[0], RESULT_OK);
    await settle();
    expect(sup.status()).toMatchObject({ greetingLate: true });
    await sup.updateSettings({ startMode: "off" });
    await settle();
    expect(sup.status()).toMatchObject({ running: false, standby: "off" });
    expect(sup.status()).not.toHaveProperty("greetingLate");
  });

  it("a resumed spawn owing both the greeting and a sign-in re-check writes one turn", async () => {
    const g = greetingSeam(false);
    const first = makeSupervisor(g.extra).sup;
    await first.startFresh(cwdDir);
    pushJson(children[0], {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    });
    await waitFor(() => !first.status().running, "the sign-in stop");
    await first.stop();
    g.state.owed = true;
    const { sup } = makeSupervisor(g.extra);
    await sup.start();
    const child2 = await nthChild(2);
    await settle();
    expect(texts(child2)).toEqual([SUPERVISOR_GREETING_PROMPT]);
  });

  it("still pending past the window is late; a message then clears it", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor({ ...g.extra, greetingWindowMs: 40 });
    await sup.startFresh(cwdDir);
    expect(sup.status()).not.toHaveProperty("greetingLate");
    await sleep(60);
    expect(sup.status()).toMatchObject({ greetingLate: true });
    g.claudeWrote();
    expect(sup.status()).not.toHaveProperty("greetingLate");
  });

  it("a Claude Code that is not signed in: late on the STOPPED status, and still owed", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor(g.extra);
    await sup.startFresh(cwdDir);
    pushJson(children[0], {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    });
    await waitFor(() => !sup.status().running, "the sign-in stop");
    expect(sup.status()).toMatchObject({
      running: false,
      lastError: "needs-login",
      greetingLate: true,
    });
    expect(g.markDone).not.toHaveBeenCalled();
  });

  it("a child that exits before its greeting turn ends is late", async () => {
    const g = greetingSeam();
    const { sup } = makeSupervisor({ ...g.extra, restartBackoffsMs: [10_000] });
    await sup.startFresh(cwdDir);
    exitChild(children[0], 1);
    await settle();
    expect(sup.status()).toMatchObject({ running: false, greetingLate: true });
  });
});

// --- #2199 ----------------------------------------------------------------------

describe("#2199 — no Claude Code to start: nothing is spawned, and nothing is broken", () => {
  /** A command the test can take away and give back. */
  function withCommand(initial: string | null) {
    let command = initial;
    return {
      opts: { resolveClaudeCommand: () => command },
      set: (next: string | null) => {
        command = next;
      },
    };
  }

  it("a boot spawns nothing, reads cli-unusable — and trips no breaker, so the next Apply starts it", async () => {
    const cmd = withCommand(null);
    const { sup } = makeSupervisor(cmd.opts);
    await sup.start();
    await sleep(30);
    expect(children).toHaveLength(0);
    expect(sup.status()).toMatchObject({ running: false, lastError: "cli-unusable" });
    cmd.set(process.execPath);
    expect(await sup.startAfterSetup()).toBe("starting");
    await nthChild(1);
  });

  it("an Apply with nothing to start answers 'cli-unusable', never a 'starting' that shows nothing", async () => {
    writeIntegrations([]);
    const cmd = withCommand(process.execPath);
    const { sup } = makeSupervisor(cmd.opts);
    await sup.start();
    writeIntegrations(null);
    cmd.set(null);
    expect(await sup.startAfterSetup()).toBe("cli-unusable");
    await sleep(30);
    expect(children).toHaveLength(0);
    expect(sup.status()).toMatchObject({ lastError: "cli-unusable" });
  });

  it("a Restart that finds no CLI leaves the running Claude alone, status clean", async () => {
    const cmd = withCommand(process.execPath);
    const { sup } = makeSupervisor(cmd.opts);
    await sup.start();
    const child1 = await nthChild(1);
    cmd.set(null);
    await expect(sup.relaunch()).resolves.toEqual({ spawned: false, why: "cli-unusable" });
    await expect(sup.startFresh()).resolves.toEqual({ spawned: false, why: "cli-unusable" });
    expect(child1.killed).toBe(false);
    expect(children).toHaveLength(1);
    expect(sup.status()).toMatchObject({ running: true });
    expect(sup.status()).not.toHaveProperty("lastError", "cli-unusable");
  });

  it("a Start fresh that finds no CLI keeps the conversation it was about to drop", async () => {
    const cmd = withCommand(process.execPath);
    const { sup } = makeSupervisor(cmd.opts);
    await sup.startFresh(cwdDir);
    await nthChild(1);
    const sessionFile = path.join(baseDir, "launcher-session.json");
    const before = fs.readFileSync(sessionFile, "utf8");
    cmd.set(null);
    exitChild(children[0], 1);
    // The crash restart finds nothing to run.
    await waitFor(() => sup.status().lastError === "cli-unusable", "the restart's diagnosis");
    await expect(sup.startFresh()).resolves.toEqual({ spawned: false, why: "cli-unusable" });
    expect(fs.readFileSync(sessionFile, "utf8")).toBe(before);
  });

  it("the diagnosis lapses once Claude Code is there, so the standby's Start shows again", async () => {
    writeLauncherSettingsFile({ startMode: "on-click", lifetime: "always", idleMinutes: 30 });
    const cmd = withCommand(null);
    const { sup } = makeSupervisor(cmd.opts);
    await sup.start();
    await expect(sup.startByUser()).resolves.toEqual({ spawned: false, why: "cli-unusable" });
    expect(sup.status()).toMatchObject({ lastError: "cli-unusable" });
    expect(sup.status()).not.toHaveProperty("standby");
    cmd.set(process.execPath);
    expect(sup.status()).not.toHaveProperty("lastError");
    expect(sup.status()).toMatchObject({ standby: "awaiting-start" });
  });

  it("an Apply that found no CLI keeps the walkthrough's hold for the Apply after the install", async () => {
    writeLauncherSettingsFile({ startMode: "auto", lifetime: "always", idleMinutes: 30 });
    const cmd = withCommand(process.execPath);
    const { sup } = makeSupervisor({ ...cmd.opts, walkthroughPending: () => true });
    await sup.start();
    cmd.set(null);
    expect(await sup.startAfterSetup()).toBe("cli-unusable");
    cmd.set(process.execPath);
    expect(await sup.startAfterSetup()).toBe("starting");
    await nthChild(1);
  });

  it("a Start with no CLI and no Claude says so; with no integration it still says not set up", async () => {
    const cmd = withCommand(null);
    const { sup } = makeSupervisor(cmd.opts);
    await expect(sup.startByUser()).resolves.toEqual({ spawned: false, why: "cli-unusable" });
    expect(sup.status()).toMatchObject({ running: false, lastError: "cli-unusable" });
    writeIntegrations([]);
    await expect(sup.relaunch()).resolves.toEqual({ spawned: false, why: "no-integration" });
    expect(children).toHaveLength(0);
  });
});
