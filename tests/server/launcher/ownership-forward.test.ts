/**
 * The document forward from ownership's step 5 to the supervisor's
 * start-or-wake (#2358 PR 3b-2b1c-a, ships dark; ADR-054's amendment of that
 * name), and the message forward (3b-2b1c-b, the last describe). Ownership's
 * `startOrWake` tells the test observer, drops `user-open`, forwards a
 * `message-owner` as `"message"` only when its admit answers true, drops a
 * `lapse` while another session is connected, and forwards every other cause
 * to the sink as `"document"`. The
 * sink here is what `src/server/index.ts` sets, through a `let` reference to
 * the supervisor (`supRef`), and the supervisor gets `workWaiting:
 * tandemWorkWaiting`, never a double: so a pass asks the real decision.
 *
 * The supervisor half is copied from `supervisor-presence.test.ts` (Ruling J:
 * copies, never moved code): the file-wide `spawn` mock with its privacy guard,
 * fake `setTimeout`/`clearTimeout` only, waits with no timer. The ownership
 * world is copied from `ownership-chat.test.ts` and
 * `ownership-waiting-chat.test.ts`, with the seams `index.ts` wires, plus
 * `setTransportView` (which `mcp/server.ts` wires) and a presence stub. No MCP
 * server, except the one case that needs a terminal's poll and reply. A lapse
 * is the grace: the holder's stream dropped, `noteTransportChanged`, then
 * `advance(GRACE + 1)`, with `GRACE` below `IDLE_MS`, `SETTLE` and `WINDOW`.
 *
 * Tandem's own child registers no transport here (in production it does, and
 * counts as another session until 3b-2b3: row A19 constructs that), so the
 * running-and-idle rows show what 3b-2b3 delivers.
 *
 * "Nothing" = no new spawn, no new stdin turn, `startPasses` unchanged; each
 * such row's anchor (named in its title) is the positive row it differs from.
 * Counted by spawns, turns, `startPasses` and a sink spy, never the decision.
 *
 * Platform: no real document files; the supervisor's temp home is under
 * `os.tmpdir()` joined with `path.join`, as in the copied file. Nothing is gated.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type * as Y from "yjs";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import { addUserReply } from "../../../src/server/annotations/lifecycle.js";
import { setChatRowsDeletedListener } from "../../../src/server/chat-row-deletions.js";
import { addDoc, removeDoc } from "../../../src/server/documents/registry-testing.js";
import type { TandemEvent } from "../../../src/server/events/types.js";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import type { RunFileAcl } from "../../../src/server/launcher/run-files.js";
import { updateLauncherSettings } from "../../../src/server/launcher/settings.js";
import {
  createSupervisor,
  type Supervisor,
  type TandemPresenceSeam,
} from "../../../src/server/launcher/supervisor.js";
import type { AiRefusal } from "../../../src/server/license/ai-refusal.js";
import { registerAnnotationTools } from "../../../src/server/mcp/annotations.js";
import {
  documentWaiting,
  handOverDocumentInbox,
  ownershipChatSide,
  registerAwarenessTools,
  resetInbox,
  setWaitingWrittenSinceForTests,
} from "../../../src/server/mcp/awareness.js";
import { populateYDoc } from "../../../src/server/mcp/document.js";
import { getOpenDocs } from "../../../src/server/mcp/document-service.js";
import { deliveryRegistry } from "../../../src/server/mcp/inbox-cursor.js";
import { handleClose } from "../../../src/server/mcp/routes/close.js";
import { CLAUDE_DESKTOP_CLIENT_NAME } from "../../../src/server/mcp/transport-registry.js";
import {
  __resetLocalPeriodForTests,
  __setHonourLocalPeriodRecordsForTests,
  loadLocalPeriodRecord,
} from "../../../src/server/models/local-period.js";
import { resolveToolCaller } from "../../../src/server/sessions/caller.js";
import { getMcpContext, runWithMcpContext } from "../../../src/server/sessions/context.js";
import { resetOwnerHandleBindForTests } from "../../../src/server/sessions/owner-handle-bind.js";
import {
  applyUserOpenDefault,
  controlDocumentOwner,
  controlMessageOwner,
  forgetChatMessageOwners,
  getDocOwner,
  getOwnerRecord,
  inboxScopeOf,
  noteTransportChanged,
  noteTransportRegistered,
  type OwnershipChangeCause,
  ownershipSnapshotForTests,
  type RecordKind,
  resetOwnershipForTests,
  setCompositeObserverForTests,
  setDocOwner,
  setGraceMsForTests,
  setOpenDocumentIdsSource,
  setOwnershipChatSide,
  setOwnershipInboxHandover,
  setOwnershipSeqSource,
  setOwnershipTransportMode,
  setStartOrWakeSink,
  setTandemPresenceSource,
  setTransportView,
  setWaitingProbe,
  setWakeObserverForTests,
  startOrWake,
  TANDEM_OWNER_ID,
  type TransportViewEntry,
  takeDocument,
  tandemWorkWaiting,
  type WakeCause,
} from "../../../src/server/sessions/ownership.js";
import { getOrCreateDocument } from "../../../src/server/yjs/provider.js";
import { CTRL_ROOM, Y_MAP_ANNOTATIONS, Y_MAP_CHAT } from "../../../src/shared/constants.js";
import { SUPERVISOR_WAKE_PROMPT } from "../../../src/shared/launcher/contract.js";
import { withBrowser, withInternal } from "../../../src/shared/origins.js";
import { setCtrlMode } from "../../helpers/ctrl-mode.js";
import {
  expectDeliveryRoundsLive,
  useKeyedDeliveryRounds,
} from "../../helpers/delivery-round-seam.js";
import { parseResult, setupMcpServer } from "../../helpers/mcp-harness.js";
import { asTestCaller } from "../../helpers/ownership-caller.js";
import { makeRes } from "../../helpers/route-recorder.js";

// The delivery-round seam as index.ts wires it: flag on, polls run keyed rounds.
useKeyedDeliveryRounds();

// --- Copied from supervisor-presence.test.ts (Ruling J) -------------------------

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

const RESULT_OK = { type: "result", subtype: "success", is_error: false, result: "done" };

function pushJson(child: FakeChild, obj: Record<string, unknown>): void {
  child.stdout.write(`${JSON.stringify(obj)}\n`);
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
  // These suites judge the waiting rules on fake clocks; the restart
  // cutoff ("written since boot", #2358) has its own cases.
  setWaitingWrittenSinceForTests(undefined);
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
    // The real decision, as index.ts passes it (never a double).
    workWaiting: tandemWorkWaiting,
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
  // What the sink reads at call time.
  supRef = sup;
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

async function childN(n: number): Promise<FakeChild> {
  return until(() => children.length >= n && children[n - 1], `child ${n}`);
}

function logText(): string {
  return errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
}

/** The texts of the turns written to a child. */
function turnTexts(child: FakeChild): string[] {
  return child.stdin.writes.map(
    (w) => (JSON.parse(w) as { message: { content: { text: string }[] } }).message.content[0].text,
  );
}
const wakes = (child: FakeChild) =>
  turnTexts(child).filter((t) => t === SUPERVISOR_WAKE_PROMPT).length;

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

// --- The ownership world (copied from ownership-chat / ownership-waiting-chat) --

const A = "claude:fwd-a";
const B = "claude:fwd-b";
const C = "claude:fwd-c";
const TANDEM = TANDEM_OWNER_ID;
/** Below IDLE_MS, SETTLE and WINDOW. */
const GRACE = 20;

let view: TransportViewEntry[];
let present = true;
let run = 0;
let prefix = "";
/** The `let` the sink reads at call time, as `index.ts`'s `launcherSupervisor`. */
let supRef: Supervisor | null = null;
const sink = vi.fn((cause: "document" | "message" | "solo-release" | "mode-known") =>
  supRef?.startOrWake?.(cause),
);
const departureSink = vi.fn((cause: "departure") => supRef?.startOrWake?.(cause));
/** The passes the lapse's re-ask may own (3b-2b2): at most one, and only when
 *  it was forwarded (no other session connected). It finds what the row
 *  finds; a row that wakes nothing still writes nothing. */
const departurePasses = () => (departureSink.mock.calls.length > 0 ? 1 : 0);
/** Every cause the observer was told. */
let causes: WakeCause[] = [];
let departures = 0;

function register(ownerId: string): void {
  view.push({ ownerId, openStreams: 0 });
  noteTransportRegistered(ownerId, { recordKind: "claude" });
}

/** `register` with a kind, a client name and stream counters. */
function registerAs(
  ownerId: string,
  opts: { recordKind: RecordKind; clientName?: string; openStreams?: number; streamEver?: boolean },
): void {
  view.push({
    ownerId,
    openStreams: opts.openStreams ?? 0,
    ...(opts.streamEver !== undefined ? { streamEver: opts.streamEver } : {}),
  });
  noteTransportRegistered(ownerId, {
    recordKind: opts.recordKind,
    ...(opts.clientName !== undefined ? { clientName: opts.clientName } : {}),
  });
}

interface Doc {
  id: string;
  ydoc: Y.Doc;
}

function mkDoc(name: string): Doc {
  const id = `${prefix}-${name}`;
  const ydoc = getOrCreateDocument(id);
  if (ydoc.getXmlFragment("default").length === 0) {
    populateYDoc(ydoc, "Hello world, this is a test document.");
  }
  addDoc(id, { id, filePath: `/tmp/${id}.md`, format: "md", readOnly: false, source: "file" });
  return { id, ydoc };
}

const key = (name: string) => `${prefix}-${name}`;
const annotations = (ydoc: Y.Doc) => ydoc.getMap(Y_MAP_ANNOTATIONS);

let clock = 1_000;
/** A pending outbound user comment, never handed. */
function comment(ydoc: Y.Doc, id: string, extra: Record<string, unknown> = {}): string {
  withInternal(ydoc, () =>
    annotations(ydoc).set(id, {
      id,
      author: "user",
      type: "comment",
      audience: "outbound",
      range: { from: 0, to: 5 },
      content: `text of ${id}`,
      status: "pending",
      timestamp: clock++,
      rev: 1,
      ...extra,
    }),
  );
  return id;
}

function resolveComment(ydoc: Y.Doc, id: string): void {
  const record = annotations(ydoc).get(id) as Record<string, unknown>;
  withInternal(ydoc, () => annotations(ydoc).set(id, { ...record, status: "accepted" }));
}

const ctrl = () => getOrCreateDocument(CTRL_ROOM);
const chatMap = () => ctrl().getMap(Y_MAP_CHAT);

/** An unread user chat message under key `k`, about `documentId` if given. */
function userChat(k: string, documentId?: string): string {
  withInternal(ctrl(), () =>
    chatMap().set(k, {
      id: k,
      author: "user",
      text: `text of ${k}`,
      timestamp: clock++,
      read: false,
      ...(documentId !== undefined ? { documentId } : {}),
    }),
  );
  return k;
}

function clearChat(): void {
  withInternal(ctrl(), () => {
    for (const k of [...chatMap().keys()]) chatMap().delete(k);
  });
}

const messageOwner = (k: string) =>
  ownershipSnapshotForTests().messageOwners.find(([mk]) => mk === k)?.[1];

async function closeByRoute(id: string): Promise<void> {
  const res = makeRes();
  await handleClose(
    { body: { documentId: id }, socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
    res as never,
  );
  expect(res._status, JSON.stringify(res._body)).toBe(200);
}

function entryOf(owner: string): TransportViewEntry {
  return view.find((e) => e.ownerId === owner) as TransportViewEntry;
}

/** Drop `owner`'s live stream (its transport stays registered): its grace starts. */
function dropStream(owner: string): void {
  const entry = entryOf(owner);
  entry.streamEver = true;
  entry.openStreams = 0;
  noteTransportChanged(owner);
}

/** Lapse `owner` through its grace (stream dropped, then the grace's length). */
function lapse(owner: string): void {
  dropStream(owner);
  advance(GRACE + 1);
}

/** PR a's world: A registered and holding D, which holds one pending user comment. */
function worldA(withComment = true): { d: Doc; c: string } {
  register(A);
  const d = mkDoc("d");
  setDocOwner(d.id, { ownerId: A, kind: "opened" }, "take", A);
  expect(getDocOwner(d.id)?.ownerId).toBe(A);
  const c = withComment ? comment(d.ydoc, key("c1")) : "";
  causes = [];
  return { d, c };
}

const passes = (h: ReturnType<typeof makeSupervisor>) => h.seam.diagnosticsForTests().startPasses;
/** The documents whose step 5 ran (the composite's "wake" step), in order. */
let stepFive: string[] = [];
/**
 * That D's change reached the composite's step 5 (its "wake" step fires on
 * every `setDocOwner`, before step 5's own checks). Not proof that the
 * forward was reached: A4 to A7 are regression rows, with A9 as their
 * reachability witness; the other "nothing" rows show the forward was reached
 * by the observer told "lapse", "user-open" or "message-owner", or the sink called.
 */
function reachedStepFive(documentId: string): void {
  expect(stepFive, "step 5 ran for D").toContain(documentId);
}
const ownershipLines = (): string[] =>
  errSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[ownership]"));

beforeEach(() => {
  run++;
  prefix = `fwd${run}`;
  resetInbox();
  resetOwnershipForTests();
  __resetLocalPeriodForTests();
  __setHonourLocalPeriodRecordsForTests(null);
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  clearChat();
  view = [];
  setTransportView(() => view);
  // The lines of `src/server/index.ts`.
  setOwnershipSeqSource(() => deliveryRegistry.counter);
  setOwnershipInboxHandover(handOverDocumentInbox);
  setWaitingProbe(documentWaiting);
  // The lapse's re-ask (3b-2b2) forwards as "departure", counted apart so
  // these rows keep counting the forward they were written for.
  setStartOrWakeSink((cause) => (cause === "departure" ? departureSink(cause) : sink(cause)));
  setOpenDocumentIdsSource(() => getOpenDocs().keys());
  setOwnershipChatSide(ownershipChatSide);
  setChatRowsDeletedListener(forgetChatMessageOwners);
  // Not `index.ts`'s: presence is stubbed (nothing in `src` sets it yet).
  present = true;
  setTandemPresenceSource(() => present);
  setCtrlMode("tandem");
  setGraceMsForTests(GRACE);
  supRef = null;
  sink.mockClear();
  departureSink.mockClear();
  causes = [];
  // "departure" (the lapse's re-ask, 3b-2b2) is recorded apart, so these
  // rows keep counting the forward they were written for.
  departures = 0;
  setWakeObserverForTests((cause) => (cause === "departure" ? departures++ : causes.push(cause)));
  stepFive = [];
  setCompositeObserverForTests((step, documentId) => {
    if (step === "wake") stepFive.push(documentId);
  });
});

afterEach(() => {
  resetOwnershipForTests();
  resetInbox();
  __resetLocalPeriodForTests();
  __setHonourLocalPeriodRecordsForTests(null);
  setChatRowsDeletedListener(undefined);
  for (const id of [...getOpenDocs().keys()]) removeDoc(id);
  clearChat();
  supRef = null;
});

// --- R1.1, R1.4, R1.5: direct calls --------------------------------------------

describe("R1: ownership's startOrWake, called directly", () => {
  it("R1.1: flag off, a call tells neither the observer nor the sink; the flag-on twin tells both", () => {
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    startOrWake("take");
    expect(causes).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    startOrWake("take");
    expect(causes).toEqual(["take"]);
    expect(sink.mock.calls).toEqual([["document"]]);
  });

  it("R1.4: every cause, with no other session registered and no admit: 'document' for each but user-open, message-owner and departure (its own name)", () => {
    // A Record over WakeCause: a new member of the union fails to compile here.
    const expected: Record<WakeCause, "document" | "departure" | null> = {
      "user-open": null,
      // Presence's consumer (3b-2b4a): forwarded, never dropped.
      presence: "document",
      // The user's Release and Assign (PR 5a): forwarded, ungated.
      release: "document",
      assign: "document",
      lapse: "document",
      "take-back": "document",
      claim: "document",
      take: "document",
      stale: "document",
      "poll-claim": "document",
      "reply-claim": "document",
      "post-claim": "document",
      "message-owner": null,
      departure: "departure",
    };
    for (const [cause, forward] of Object.entries(expected) as [
      WakeCause,
      "document" | "departure" | null,
    ][]) {
      sink.mockClear();
      departureSink.mockClear();
      causes = [];
      departures = 0;
      startOrWake(cause);
      if (forward === "departure") {
        // Counted apart (3b-2b2): its own observer counter and sink spy.
        expect(departures, cause).toBe(1);
        expect(departureSink.mock.calls, cause).toEqual([["departure"]]);
        expect(sink, cause).not.toHaveBeenCalled();
        continue;
      }
      expect(causes, cause).toEqual([cause]);
      expect(sink.mock.calls, cause).toEqual(forward === null ? [] : [[forward]]);
    }
    // Every OwnershipChangeCause is a key above (the type check is the proof).
    const _all: OwnershipChangeCause[] = Object.keys(expected).filter(
      (k) => k !== "message-owner" && k !== "departure",
    ) as OwnershipChangeCause[];
    expect(_all).toHaveLength(12);
  });

  it("R1.7 directly: a lapse with another session connected tells the observer and not the sink; every other cause still forwards", () => {
    register(B);
    startOrWake("lapse");
    expect(causes).toEqual(["lapse"]);
    expect(sink).not.toHaveBeenCalled();
    startOrWake("take");
    expect(sink.mock.calls).toEqual([["document"]]);
    // Presence is not gated (Bryan, 2026-11-23: "Yes, start anyway").
    startOrWake("presence");
    expect(sink.mock.calls).toEqual([["document"], ["document"]]);
  });

  it("R1.5: a forward made inside a request context reaches the sink, and the pass, with no caller identity readable", async () => {
    const seen: unknown[] = [];
    let passSaw: unknown = "not asked";
    const h = makeSupervisor({
      workWaiting: () => {
        passSaw = getMcpContext() ?? resolveToolCaller();
        return false;
      },
    });
    setStartOrWakeSink((cause) => {
      seen.push(getMcpContext() ?? resolveToolCaller());
      supRef?.startOrWake?.(cause);
    });
    runWithMcpContext({ ownerId: A }, () => {
      // The premise: inside the context the caller is readable.
      expect(resolveToolCaller()).toEqual({ ownerId: A });
      startOrWake("take");
    });
    expect(seen).toEqual([null]);
    await lockBarrier(h);
    expect(passSaw).toBeNull();
  });
});

// --- The decision table (PR a: documents) ----------------------------------------

describe("the decision table: A lapses", () => {
  it("A9 (positive): waiting, Claude running and idle: exactly one more wake turn, no spawn, the queued line", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA();
    const before = passes(h);
    lapse(A);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    await lockBarrier(h);
    expect(causes).toEqual(["lapse"]);
    expect(sink.mock.calls).toEqual([["document"]]);
    expect(wakes(c1)).toBe(1);
    expect(children).toHaveLength(1);
    expect(passes(h)).toBe(before + 1);
    expect(logText()).toContain("Start-or-wake queued (document)");
  });

  it("A1 (anchor A9): flag off when the grace runs out: nothing, the sink not called", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    worldA();
    const writes = c1.stdin.writes.length;
    const before = passes(h);
    dropStream(A);
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    advance(GRACE + 1);
    expect(sink).not.toHaveBeenCalled();
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    await lockBarrier(h);
    expect(causes).toEqual([]);
    expect(c1.stdin.writes).toHaveLength(writes);
    expect(children).toHaveLength(1);
    expect(passes(h)).toBe(before);
  });

  it("A2 (anchor A9): the sink's reference is null at the lapse; a supervisor created and started afterwards gets only its own first turn", async () => {
    const { d } = worldA();
    lapse(A);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    reachedStepFive(d.id);
    expect(causes).toEqual(["lapse"]);
    expect(sink.mock.calls).toEqual([["document"]]);
    const h = makeSupervisor();
    await h.sup.startFresh(cwdDir);
    const c1 = await childN(1);
    await settle();
    pushJson(c1, RESULT_OK);
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(1);
    expect(wakes(c1)).toBe(0);
    expect(passes(h)).toBe(0);
  });

  it("A3 (anchor A9): cause user-open: nothing; the observer is told and the probe is still asked", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const probe = vi.fn((documentId: string, _ownerId: string) => documentWaiting(documentId));
    setWaitingProbe(probe);
    const d = mkDoc("d");
    comment(d.ydoc, key("c1"));
    const writes = c1.stdin.writes.length;
    applyUserOpenDefault(d.id);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    expect(probe.mock.results.map((r) => r.value)).toEqual([true]);
    reachedStepFive(d.id);
    expect(causes).toEqual(["user-open"]);
    expect(sink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes);
    expect(passes(h)).toBe(0);
  });

  for (const how of ["poll-claim", "take-back"] as const) {
    it(`A4 (regression row; A9 is the reachability witness): ${how === "poll-claim" ? "the caller is Tandem's Claude" : "take-back"}: nothing`, async () => {
      const h = makeSupervisor();
      const c1 = await runningIdle(h);
      const { d } = worldA();
      const writes = c1.stdin.writes.length;
      if (how === "poll-claim") {
        setDocOwner(d.id, { ownerId: TANDEM, kind: "opened" }, "poll-claim", TANDEM);
      } else {
        setDocOwner(d.id, { ownerId: TANDEM, kind: "default" }, "take-back");
      }
      expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
      reachedStepFive(d.id);
      expect(causes).toEqual([]);
      expect(sink).not.toHaveBeenCalled();
      await lockBarrier(h);
      expect(c1.stdin.writes).toHaveLength(writes);
      expect(passes(h)).toBe(0);
    });
  }

  // Since 3b-2b2's departure re-ask: the lapse's own forward still does
  // nothing (the document went to nobody), but A was the last other session,
  // so the re-ask finds D's comment claimable and wakes Tandem's Claude once.
  it("A5 (presence false at the lapse; since 3b-2b2 the re-ask wakes for the claimable comment): D goes unowned, the lapse forwards nothing, the departure wakes once", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA();
    const writes = c1.stdin.writes.length;
    present = false;
    lapse(A);
    expect(getDocOwner(d.id)).toBeUndefined();
    reachedStepFive(d.id);
    expect(causes).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
    expect(departureSink.mock.calls).toEqual([["departure"]]);
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes + 1);
    expect(passes(h)).toBe(1);
    expect(tandemWorkWaiting()).toBe(true);
  });

  for (const what of [
    "a private note with a user reply, and a private comment with a user reply",
    "only Claude's own comment",
    "only a user highlight",
  ] as const) {
    it(`A6 (regression row; A9 is the reachability witness): nothing waiting on D (${what}): nothing`, async () => {
      const h = makeSupervisor();
      const c1 = await runningIdle(h);
      const { d } = worldA(false);
      if (what === "only Claude's own comment") {
        comment(d.ydoc, key("mine"), { author: "claude" });
      } else if (what === "only a user highlight") {
        comment(d.ydoc, key("hl"), { type: "highlight", color: "yellow" });
      } else {
        const note = key("note");
        withBrowser(d.ydoc, () =>
          annotations(d.ydoc).set(note, {
            id: note,
            author: "user",
            type: "note",
            audience: "private",
            range: { from: 0, to: 5 },
            content: "my note",
            status: "pending",
            timestamp: clock++,
          }),
        );
        const reply = addUserReply(d.ydoc, note, "a reply on my note", () => {});
        expect(reply.kind).toBe("ok");
        const priv = comment(d.ydoc, key("private"), { audience: "private" });
        expect(addUserReply(d.ydoc, priv, "a reply on my private comment", () => {}).kind).toBe(
          "ok",
        );
      }
      const writes = c1.stdin.writes.length;
      lapse(A);
      expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
      reachedStepFive(d.id);
      expect(causes).toEqual([]);
      expect(sink).not.toHaveBeenCalled();
      await lockBarrier(h);
      expect(c1.stdin.writes).toHaveLength(writes);
      expect(passes(h)).toBe(departurePasses());
    });
  }

  for (const mode of ["solo", null] as const) {
    it(`A7 (regression row; A9 is the reachability witness): ${mode === "solo" ? "Solo" : "mode unknown"}: nothing`, async () => {
      const h = makeSupervisor();
      const c1 = await runningIdle(h);
      const { d } = worldA();
      setCtrlMode(mode);
      const writes = c1.stdin.writes.length;
      lapse(A);
      expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
      reachedStepFive(d.id);
      expect(causes).toEqual([]);
      expect(sink).not.toHaveBeenCalled();
      await lockBarrier(h);
      expect(c1.stdin.writes).toHaveLength(writes);
      expect(passes(h)).toBe(departurePasses());
    });
  }

  it("A8 (since 3b-2b1c-b, M1's shape with D also held): nothing waiting on D; A owns a closed F's message per message and its lapse releases it: the message forward wakes", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA(false);
    const f = mkDoc("f");
    setDocOwner(f.id, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), f.id);
    await closeByRoute(f.id);
    expect(messageOwner(m)?.ownerId).toBe(A);
    causes = [];
    lapse(A);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    expect(messageOwner(m)).toBeUndefined();
    reachedStepFive(d.id);
    // D's own change forwards nothing (nothing waiting on D); the message does.
    expect(causes).toEqual(["message-owner"]);
    expect(sink.mock.calls).toEqual([["message"]]);
    await lockBarrier(h);
    expect(wakes(c1)).toBe(1);
  });

  it("A16 (positive): D holds no comment, only an unread user message on D: a wake (step 5's chat half)", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA(false);
    userChat(key("m"), d.id);
    lapse(A);
    await lockBarrier(h);
    expect(causes).toEqual(["lapse"]);
    expect(wakes(c1)).toBe(1);
    expect(children).toHaveLength(1);
  });

  it("A16b (positive): D holds only a user reply on A's own Claude-facing comment (any thread reply): a wake", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA(false);
    const mine = comment(d.ydoc, key("mine"), { author: "claude" });
    expect(addUserReply(d.ydoc, mine, "a reply in Claude's thread", () => {}).kind).toBe("ok");
    lapse(A);
    await lockBarrier(h);
    expect(causes).toEqual(["lapse"]);
    expect(wakes(c1)).toBe(1);
  });

  for (const mode of ["solo", null] as const) {
    it(`A7b (positive; chat is never Solo-held): ${mode === "solo" ? "Solo" : "mode unknown"}, D holds only an unread user message on D: a wake`, async () => {
      const h = makeSupervisor();
      const c1 = await runningIdle(h);
      const { d } = worldA(false);
      userChat(key("m"), d.id);
      setCtrlMode(mode);
      lapse(A);
      await lockBarrier(h);
      expect(causes).toEqual(["lapse"]);
      expect(wakes(c1)).toBe(1);
    });
  }

  it("A12 (positive): waiting, idle-stopped: one spawn with --resume whose first turn is the wake", async () => {
    const { h } = await idleStopped();
    worldA();
    lapse(A);
    await lockBarrier(h);
    const c2 = await childN(2);
    await settle();
    expect(children).toHaveLength(2);
    expect(argAfter(c2, "--resume")).toBeDefined();
    expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("A10 (anchor A12): the licence refuses at the call, idle-stopped: nothing; after admitting again and resumeAfterLicence(), still no spawn", async () => {
    const lic = licenceDouble();
    const { h } = await idleStopped({ aiRefusal: lic.fn });
    const { d } = worldA();
    lic.refusing = true;
    lapse(A);
    reachedStepFive(d.id);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    expect(causes).toEqual(["lapse"]);
    expect(sink.mock.calls).toEqual([["document"]]);
    lic.refusing = false;
    await lockBarrier(h);
    await h.sup.resumeAfterLicence();
    await settle();
    expect(children).toHaveLength(1);
    expect(passes(h)).toBe(0);
  });

  it("PR 5a, an unlicensed Assign (ownership design §10.1): the user's Assign to Tandem's Claude lands keyless, the forward goes out, and the supervisor refuses it: no spawn", async () => {
    const lic = licenceDouble();
    const { h } = await idleStopped({ aiRefusal: lic.fn });
    const { d } = worldA();
    lic.refusing = true;
    // An HTTP-mode boot has Tandem's Claude's record from the start.
    setOwnershipTransportMode("http");
    const label = getOwnerRecord(TANDEM)?.label;
    expect(await controlDocumentOwner(d.id, "assign", label, () => true)).toBe("changed");
    expect(getDocOwner(d.id)).toMatchObject({ ownerId: TANDEM, kind: "assigned" });
    expect(causes).toEqual(["assign"]);
    expect(sink.mock.calls).toEqual([["document"]]);
    await lockBarrier(h);
    await settle();
    expect(children).toHaveLength(1);
    expect(passes(h)).toBe(0);
  });

  it("PR 5a, an Assign (positive twin): admitted, idle-stopped: one spawn whose first turn is the wake", async () => {
    const { h } = await idleStopped();
    const { d } = worldA();
    // An HTTP-mode boot has Tandem's Claude's record from the start.
    setOwnershipTransportMode("http");
    const label = getOwnerRecord(TANDEM)?.label;
    expect(await controlDocumentOwner(d.id, "assign", label, () => true)).toBe("changed");
    await lockBarrier(h);
    const c2 = await childN(2);
    await settle();
    expect(children).toHaveLength(2);
    expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  /** A owns a closed F's message per message (origin close): the message Assign's starting point. */
  async function messageOwnedByA(): Promise<string> {
    register(A);
    const f = mkDoc("f");
    setDocOwner(f.id, { ownerId: A, kind: "opened" }, "take", A);
    const m = userChat(key("m"), f.id);
    await closeByRoute(f.id);
    expect(messageOwner(m)?.ownerId).toBe(A);
    causes = [];
    return m;
  }

  it("PR 5a-2, an unlicensed Assign of a chat message (ownership design §10.1): it lands keyless, the message forward goes out, and the supervisor refuses it: no spawn", async () => {
    const lic = licenceDouble();
    const { h } = await idleStopped({ aiRefusal: lic.fn });
    const m = await messageOwnedByA();
    lic.refusing = true;
    setOwnershipTransportMode("http");
    const label = getOwnerRecord(TANDEM)?.label;
    expect(controlMessageOwner(m, "assign", label)).toBe("changed");
    expect(messageOwner(m)).toEqual({ ownerId: TANDEM, origin: "assign" });
    expect(causes).toEqual(["message-owner"]);
    expect(sink.mock.calls).toEqual([["message"]]);
    await lockBarrier(h);
    await settle();
    expect(children).toHaveLength(1);
    expect(passes(h)).toBe(0);
  });

  it("PR 5a-2, an Assign of a chat message (positive twin): admitted, idle-stopped: one spawn whose first turn is the wake", async () => {
    const { h } = await idleStopped();
    const m = await messageOwnedByA();
    setOwnershipTransportMode("http");
    const label = getOwnerRecord(TANDEM)?.label;
    expect(controlMessageOwner(m, "assign", label)).toBe("changed");
    await lockBarrier(h);
    const c2 = await childN(2);
    await settle();
    expect(children).toHaveLength(2);
    expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("A15 (positive): A holds D and E, each with a waiting comment; one lapse: exactly one pass, one wake", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA();
    const e = mkDoc("e");
    setDocOwner(e.id, { ownerId: A, kind: "opened" }, "take", A);
    comment(e.ydoc, key("c2"));
    causes = [];
    const before = passes(h);
    lapse(A);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    expect(getDocOwner(e.id)?.ownerId).toBe(TANDEM);
    expect(sink).toHaveBeenCalledTimes(2);
    await lockBarrier(h);
    expect(passes(h)).toBe(before + 1);
    expect(wakes(c1)).toBe(1);
    expect(children).toHaveLength(1);
  });

  it("A17 (anchor A9): terminal B connected, holding nothing: nothing; the observer told lapse", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA();
    register(B);
    const writes = c1.stdin.writes.length;
    lapse(A);
    reachedStepFive(d.id);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    expect(causes).toEqual(["lapse"]);
    expect(sink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes);
    expect(passes(h)).toBe(0);
  });

  it("A18 (anchor A12): idle-stopped, terminal B connected and holding nothing: nothing; D is Tandem's Claude's (default) and B's scope is neither (pick 3)", async () => {
    const { h } = await idleStopped();
    const { d } = worldA();
    register(B);
    lapse(A);
    reachedStepFive(d.id);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    expect(causes).toEqual(["lapse"]);
    expect(sink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(children).toHaveLength(1);
    expect(passes(h)).toBe(0);
    expect(getDocOwner(d.id)).toMatchObject({ ownerId: TANDEM, kind: "default" });
    expect(inboxScopeOf(d.id, B)).toBe("neither");
  });

  it("A19 (anchor A9; the own-Claude row, as built): an attached claude: record standing for Tandem's own child's transport: nothing", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA();
    // Constructed: production has it (the child's transport on a claude:
    // record until 3b-2b3), the harness does not.
    registerAs("claude:fwd-own-child", { recordKind: "claude", openStreams: 1, streamEver: true });
    const writes = c1.stdin.writes.length;
    lapse(A);
    reachedStepFive(d.id);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    expect(causes).toEqual(["lapse"]);
    expect(sink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes);
    expect(passes(h)).toBe(0);
  });

  it("A17b (anchor A9; R1.7, list item 2): B connected, then its stream dropped and still inside its grace: nothing (a gone session counts for its grace)", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA();
    register(B);
    const writes = c1.stdin.writes.length;
    // A's grace starts first; B's stream drops halfway through it, so B is
    // still inside its own grace when A's runs out.
    dropStream(A);
    advance(GRACE / 2);
    dropStream(B);
    advance(GRACE / 2 + 1);
    const records = ownershipSnapshotForTests().records;
    expect(records.find((r) => r.ownerId === A)?.lapsed).toBe(true);
    expect(records.find((r) => r.ownerId === B)?.lapsed).toBeFalsy();
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    reachedStepFive(d.id);
    expect(causes).toEqual(["lapse"]);
    expect(sink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes);
    expect(passes(h)).toBe(0);
  });

  it("A17c (positive, as built; new blocker 4): B still registered but already lapsed (its stream dropped past its grace): a wake", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    worldA();
    register(B);
    lapse(B);
    lapse(A);
    expect(causes).toEqual(["lapse"]);
    await lockBarrier(h);
    expect(sink.mock.calls).toEqual([["document"]]);
    expect(wakes(c1)).toBe(1);
  });

  it("A20 (positive; decided: Desktop doesn't count): B connected as Claude Desktop, holding nothing: a wake", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    worldA();
    registerAs(B, { recordKind: "claude", clientName: CLAUDE_DESKTOP_CLIENT_NAME });
    lapse(A);
    await lockBarrier(h);
    expect(sink.mock.calls).toEqual([["document"]]);
    expect(wakes(c1)).toBe(1);
  });

  it("A21 (positive, as built; the own-Claude row's gap): Tandem's own child's record takes D and lapses when it stops: Tandem's Claude is started for its own leftovers", async () => {
    const { h } = await idleStopped();
    const d = mkDoc("d");
    comment(d.ydoc, key("c1"));
    applyUserOpenDefault(d.id);
    expect(getDocOwner(d.id)).toMatchObject({ ownerId: TANDEM, kind: "default" });
    // C stands for the child's transport (a claude: record before 3b-2b3).
    register(C);
    expect(takeDocument(d.id, C)).toEqual({ ok: true, took: true });
    expect(getDocOwner(d.id)).toMatchObject({ ownerId: C, kind: "opened" });
    // Nothing yet: the user open's own forward is dropped (A3). After the lock
    // barrier, a pass the open had queued would have run (startPasses).
    await lockBarrier(h);
    expect(passes(h)).toBe(0);
    expect(children).toHaveLength(1);
    causes = [];
    lapse(C);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    expect(causes).toEqual(["lapse"]);
    await lockBarrier(h);
    const c2 = await childN(2);
    await settle();
    expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });
});

// --- Other cases (a) ---------------------------------------------------------------

const FORWARD_FAILED =
  "[ownership] a change of owner could not be passed on to Tandem's Claude; it may not have been started or woken.";
/** The `ownership` frame's waiting read (#2358 PR 3b-2d). */
const FRAME_WAITING_FAILED =
  "[ownership] whether work is waiting after a change of owner could not be read; no session was told.";

describe("other cases (PR a)", () => {
  it("R1.5: a throwing sink inside a lapse of two documents: both move, one fixed line, and no setDocOwner-failed line", () => {
    setStartOrWakeSink(() => {
      throw new Error(`boom ${key("secret")}`);
    });
    const { d } = worldA();
    const e = mkDoc("e");
    setDocOwner(e.id, { ownerId: A, kind: "opened" }, "take", A);
    comment(e.ydoc, key("c2"));
    lapse(A);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    expect(getDocOwner(e.id)?.ownerId).toBe(TANDEM);
    expect(ownershipLines()).toEqual([FORWARD_FAILED]);
    expect(ownershipLines().join("\n")).not.toMatch(/setDocOwner failed:/);
    expect(FORWARD_FAILED).not.toMatch(/startOrWake/);
  });

  it("a comment resolved between the lapse and the pass: the pass is only queued, asks again and finds nothing", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d, c } = worldA();
    const before = passes(h);
    const writes = c1.stdin.writes.length;
    lapse(A);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(passes(h)).toBe(before);
    resolveComment(d.ydoc, c);
    await lockBarrier(h);
    expect(passes(h)).toBe(before + 1);
    expect(c1.stdin.writes).toHaveLength(writes);
  });

  it("new blocker 2's 'settled one ever edited': a comment edited and then resolved before the pass still wakes (as built)", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA(false);
    const c = comment(d.ydoc, key("c1"), { editedAt: 5_000 });
    lapse(A);
    resolveComment(d.ydoc, c);
    await lockBarrier(h);
    expect(wakes(c1)).toBe(1);
  });

  it("the pass asks the whole decision (Accepted): D's comment resolved before the pass, an old comment on an unheld open E still starts Claude", async () => {
    const { h } = await idleStopped();
    const e = mkDoc("e");
    comment(e.ydoc, key("old"));
    const { d, c } = worldA();
    dropStream(A);
    advance(GRACE + 1);
    resolveComment(d.ydoc, c);
    await lockBarrier(h);
    const c2 = await childN(2);
    await settle();
    expect(getDocOwner(e.id)).toBeUndefined();
    expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("a session connecting between the forward and the pass does not stop it (as built; Accepted)", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    worldA();
    lapse(A);
    expect(sink).toHaveBeenCalledTimes(1);
    register(B);
    await lockBarrier(h);
    expect(wakes(c1)).toBe(1);
  });

  describe("new blocker 2, asserted as built", () => {
    let client: Client;
    let close: (() => Promise<void>) | undefined;
    let callingAs = A;

    afterEach(async () => {
      await close?.();
      close = undefined;
    });

    async function as(owner: string, tool: string, args: Record<string, unknown> = {}) {
      if (tool === "tandem_checkInbox") expectDeliveryRoundsLive();
      callingAs = owner;
      return parseResult(await client.callTool({ name: tool, arguments: args })) as {
        error: boolean;
        data?: Record<string, unknown>;
      };
    }

    async function idleWithClient() {
      const { h } = await idleStopped();
      ({ client, close } = await setupMcpServer([registerAwarenessTools, registerAnnotationTools], {
        dispatch: (fn) => asTestCaller(fn, { ownerId: callingAs }),
      }));
      return h;
    }

    // Replaced, when the handled filter lands (#2360), by "a lapse of a holder
    // that answered everything in its threads starts nothing".
    it("answered work starts Tandem's Claude (new blocker 2): a user reply in A's own thread, answered there by A and acknowledged; A lapses; the pass starts Claude", async () => {
      const h = await idleWithClient();
      const { d } = worldA(false);
      const wrote = await as(A, "tandem_comment", {
        from: 0,
        to: 5,
        text: "a question for you",
        documentId: d.id,
      });
      expect(wrote.error, JSON.stringify(wrote)).toBe(false);
      const mine = wrote.data?.annotationId as string;
      expect(addUserReply(d.ydoc, mine, "my answer to your question", () => {}).kind).toBe("ok");
      const first = await as(A, "tandem_checkInbox", { cursor: "start" });
      expect(first.error, JSON.stringify(first)).toBe(false);
      const replied = await as(A, "tandem_annotationReply", {
        annotationId: mine,
        text: "thanks, done",
        documentId: d.id,
      });
      expect(replied.error, JSON.stringify(replied)).toBe(false);
      const ack = await as(A, "tandem_checkInbox", { cursor: first.data?.cursor });
      expect(ack.error, JSON.stringify(ack)).toBe(false);
      // Handed to its holder: not waiting before the lapse.
      expect(documentWaiting(d.id)).toBe(false);
      causes = [];
      lapse(A);
      expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
      expect(sink.mock.calls).toEqual([["document"]]);
      await lockBarrier(h);
      const c2 = await childN(2);
      await settle();
      expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    });

    // Replaced, when the handled filter lands (#2360), by "a lapse of a holder
    // that answered everything in its threads starts nothing".
    it("answered work starts Tandem's Claude (new blocker 2): A answered D's one user comment (a fresh comment) and acknowledged it; A lapses; the pass starts Claude", async () => {
      const h = await idleWithClient();
      const { d, c } = worldA();
      const first = await as(A, "tandem_checkInbox", { cursor: "start" });
      expect(first.error, JSON.stringify(first)).toBe(false);
      expect(JSON.stringify(first.data)).toContain(c);
      // A thread reply on a user's comment is refused today (NOT_OWNED, until
      // #2360), so A answers as the refusal says: a fresh comment on D.
      const replied = await as(A, "tandem_comment", {
        from: 0,
        to: 5,
        text: `answering ${c}`,
        documentId: d.id,
      });
      expect(replied.error, JSON.stringify(replied)).toBe(false);
      const ack = await as(A, "tandem_checkInbox", { cursor: first.data?.cursor });
      expect(ack.error, JSON.stringify(ack)).toBe(false);
      // Handed to its holder: not waiting before the lapse.
      expect(documentWaiting(d.id)).toBe(false);
      // Answered and acknowledged: the comment is still pending, handed to A.
      expect((annotations(d.ydoc).get(c) as { status: string }).status).toBe("pending");
      lapse(A);
      expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
      expect(sink.mock.calls).toEqual([["document"]]);
      await lockBarrier(h);
      const c2 = await childN(2);
      await settle();
      expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
    });
  });
});

// --- PR b: the message forward (#2358 PR 3b-2b1c-b) -------------------------------

function removeTransport(owner: string): void {
  view = view.filter((e) => e.ownerId !== owner);
  noteTransportChanged(owner);
}

/** A raw Claude final row naming `m` in `replyTo` (server-side, `withInternal`): `m` is handled. */
function claudeAnswers(m: string): void {
  const k = key("answer");
  withInternal(ctrl(), () =>
    chatMap().set(k, { id: k, author: "claude", text: "done", timestamp: clock++, replyTo: m }),
  );
  expect(ownershipChatSide.handledKeys().has(m)).toBe(true);
}

/**
 * PR b's world: PR a's, without D's comment, plus a message A owns per
 * message, made by closing D while A holds it and an unread user message is
 * on it. The act is A's lapse.
 */
async function worldB(): Promise<{ d: Doc; m: string }> {
  const { d } = worldA(false);
  const m = userChat(key("m"), d.id);
  await closeByRoute(d.id);
  expect(getOpenDocs().has(d.id)).toBe(false);
  expect(messageOwner(m)?.ownerId).toBe(A);
  causes = [];
  sink.mockClear();
  return { d, m };
}

describe("the message forward (PR b)", () => {
  it("M1 (positive): the message unhandled, D closed, Claude running and idle: a wake, logged (message)", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { m } = await worldB();
    lapse(A);
    expect(messageOwner(m)).toBeUndefined();
    expect(causes).toEqual(["message-owner"]);
    expect(sink.mock.calls).toEqual([["message"]]);
    await lockBarrier(h);
    expect(wakes(c1)).toBe(1);
    expect(children).toHaveLength(1);
    expect(logText()).toContain("Start-or-wake queued (message)");
  });

  it("M1, read first (the release loop's order: re-owe, then forward): the holder had read the message before it went away: a wake", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { m } = await worldB();
    const row = chatMap().get(m) as Record<string, unknown>;
    withInternal(ctrl(), () => chatMap().set(m, { ...row, read: true }));
    expect(ownershipChatSide.owedToFreshReader()).not.toContain(m);
    lapse(A);
    expect(messageOwner(m)).toBeUndefined();
    expect(sink.mock.calls).toEqual([["message"]]);
    await lockBarrier(h);
    expect(wakes(c1)).toBe(1);
  });

  it("R1.1 for the message branch: flag off, an admit that would answer true is not asked and nothing reaches the sink; the flag-on twin forwards", () => {
    const admit = vi.fn(() => true);
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    startOrWake("message-owner", admit);
    expect(admit).not.toHaveBeenCalled();
    expect(causes).toEqual([]);
    expect(sink).not.toHaveBeenCalled();
    vi.stubEnv("TANDEM_OWNERSHIP", "1");
    startOrWake("message-owner", admit);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls).toEqual([["message"]]);
  });

  it("R1.5 for the message branch: an admitted forward made inside a request context reaches the sink with no caller identity readable", () => {
    const seen: unknown[] = [];
    setStartOrWakeSink((cause) => seen.push([cause, getMcpContext() ?? resolveToolCaller()]));
    runWithMcpContext({ ownerId: A }, () => {
      expect(resolveToolCaller()).toEqual({ ownerId: A });
      startOrWake("message-owner", () => true);
    });
    expect(seen).toEqual([["message", null]]);
  });

  // M1 with the transport removed instead of the stream dropped: the grace's
  // lapse releases the unhandled message (the lapse path, not deleteRecord's),
  // then the record holds nothing and is deleted.
  it("M1, transport removed (M2's anchor): the lapse's own release frees the unhandled message, then the record is deleted: a wake", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { m } = await worldB();
    removeTransport(A);
    advance(GRACE + 1);
    expect(messageOwner(m)).toBeUndefined();
    expect(sink.mock.calls).toEqual([["message"]]);
    await lockBarrier(h);
    expect(wakes(c1)).toBe(1);
  });

  // The deleted-record path. `deleteRecord` runs only for a lapsed record that
  // holds no state, and `recordHoldsState` counts every owned message that is
  // unhandled and still a live, non-local-period user row; so every key it
  // releases is handled, gone or local-period, and the admit refuses each. No
  // positive row through this path exists: M2 is its regression row (it still
  // fails a forward that ignores the admit).
  it("M2 (regression row, the deleted-record path; anchor: M1, transport removed): the message handled, A's transport removed: nothing; the observer told message-owner", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { m } = await worldB();
    claudeAnswers(m);
    const writes = c1.stdin.writes.length;
    removeTransport(A);
    advance(GRACE + 1);
    expect(messageOwner(m)).toBeUndefined();
    expect(causes).toEqual(["message-owner"]);
    expect(sink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes);
    expect(passes(h)).toBe(departurePasses());
  });

  it("M3 (anchor M1): the message classed local-period after the close: nothing; the observer told message-owner", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { m } = await worldB();
    __setHonourLocalPeriodRecordsForTests(true);
    loadLocalPeriodRecord({ v: 1, open: false, owed: [], local: [m] });
    expect(ownershipChatSide.message(m)?.localPeriod).toBe(true);
    const writes = c1.stdin.writes.length;
    lapse(A);
    expect(messageOwner(m)).toBeUndefined();
    expect(causes).toEqual(["message-owner"]);
    expect(sink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes);
    expect(passes(h)).toBe(departurePasses());
  });

  it("M10 (anchor M1): D re-added open and unowned before the lapse, so the message follows D and nobody holds D: the message forward refuses it; since 3b-2b2 the departure re-ask wakes once (claimable)", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d, m } = await worldB();
    mkDoc("d");
    expect(getOpenDocs().has(d.id)).toBe(true);
    expect(getDocOwner(d.id)).toBeUndefined();
    const writes = c1.stdin.writes.length;
    lapse(A);
    expect(messageOwner(m)).toBeUndefined();
    expect(causes).toEqual(["message-owner"]);
    expect(sink).not.toHaveBeenCalled();
    expect(departureSink.mock.calls).toEqual([["departure"]]);
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes + 1);
    expect(passes(h)).toBe(1);
    expect(tandemWorkWaiting()).toBe(true);
  });

  it("M11 (anchor M1): M10 plus a doc-less unread user message Tandem's Claude owns by presence: the message forward still refuses (its admit asks only the changed message); the departure re-ask wakes once", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { m } = await worldB();
    mkDoc("d");
    userChat(key("docless"));
    const writes = c1.stdin.writes.length;
    lapse(A);
    expect(messageOwner(m)).toBeUndefined();
    expect(causes).toEqual(["message-owner"]);
    expect(sink).not.toHaveBeenCalled();
    expect(departureSink.mock.calls).toEqual([["departure"]]);
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes + 1);
    expect(passes(h)).toBe(1);
  });

  describe("M4 to M6: a close forwards nothing (pick 1)", () => {
    async function closeWorld(
      holder: "nobody" | "tandem" | "B",
      withB: boolean,
    ): Promise<{ h: ReturnType<typeof makeSupervisor>; c1: FakeChild; m: string }> {
      const h = makeSupervisor();
      const c1 = await runningIdle(h);
      if (withB || holder === "B") register(B);
      const d = mkDoc("d");
      if (holder === "tandem") setDocOwner(d.id, { ownerId: TANDEM, kind: "default" }, "take-back");
      if (holder === "B") setDocOwner(d.id, { ownerId: B, kind: "opened" }, "take", B);
      const m = userChat(key("m"), d.id);
      causes = [];
      sink.mockClear();
      await closeByRoute(d.id);
      return { h, c1, m };
    }

    for (const [row, holder, withB, owner] of [
      ["M4", "nobody", false, TANDEM],
      ["M4b", "nobody", true, TANDEM],
      ["M5", "tandem", false, TANDEM],
      ["M6", "B", false, B],
    ] as const) {
      it(`${row} (anchor M1): D ${holder === "nobody" ? "open and unowned" : `held by ${holder === "tandem" ? "Tandem's Claude" : "terminal B"}`}${withB ? ", terminal B connected" : ""}, an unread message on D; the close: nothing`, async () => {
        const { h, c1, m } = await closeWorld(holder, withB);
        const writes = c1.stdin.writes.length;
        expect(messageOwner(m)?.ownerId).toBe(owner);
        expect(causes).toEqual(["message-owner"]);
        expect(sink).not.toHaveBeenCalled();
        await lockBarrier(h);
        expect(c1.stdin.writes).toHaveLength(writes);
        expect(passes(h)).toBe(0);
        if (owner === TANDEM) expect(tandemWorkWaiting()).toBe(true);
      });
    }
  });

  it("M7 (positive): M1 in Solo: a wake (chat is never Solo-held)", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    await worldB();
    setCtrlMode("solo");
    lapse(A);
    expect(sink.mock.calls).toEqual([["message"]]);
    await lockBarrier(h);
    expect(wakes(c1)).toBe(1);
  });

  it("M8 (positive): M1 with Claude idle-stopped: a start whose first turn is the wake", async () => {
    const { h } = await idleStopped();
    await worldB();
    lapse(A);
    expect(sink.mock.calls).toEqual([["message"]]);
    await lockBarrier(h);
    const c2 = await childN(2);
    await settle();
    expect(argAfter(c2, "--resume")).toBeDefined();
    expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  it("M9 (positive): A owns two such messages and holds E with a waiting comment; one lapse: exactly one pass", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA(false);
    const m1 = userChat(key("m1"), d.id);
    const m2 = userChat(key("m2"), d.id);
    await closeByRoute(d.id);
    expect(messageOwner(m1)?.ownerId).toBe(A);
    expect(messageOwner(m2)?.ownerId).toBe(A);
    const e = mkDoc("e");
    setDocOwner(e.id, { ownerId: A, kind: "opened" }, "take", A);
    comment(e.ydoc, key("c2"));
    sink.mockClear();
    const before = passes(h);
    lapse(A);
    expect(sink.mock.calls).toHaveLength(3);
    await lockBarrier(h);
    expect(passes(h)).toBe(before + 1);
    expect(wakes(c1)).toBe(1);
  });

  it("M12 (anchor M1): M1 plus terminal B connected, holding nothing: nothing; the observer told message-owner", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    await worldB();
    register(B);
    const writes = c1.stdin.writes.length;
    lapse(A);
    expect(causes).toEqual(["message-owner"]);
    expect(sink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes);
    expect(passes(h)).toBe(0);
  });

  it("M13 (anchor M8): M8 plus terminal B connected, holding nothing: nothing; the message is Tandem's Claude's (the review session's reading of pick 3)", async () => {
    const { h } = await idleStopped();
    const { m } = await worldB();
    register(B);
    lapse(A);
    expect(causes).toEqual(["message-owner"]);
    expect(sink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(children).toHaveLength(1);
    expect(passes(h)).toBe(0);
    expect(messageOwner(m)).toBeUndefined();
    expect(tandemWorkWaiting()).toBe(true);
  });

  it("a throwing owedToFreshReader: every owner is still dropped and re-owed, one fixed line, the supervisor not called", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA(false);
    const m1 = userChat(key("m1"), d.id);
    const m2 = userChat(key("m2"), d.id);
    await closeByRoute(d.id);
    const reOwe = vi.fn((keys: readonly string[]) => ownershipChatSide.reOwe(keys));
    setOwnershipChatSide({
      ...ownershipChatSide,
      reOwe,
      owedToFreshReader: () => {
        throw new Error(`boom ${m1}`);
      },
    });
    sink.mockClear();
    const writes = c1.stdin.writes.length;
    lapse(A);
    expect(messageOwner(m1)).toBeUndefined();
    expect(messageOwner(m2)).toBeUndefined();
    expect(reOwe.mock.calls.flat(2).sort()).toEqual([m1, m2].sort());
    // And, since #2358 PR 3b-2d, the release's frame check reads the same
    // throwing member: its own fixed line, and no frame.
    expect(ownershipLines()).toEqual([FORWARD_FAILED, FRAME_WAITING_FAILED]);
    expect(sink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes);
  });
});

// --- #2358 PR 3b-2b2: the departure re-ask (the claimable row) --------------

describe("3b-2b2: the re-ask when a session stops counting", () => {
  it("D1 (positive): a claimable comment on E while B is connected; B lapses: the re-ask wakes once", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    register(B);
    const e = mkDoc("e");
    comment(e.ydoc, key("ce"));
    expect(getDocOwner(e.id)).toBeUndefined();
    expect(tandemWorkWaiting()).toBe(false); // B counts: claimable work is not Tandem's Claude's
    const writes = c1.stdin.writes.length;
    lapse(B);
    expect(departureSink.mock.calls).toEqual([["departure"]]);
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes + 1);
    expect(passes(h)).toBe(1);
  });

  it("D1's anchor: C still connected when B lapses: nothing forwarded, nothing written", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    register(B);
    register(C);
    const e = mkDoc("e");
    comment(e.ydoc, key("ce"));
    const writes = c1.stdin.writes.length;
    lapse(B);
    expect(departureSink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes);
    expect(passes(h)).toBe(0);
  });

  it("D2, two sessions going away together: A holds D with a waiting comment, B connected; both lapse in one grace: one wake, at the second", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    const { d } = worldA();
    register(B);
    const writes = c1.stdin.writes.length;
    dropStream(A);
    dropStream(B);
    advance(GRACE + 1);
    expect(getDocOwner(d.id)?.ownerId).toBe(TANDEM);
    // A's own forward and A's re-ask were dropped while B still counted.
    expect(sink).not.toHaveBeenCalled();
    expect(departureSink.mock.calls).toEqual([["departure"]]);
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes + 1);
    expect(passes(h)).toBe(1);
  });

  it("D3, idle-stopped: B lapses with a claimable comment waiting: one spawn whose first turn is the wake", async () => {
    const { h } = await idleStopped();
    register(B);
    const e = mkDoc("e");
    comment(e.ydoc, key("ce"));
    lapse(B);
    await lockBarrier(h);
    const c2 = await childN(2);
    await settle();
    expect(children).toHaveLength(2);
    expect(turnTexts(c2)).toEqual([SUPERVISOR_WAKE_PROMPT]);
  });

  for (const withB of [false, true]) {
    it(`D5, the widened arm through the real decision: idle-stopped, a claimable user comment on E${withB ? ", B connected: no spawn" : ", no other session: one spawn"}`, async () => {
      const { h } = await idleStopped();
      if (withB) register(B);
      const e = mkDoc("e");
      const c = comment(e.ydoc, key("ce"));
      h.emit({
        id: `evt_${c}`,
        type: "annotation:created",
        timestamp: Date.now(),
        documentId: e.id,
        payload: { annotationId: c, annotationType: "comment", content: "look", textSnippet: "x" },
      } as TandemEvent);
      await lockBarrier(h);
      await settle();
      if (withB) {
        expect(children).toHaveLength(1);
      } else {
        await childN(2);
        await settle();
        expect(children).toHaveLength(2);
      }
    });
  }

  describe("written since boot (#2358, the restart row; Bryan's pick)", () => {
    function commentEvent(e: Doc, c: string): TandemEvent {
      return {
        id: `evt_${c}`,
        type: "annotation:created",
        timestamp: Date.now(),
        documentId: e.id,
        payload: { annotationId: c, annotationType: "comment", content: "look", textSnippet: "x" },
      } as TandemEvent;
    }

    it("WB1: a claimable comment written before boot does not start a stopped Tandem's Claude; one written after does", async () => {
      const { h } = await idleStopped();
      const e = mkDoc("e");
      const old = comment(e.ydoc, key("old"));
      setWaitingWrittenSinceForTests(clock + 1_000); // boot after the old comment
      expect(tandemWorkWaiting()).toBe(false);
      h.emit(commentEvent(e, old));
      await lockBarrier(h);
      await settle();
      expect(children).toHaveLength(1);
      clock += 2_000;
      const fresh = comment(e.ydoc, key("new"));
      expect(tandemWorkWaiting()).toBe(true);
      h.emit(commentEvent(e, fresh));
      await lockBarrier(h);
      await childN(2);
      await settle();
      expect(children).toHaveLength(2);
    });

    it("WB2: a comment written before boot and edited after it waits", () => {
      const e = mkDoc("e");
      comment(e.ydoc, key("old"), { editedAt: clock + 5_000 });
      setWaitingWrittenSinceForTests(clock + 1_000);
      expect(tandemWorkWaiting()).toBe(true);
    });

    it("WB3: a lapse in the window: B lapses after a restart with only pre-boot claimable work: the re-ask is forwarded and starts nothing", async () => {
      const h = makeSupervisor();
      const c1 = await runningIdle(h);
      register(B);
      const e = mkDoc("e");
      comment(e.ydoc, key("old"));
      userChat(key("oldchat"), e.id);
      setWaitingWrittenSinceForTests(clock + 1_000);
      const writes = c1.stdin.writes.length;
      lapse(B);
      expect(departureSink.mock.calls).toEqual([["departure"]]);
      await lockBarrier(h);
      expect(c1.stdin.writes).toHaveLength(writes);
      expect(tandemWorkWaiting()).toBe(false);
    });
  });

  it("D4, flag off: B lapses with a claimable comment waiting: nothing forwarded, nothing written", async () => {
    const h = makeSupervisor();
    const c1 = await runningIdle(h);
    register(B);
    const e = mkDoc("e");
    comment(e.ydoc, key("ce"));
    vi.stubEnv("TANDEM_OWNERSHIP", "");
    const writes = c1.stdin.writes.length;
    lapse(B);
    expect(departureSink).not.toHaveBeenCalled();
    await lockBarrier(h);
    expect(c1.stdin.writes).toHaveLength(writes);
  });
});
