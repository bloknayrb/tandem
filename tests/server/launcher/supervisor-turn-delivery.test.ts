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
 * hand.
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
import type { TandemEvent } from "../../../src/server/events/types.js";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import { createSupervisor, type Supervisor } from "../../../src/server/launcher/supervisor.js";
import {
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
  "integrationsBase" | "subscribeToEvents"
>;

function makeSupervisor(extra: ExtraOpts = {}): {
  sup: Supervisor;
  emit: (e: TandemEvent) => void;
} {
  const callbacks = new Set<(event: TandemEvent) => void>();
  const sup = createSupervisor({
    probeCliUsable: () => true,
    restartBackoffsMs: [0],
    ...extra,
    integrationsBase: baseDir,
    subscribeToEvents: (cb) => {
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
