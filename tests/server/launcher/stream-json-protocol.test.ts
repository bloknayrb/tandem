/**
 * End-to-end coverage for the launcher's `stream-json` wire protocol (#1267).
 *
 * The auto-launcher is default-on, so its spawn arguments and its stdin
 * bootstrap turn are exercised by every user on every launch — yet #1267
 * shipped both with no coverage, because the protocol is only observable from
 * the process on the *other* end of the pipe. These tests supply that process:
 * `stub-claude-cli.cjs` stands in for the `claude` binary, records the argument
 * vector it was handed, and validates the user turn the supervisor writes.
 *
 * There is deliberately no `spawn` mocking anywhere here — a mock would assert
 * that the supervisor calls a function we wrote, not that a real child process
 * receives a well-formed protocol.
 *
 * See the header of `stub-claude-cli.cjs` for how the stub gets exec'd
 * cross-platform (the "pid-name trick").
 */

import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TandemEvent } from "../../../src/server/events/types.js";
import type { IntegrationsFile } from "../../../src/server/integrations/schema.js";
import { createIntegrationsStore } from "../../../src/server/integrations/storage.js";
import type { Supervisor } from "../../../src/server/launcher/supervisor.js";
import { buildClaudeArgs, createSupervisor } from "../../../src/server/launcher/supervisor.js";
import {
  CLAUDE_STREAM_JSON_FLAGS,
  SUPERVISOR_INITIAL_PROMPT,
  SUPERVISOR_WAKE_PROMPT,
} from "../../../src/shared/launcher/contract.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_SOURCE = path.join(HERE, "stub-claude-cli.cjs");
/** Sentinel for `TANDEM_CLAUDE_CMD`, so the recorded argv proves the binary the
 * supervisor chose actually reached the reaper's argument vector. */
const CLAUDE_BIN_SENTINEL = "tandem-stub-claude-sentinel";
const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

const ENV_KEYS = [
  "TANDEM_REAPER_PATH",
  "TANDEM_TAURI_SIDECAR",
  "NODE_ENV",
  "TANDEM_CLAUDE_CMD",
  "TANDEM_STUB_CLAUDE_RECORD_DIR",
  "TANDEM_STUB_CLAUDE_TURN_DELAY_MS",
] as const;

let tmpDir: string;
let spawnDir: string;
let recordDir: string;
/** Extra spawn dirs minted mid-test (the relocation cases need a second
 * folder). Cleaned by the same retry-tolerant sweep as the fixed three. */
let extraDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

interface SpawnRecord {
  pid: number;
  reaperFirstArg: string;
  claudeBin: string;
  claudeArgs: string[];
  cwd: string;
}

interface TurnRecord {
  pid: number;
  seq: number;
  at: number;
  raw: string;
  problems: string[];
  text: string | null;
}

/** Every turn the stub has received, in arrival order.
 *
 * Ordered by wall-clock first and `seq` only as a tie-break: `seq` restarts at
 * 0 in each spawned stub, so across a restart two records share seq 0 and a
 * seq-only sort silently interleaves the two processes' turns. */
function turnRecords(): TurnRecord[] {
  return recordsWithPrefix<TurnRecord>("turn-").sort((a, b) => a.at - b.at || a.seq - b.seq);
}

/** Turns received by one specific stub process. Use this rather than an index
 * into `turnRecords()` whenever a restart is involved — it is immune to
 * cross-process ordering entirely. */
function turnsFromPid(pid: number): TurnRecord[] {
  return turnRecords().filter((t) => t.pid === pid);
}

/**
 * A supervisor whose event subscription is captured rather than wired to the
 * real queue, so a test can push an event without standing up Y.Doc observers.
 *
 * The queue's own gates (Solo hold, privacy hold) are deliberately NOT modelled
 * here — they run before any subscriber is called, and pinning them against a
 * fake would only assert that the fake behaves like the fake. What the real
 * default subscription does in Solo is covered where the real queue lives, in
 * `event-queue.test.ts`. These tests own the other half: given an event that
 * has already cleared those gates, what does the supervisor do with it?
 */
function supervisorWithEventSink(extra?: { wakeLatchMs?: number }): {
  sup: Supervisor;
  emit: (event: TandemEvent) => void;
  subscriberCount: () => number;
} {
  const callbacks = new Set<(event: TandemEvent) => void>();
  const sup = createSupervisor({
    integrationsBase: tmpDir,
    wakeLatchMs: extra?.wakeLatchMs,
    subscribeToEvents: (cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    },
  });
  return {
    sup,
    emit: (event) => {
      for (const cb of [...callbacks]) cb(event);
    },
    subscriberCount: () => callbacks.size,
  };
}

let eventSeq = 0;
function annotationEvent(): TandemEvent {
  return {
    id: `evt_${eventSeq++}`,
    type: "annotation:created",
    timestamp: Date.now(),
    documentId: "d1",
    payload: { annotationId: `ann_${eventSeq}`, content: "look at this", textSnippet: "x" },
  } as TandemEvent;
}

function documentEvent(): TandemEvent {
  return {
    id: `evt_${eventSeq++}`,
    type: "document:switched",
    timestamp: Date.now(),
    documentId: "d1",
    payload: { fileName: "other.md" },
  } as TandemEvent;
}

function chatEvent(): TandemEvent {
  return {
    id: `evt_${eventSeq++}`,
    type: "chat:message",
    timestamp: Date.now(),
    documentId: "d1",
    payload: { messageId: `msg_${eventSeq}`, content: "are you there?", author: "user" },
  } as TandemEvent;
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-json-")));
  spawnDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-json-cwd-")));
  recordDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-json-rec-")));

  // The pid-name trick: the reaper's first argument is `String(process.pid)`,
  // and node treats its first argument as the script path. Copying the stub to
  // that exact name inside the spawn cwd makes node run it.
  fs.copyFileSync(STUB_SOURCE, path.join(spawnDir, String(process.pid)));
  extraDirs = [];

  // reaperPath()'s dev override only applies when NODE_ENV !== "production"
  // AND TANDEM_TAURI_SIDECAR !== "1".
  process.env.NODE_ENV = "test";
  delete process.env.TANDEM_TAURI_SIDECAR;
  process.env.TANDEM_REAPER_PATH = process.execPath;
  process.env.TANDEM_CLAUDE_CMD = CLAUDE_BIN_SENTINEL;
  process.env.TANDEM_STUB_CLAUDE_RECORD_DIR = recordDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const dir of [tmpDir, spawnDir, recordDir, ...extraDirs]) {
    // Retries, and a swallow of last resort. These are OS temp dirs, and on
    // Windows a just-exited child can still hold its cwd and its running
    // script file briefly — `spawnDir` is both. Letting that surface would red
    // a test whose assertions all passed, blaming the product for a cleanup
    // race; the dirs are `mkdtemp`-unique, so a leaked one is inert.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (err) {
      console.error(`[test] could not remove temp dir ${dir}:`, (err as Error).message);
    }
  }
});

/**
 * `workingDirectory` defaults to `spawnDir` and must normally be SET, not just
 * passed as a startFresh() override: a supervisor-initiated restart rebuilds
 * the plan with no override and falls back to os.homedir(), where the stub does
 * not exist.
 *
 * Pass `null` to omit the key entirely. That fixture exists for the one
 * assertion that cannot be made with it present — that a bare relaunch leaves
 * the key ABSENT. With `workingDirectory: spawnDir` configured, a bare relaunch
 * resolves to exactly `spawnDir`, so `persistWorkingDirectory`'s
 * unchanged-value early return makes the write a no-op whether or not the
 * intent guard exists, and the test cannot fail.
 */
async function writeClaudeIntegration(workingDirectory: string | null = spawnDir): Promise<void> {
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
        ...(workingDirectory === null ? {} : { workingDirectory }),
      },
    ],
  };
  await createIntegrationsStore(tmpDir).write(file);
}

/** The claude-code entry as currently persisted. */
async function readClaudeEntry(): Promise<Record<string, unknown> | undefined> {
  const file = await createIntegrationsStore(tmpDir).read();
  return file.integrations.find((i) => i.kind === "claude-code") as
    | Record<string, unknown>
    | undefined;
}

function recordsWithPrefix<T>(prefix: string): T[] {
  return fs
    .readdirSync(recordDir)
    .filter((n) => n.startsWith(prefix) && n.endsWith(".json"))
    .map((n) => JSON.parse(fs.readFileSync(path.join(recordDir, n), "utf8")) as T);
}

/** Poll until `probe` returns a truthy value, or fail with `label`. */
async function waitFor<T>(
  probe: () => T | null | undefined,
  label: string,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("launcher stream-json protocol — fresh spawn (#1267)", () => {
  it("hands the CLI the stream-json flag vector and a fresh --session-id", async () => {
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await sup.startFresh(spawnDir);
      const [spawnRec] = await waitFor(() => {
        const recs = recordsWithPrefix<SpawnRecord>("spawn-");
        return recs.length > 0 ? recs : null;
      }, "the stub CLI to record its argv");

      // The reaper contract: argv[0] is the supervisor's pid, argv[1] is the
      // Claude binary, the rest is buildClaudeArgs().
      expect(spawnRec.reaperFirstArg).toBe(String(process.pid));
      expect(spawnRec.claudeBin).toBe(CLAUDE_BIN_SENTINEL);
      expect(spawnRec.cwd).toBe(spawnDir);

      expect(spawnRec.claudeArgs.slice(0, CLAUDE_STREAM_JSON_FLAGS.length)).toEqual([
        ...CLAUDE_STREAM_JSON_FLAGS,
      ]);
      const tail = spawnRec.claudeArgs.slice(CLAUDE_STREAM_JSON_FLAGS.length);
      expect(tail[0]).toBe("--session-id");
      expect(tail).toHaveLength(2);
      expect(tail[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(spawnRec.claudeArgs).not.toContain("--resume");
      // The whole vector must be exactly what the exported builder produces.
      expect(spawnRec.claudeArgs).toEqual(buildClaudeArgs({ sessionId: tail[1], resuming: false }));
    } finally {
      await sup.stop();
    }
  });

  // This is also the deadlock regression test. The stub emits `init` only after
  // a turn arrives (as the real CLI does), so a supervisor that waits for `init`
  // before writing never writes at all and this test times out. Verified by
  // positive control on 2026-08-04: reintroducing the wait reds exactly this
  // test.
  it("writes a well-formed user turn on spawn, without waiting for the CLI's init line", async () => {
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await sup.startFresh(spawnDir);
      const [turn] = await waitFor(() => {
        const recs = recordsWithPrefix<TurnRecord>("turn-");
        return recs.length > 0 ? recs : null;
      }, "the stub CLI to receive a user turn");

      // The stub is the judge of well-formedness — it lists every way the
      // envelope deviates from the stream-json user-turn shape.
      expect(turn.problems).toEqual([]);
      expect(turn.text).toBe(SUPERVISOR_INITIAL_PROMPT);
      // Exactly one JSON object, newline-framed — no pretty-printing.
      expect(turn.raw).not.toContain("\n");
      expect(JSON.parse(turn.raw)).toEqual({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: SUPERVISOR_INITIAL_PROMPT }] },
      });
    } finally {
      await sup.stop();
    }
  });

  // DELIBERATELY ABSENT: an integration-level test that the stdout framer
  // reassembles a split `init` line.
  //
  // One existed and asserted "a turn was received", on the reasoning that a
  // supervisor parsing raw chunks would never recognise `subtype: "init"` and
  // so would never send the turn. That reasoning died with the init deadlock
  // fix: the bootstrap turn is now written on spawn, before any stdout is read,
  // so the turn proves nothing about parsing. Confirmed by negative control —
  // suppressing the stub's `init` line ENTIRELY left the test green, i.e. it
  // would also have passed with the framer deleted.
  //
  // It is removed rather than reworded because after the fix the supervisor
  // does not act on any stdout line: what remains is the (still unconfirmed)
  // `result.errors` branch and pass-through logging. There is currently no
  // observable behaviour for a framing bug to break at this level.
  //
  // Framing and UTF-8 decoding ARE covered, as direct unit tests over
  // `createLineFramer` in supervisor.test.ts — including a negative control
  // showing `chunk.toString()` yields U+FFFD on a split multi-byte character.
  // Integration-level coverage becomes meaningful again in Group K, when
  // `result` messages start driving idle tracking; add it back there, with the
  // assertion keyed on idleness rather than on the turn.
});

describe("launcher stream-json protocol — resumed spawn (#1267)", () => {
  it("passes --resume and sends NO bootstrap turn", async () => {
    await writeClaudeIntegration();
    fs.writeFileSync(
      path.join(tmpDir, "launcher-session.json"),
      JSON.stringify({ sessionId: VALID_UUID }),
      "utf8",
    );
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      // start() (not startFresh) so the saved session survives into the plan.
      await sup.start();
      const [spawnRec] = await waitFor(() => {
        const recs = recordsWithPrefix<SpawnRecord>("spawn-");
        return recs.length > 0 ? recs : null;
      }, "the stub CLI to record its argv");

      expect(spawnRec.claudeArgs.slice(-2)).toEqual(["--resume", VALID_UUID]);
      expect(spawnRec.claudeArgs).not.toContain("--session-id");

      // A resumed conversation already contains the bootstrap prompt; sending
      // it again would inject a duplicate turn. The stub records a turn the
      // instant one arrives, so a stable absence over a window that comfortably
      // exceeds the observed init→turn latency is the check available to us.
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(recordsWithPrefix<TurnRecord>("turn-")).toHaveLength(0);
    } finally {
      await sup.stop();
    }
  });
});

// Group K: the supervisor, not the channel shim, turns Tandem activity into a
// Claude turn. The spike (docs/spikes/channel-push-stream-json.md) measured a
// channel notification arriving at the shim and producing no turn at all, with
// an aliveness control ruling out a dead process — so this path is load-bearing
// for every event-driven interaction the product has, not an optimisation.
describe("supervisor-owned turn delivery (#1266)", () => {
  /** Wait until `n` turns have been recorded, then hold still long enough that
   * an (n+1)th would have shown up. Both halves matter: the first proves the
   * wake fired, the second is what distinguishes "coalesced into one" from
   * "the second one is merely late". */
  async function expectExactlyTurns(n: number, label: string): Promise<TurnRecord[]> {
    const turns = await waitFor(() => {
      const recs = turnRecords();
      return recs.length >= n ? recs : null;
    }, label);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(turnRecords()).toHaveLength(n);
    return turns;
  }

  it("wakes an idle session when Tandem activity arrives", async () => {
    await writeClaudeIntegration();
    const { sup, emit } = supervisorWithEventSink();
    try {
      await sup.startFresh(spawnDir);
      await waitFor(() => (turnRecords().length > 0 ? true : null), "the bootstrap turn");

      emit(annotationEvent());

      const turns = await expectExactlyTurns(2, "the wake turn");
      expect(turns[0].text).toBe(SUPERVISOR_INITIAL_PROMPT);
      expect(turns[1].text).toBe(SUPERVISOR_WAKE_PROMPT);
      // The wake must be as well-formed as the bootstrap turn — it goes through
      // the same envelope, and a malformed one would be silently ignored.
      expect(turns[1].problems).toEqual([]);
    } finally {
      await sup.stop();
    }
  }, 25_000);

  // `chat:message` is the one wake-worthy type that isn't an `annotation:*`
  // prefix match, so it is the one a dropped clause in `isWakeWorthy` would
  // silently lose. It is also the only type the queue delivers in Solo, which
  // makes it the sole wake path a Solo user has.
  // A wake owed when the child died must survive into the next spawn. The
  // resumed path sends no bootstrap turn, so without the carry-over the
  // notification is discarded and the user's comment goes unannounced until
  // some later, unrelated event happens to wake the session.
  it("carries an undelivered wake across a crash restart", async () => {
    // Hold the bootstrap turn open so the event lands while it is in flight and
    // becomes a pending wake rather than being delivered immediately.
    process.env.TANDEM_STUB_CLAUDE_TURN_DELAY_MS = "600000";
    await writeClaudeIntegration();
    const { sup, emit } = supervisorWithEventSink();
    try {
      // Must start FRESH. A resumed spawn killed inside RESUME_CONFIRM_MS has
      // its saved session cleared as presumed-bad, so the restart would come
      // back fresh and its bootstrap turn would mask the carry-over. A fresh
      // spawn is "confirmed" from the start, so its session survives the crash
      // and the restart genuinely takes the no-bootstrap-turn resume path.
      await sup.startFresh(spawnDir);
      const first = sup.status();
      if (!first.running) throw new Error("expected a running supervisor");
      await waitFor(() => (turnRecords().length >= 1 ? true : null), "the bootstrap turn");

      // Deferred behind the bootstrap turn, which the stub will never answer.
      emit(annotationEvent());

      process.kill(first.reaperPid, "SIGKILL");

      // Keyed on the RESPAWNED process, not on an index into all turns: the
      // stub's per-process seq restarts at 0, so "turn 1 overall" is ambiguous
      // across a restart. The respawn resumes, so it sends no bootstrap turn of
      // its own — any turn it does send is the carried-over wake.
      const second = await waitFor(() => {
        const s = sup.status();
        return s.running && s.reaperPid !== first.reaperPid ? s : null;
      }, "an automatic restart with a new reaper");
      const carried = await waitFor(
        () => {
          const recs = turnsFromPid(second.reaperPid);
          return recs.length > 0 ? recs : null;
        },
        "the carried-over wake on the respawned session",
        15_000,
      );
      expect(carried[0].text).toBe(SUPERVISOR_WAKE_PROMPT);
    } finally {
      await sup.stop();
    }
  }, 30_000);

  it("wakes on chat as well as annotations", async () => {
    await writeClaudeIntegration();
    const { sup, emit } = supervisorWithEventSink();
    try {
      await sup.startFresh(spawnDir);
      await waitFor(() => (turnRecords().length > 0 ? true : null), "the bootstrap turn");

      emit(chatEvent());

      const turns = await expectExactlyTurns(2, "the wake turn from chat");
      expect(turns[1].text).toBe(SUPERVISOR_WAKE_PROMPT);
    } finally {
      await sup.stop();
    }
  }, 25_000);

  it("coalesces a burst arriving mid-turn into exactly one wake", async () => {
    // Hold each turn open long enough that the whole burst lands inside the
    // bootstrap turn's in-flight window.
    process.env.TANDEM_STUB_CLAUDE_TURN_DELAY_MS = "700";
    await writeClaudeIntegration();
    const { sup, emit } = supervisorWithEventSink();
    try {
      await sup.startFresh(spawnDir);
      for (let i = 0; i < 5; i++) emit(annotationEvent());

      const turns = await expectExactlyTurns(2, "one coalesced wake turn");
      expect(turns[1].text).toBe(SUPERVISOR_WAKE_PROMPT);
    } finally {
      await sup.stop();
    }
  });

  it("does not wake on document lifecycle events", async () => {
    await writeClaudeIntegration();
    const { sup, emit } = supervisorWithEventSink();
    try {
      await sup.startFresh(spawnDir);
      await waitFor(() => (turnRecords().length > 0 ? true : null), "the bootstrap turn");

      for (let i = 0; i < 3; i++) emit(documentEvent());
      // Only the bootstrap turn. Tab switching must not conscript the session.
      await expectExactlyTurns(1, "no additional turn");

      // Positive control from the SAME sample. Without it this test would also
      // pass with the whole subscription severed — "no wake" would then be true
      // for the wrong reason. Proving the emit path is still live is what makes
      // the silence above attributable to the filter.
      emit(annotationEvent());
      const turns = await expectExactlyTurns(2, "the control wake");
      expect(turns[1].text).toBe(SUPERVISOR_WAKE_PROMPT);
    } finally {
      await sup.stop();
    }
  }, 25_000);

  // The latch is the safeguard against wakes wedging permanently when a
  // `result` envelope goes missing. Left untested, the safeguard against
  // silent failure would itself be unverified — so the window is injectable.
  it("breaks the in-flight latch when no result arrives", async () => {
    // Stub never answers within the test's lifetime, so `turnInFlight` would
    // stay set forever without the latch.
    process.env.TANDEM_STUB_CLAUDE_TURN_DELAY_MS = "600000";
    await writeClaudeIntegration();
    const { sup, emit } = supervisorWithEventSink({ wakeLatchMs: 300 });
    try {
      await sup.startFresh(spawnDir);
      await waitFor(() => (turnRecords().length > 0 ? true : null), "the bootstrap turn");

      // Arrives while the (never-answered) bootstrap turn is in flight.
      emit(annotationEvent());

      const turns = await expectExactlyTurns(2, "the wake released by the latch");
      expect(turns[1].text).toBe(SUPERVISOR_WAKE_PROMPT);
    } finally {
      await sup.stop();
    }
  }, 25_000);

  // The docblock on `teardownTurnDelivery` warns specifically about a
  // superseded spawn's subscription outliving it. A crash-restart is the path
  // that produces one, so the count must return to 1 — not climb to 2.
  it("does not accumulate subscriptions across a crash restart", async () => {
    await writeClaudeIntegration();
    const { sup, subscriberCount } = supervisorWithEventSink();
    try {
      await sup.startFresh(spawnDir);
      const first = sup.status();
      if (!first.running) throw new Error("expected a running supervisor");
      expect(subscriberCount()).toBe(1);

      // Kill the reaper out from under the supervisor — an unrequested exit,
      // so the restart path (not the stop path) runs.
      process.kill(first.reaperPid, "SIGKILL");

      await waitFor(() => {
        const s = sup.status();
        return s.running && s.reaperPid !== first.reaperPid ? s : null;
      }, "an automatic restart with a new reaper");
      expect(subscriberCount()).toBe(1);
    } finally {
      await sup.stop();
    }
  }, 25_000);

  // The reason this whole group exists. #1267 justified sending no bootstrap
  // turn on resume by arguing the channel would push work to the session — and
  // the spike showed it does not, which left a resumed session permanently
  // inert. It now wakes on activity instead.
  it("wakes a RESUMED session, which gets no bootstrap turn", async () => {
    await writeClaudeIntegration();
    fs.writeFileSync(
      path.join(tmpDir, "launcher-session.json"),
      JSON.stringify({ sessionId: VALID_UUID }),
      "utf8",
    );
    const { sup, emit } = supervisorWithEventSink();
    try {
      await sup.start();
      await waitFor(() => {
        const recs = recordsWithPrefix<SpawnRecord>("spawn-");
        return recs.length > 0 ? recs : null;
      }, "the stub CLI to record its argv");
      expect(turnRecords()).toHaveLength(0);

      emit(annotationEvent());

      const turns = await expectExactlyTurns(1, "the wake turn on a resumed session");
      expect(turns[0].text).toBe(SUPERVISOR_WAKE_PROMPT);
    } finally {
      await sup.stop();
    }
  });

  // A subscription outliving its child would write wake turns into a dead pipe
  // forever, and would keep `getSubscriberCount()` claiming something is
  // attached after everything has stopped.
  it("detaches its event subscription when the child stops", async () => {
    await writeClaudeIntegration();
    const { sup, subscriberCount } = supervisorWithEventSink();
    await sup.startFresh(spawnDir);
    expect(subscriberCount()).toBe(1);

    await sup.stop();
    await waitFor(() => (subscriberCount() === 0 ? true : null), "the subscription to detach");
  });

  // `stopInternal` has an escalation path that gives up on a reaper surviving
  // SIGKILL: it logs "abandoning handle", drops `child`, and returns — with the
  // process still alive, so its `exit` never fires. Releasing the subscription
  // only from the `exit` handler would therefore leak it for the life of the
  // server, and hand the NEXT start a second live subscription. Simulated by
  // neutering `kill()` on the handle, which is what an unkillable reaper looks
  // like from here.
  it("releases the subscription even when the child never exits", async () => {
    await writeClaudeIntegration();
    const { sup, subscriberCount } = supervisorWithEventSink();
    await sup.startFresh(spawnDir);
    const running = sup.status();
    if (!running.running) throw new Error("expected a running supervisor");
    expect(subscriberCount()).toBe(1);

    // `stopInternal` signals via `ChildProcess#kill`, not `process.kill`, so
    // the prototype is where an unkillable reaper has to be simulated. Neutered
    // rather than mocked out: the supervisor must still walk its real SIGTERM →
    // SIGKILL → give-up escalation, which is the branch under test.
    //
    // Patching a global prototype is only safe because vitest's default `forks`
    // pool gives each test FILE its own process (no pool override in
    // vitest.config.ts) — the patch cannot reach a concurrently running file.
    // Restored in `finally` regardless.
    const realKill = ChildProcess.prototype.kill;
    ChildProcess.prototype.kill = () => true;
    try {
      await sup.stop();
      // The handle was abandoned with the process still alive, so no `exit`
      // fired and no exit-handler teardown ran. This must still be 0.
      expect(subscriberCount()).toBe(0);
      expect(sup.status().running).toBe(false);
    } finally {
      ChildProcess.prototype.kill = realKill;
      // Reap the deliberately-orphaned reaper and WAIT for it to actually go.
      // Its cwd is `spawnDir`, and Windows refuses to remove a directory that
      // is a live process's working directory — so returning before it dies
      // makes `afterEach`'s cleanup throw EPERM and reds a test that passed.
      try {
        process.kill(running.reaperPid, "SIGKILL");
      } catch {
        // already gone
      }
      await waitFor(
        () => {
          try {
            // Signal 0 probes liveness without delivering anything.
            process.kill(running.reaperPid, 0);
            return null;
          } catch {
            return true;
          }
        },
        "the orphaned reaper to die",
        10_000,
      );
    }
  }, 30_000);
});

describe("supervisor lastError lifecycle (#1267)", () => {
  it("clears a previous fatal error once a spawn succeeds, and stays clear after stop", async () => {
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      // 1. Unrunnable reaper (a directory: passes existsSync, cannot exec) →
      //    ENOENT on Windows / EACCES on POSIX. Either sets lastError.
      process.env.TANDEM_REAPER_PATH = os.tmpdir();
      await expect(sup.startFresh(spawnDir)).rejects.toThrow();
      const failed = sup.status();
      expect(failed.running).toBe(false);
      expect(failed.lastError).toBeTruthy();

      // 2. A working spawn must retire it. Before #1267's fix there were four
      //    assignment sites and zero clears.
      process.env.TANDEM_REAPER_PATH = process.execPath;
      await sup.startFresh(spawnDir);
      const running = sup.status();
      expect(running.running).toBe(true);
      expect(running.lastError).toBeUndefined();

      // 3. …and it must not resurface on the next clean stop.
      await sup.stop();
      expect(sup.status()).toEqual({ running: false });
    } finally {
      await sup.stop();
    }
  });
});

describe("supervisor restart lifecycle after relaunch/startFresh (#1267)", () => {
  it("startFresh() lowers stopRequested so an unexpected exit still auto-restarts", async () => {
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      // startFresh() routes through stopInternal(), which raises stopRequested.
      // If it is never lowered, the exit handler below reads the crash as a
      // deliberate stop and the supervisor stays dead forever.
      await sup.startFresh(spawnDir);
      const first = await waitFor(() => {
        const recs = recordsWithPrefix<SpawnRecord>("spawn-");
        return recs.length > 0 ? recs[0] : null;
      }, "the first stub spawn");

      process.kill(first.pid);

      const recs = await waitFor(
        () => {
          const all = recordsWithPrefix<SpawnRecord>("spawn-");
          return all.length >= 2 ? all : null;
        },
        "the supervisor to auto-restart after an unexpected exit",
        12_000,
      );
      expect(recs.map((r) => r.pid)).not.toContain(undefined);
      expect(new Set(recs.map((r) => r.pid)).size).toBeGreaterThanOrEqual(2);
    } finally {
      await sup.stop();
    }
  }, 20_000);

  it("startFresh() twice in a row does not throw 'Supervisor already running'", async () => {
    // stopInternal()'s early-return-on-already-killed used to leave `child`
    // set, which #1267's new `if (child) throw` in spawnOnce() turned into a
    // user-visible relaunch failure.
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await sup.startFresh(spawnDir);
      await expect(sup.startFresh(spawnDir)).resolves.toBeUndefined();
      await expect(sup.relaunch(spawnDir)).resolves.toBeUndefined();
      expect(sup.status().running).toBe(true);
    } finally {
      await sup.stop();
    }
  }, 20_000);
});

/**
 * Relocating Claude to another folder.
 *
 * Two independent defects made "restart Claude here" a no-op that also cost the
 * user their conversation, and both are only observable from the far end of the
 * pipe — hence this harness rather than a mock:
 *
 *   1. Claude Code stores conversations per working directory, so the resumed
 *      spawn ran `--resume <id>` in a folder where that id does not exist. It
 *      exited 1, which `shouldClearSession` read as a failed resume (dropping
 *      the conversation) and `scheduleRestart` read as a crash.
 *   2. That restart rebuilt the plan with NO cwd override, so Claude reappeared
 *      in the folder the user had just moved it out of.
 *
 * Asserting the argv proves (1); asserting the persisted integration proves (2).
 */
describe("launcher — relocating Claude to a different folder", () => {
  /** A second spawn dir carrying the stub under the pid-name trick. */
  function makeSpawnDir(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-json-cwd2-")));
    fs.copyFileSync(STUB_SOURCE, path.join(dir, String(process.pid)));
    extraDirs.push(dir);
    return dir;
  }

  /** The either/or session flag and its value — `buildClaudeArgs` guarantees
   * exactly one of `--resume` / `--session-id` is present. */
  function sessionArg(args: string[]): { flag: string; id: string } {
    const i = args.findIndex((a) => a === "--resume" || a === "--session-id");
    expect(i).toBeGreaterThanOrEqual(0);
    return { flag: args[i], id: args[i + 1] };
  }

  /** Spawn records once at least `n` exist. Sorted by pid purely for
   * determinism — pids are neither monotonic nor recycle-free, so callers must
   * identify records by pid (`find(r => r.pid !== first.pid)`), never by index,
   * whenever more than one spawn is involved. */
  async function spawnsInOrder(n: number): Promise<SpawnRecord[]> {
    return waitFor(() => {
      const recs = recordsWithPrefix<SpawnRecord>("spawn-");
      return recs.length >= n ? recs.sort((a, b) => a.pid - b.pid) : null;
    }, `${n} spawn record(s)`);
  }

  it("starts a fresh session rather than a doomed --resume", async () => {
    await writeClaudeIntegration();
    const otherDir = makeSpawnDir();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await sup.startFresh(spawnDir);
      const [first] = await spawnsInOrder(1);
      const firstArg = sessionArg(first.claudeArgs);
      expect(firstArg.flag).toBe("--session-id");

      await sup.relaunch(otherDir);
      const recs = await spawnsInOrder(2);
      const second = recs.find((r) => r.pid !== first.pid);
      if (!second) throw new Error("no second spawn record");

      // The spawn actually moved...
      expect(second.cwd).toBe(otherDir);
      // ...and did NOT try to resume a conversation that cannot exist there.
      expect(second.claudeArgs).not.toContain("--resume");
      const secondArg = sessionArg(second.claudeArgs);
      expect(secondArg.flag).toBe("--session-id");
      expect(secondArg.id).not.toBe(firstArg.id);
    } finally {
      await sup.stop();
    }
  }, 30_000);

  it("still resumes when the folder has not changed", async () => {
    // The gate must be a cwd comparison, not "any relaunch starts fresh" —
    // otherwise the ordinary recovery restart silently discards the
    // conversation it exists to preserve.
    await writeClaudeIntegration();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await sup.startFresh(spawnDir);
      const [first] = await spawnsInOrder(1);
      const firstArg = sessionArg(first.claudeArgs);

      await sup.relaunch(spawnDir);
      const recs = await spawnsInOrder(2);
      const second = recs.find((r) => r.pid !== first.pid);
      if (!second) throw new Error("no second spawn record");

      expect(second.cwd).toBe(spawnDir);
      const secondArg = sessionArg(second.claudeArgs);
      expect(secondArg.flag).toBe("--resume");
      expect(secondArg.id).toBe(firstArg.id);
    } finally {
      await sup.stop();
    }
  }, 30_000);

  it("records the RESOLVED cwd in the session file", async () => {
    // `writeSavedSession(plan.sessionId, plan.cwd)` must store the resolved
    // path, not the caller's raw string. Every other test passes an already
    // realpath'd dir, so a regression to storing the raw input would be
    // invisible there — and very visible in production, where /tmp resolves to
    // /private/tmp on macOS and casing/8.3 names differ on Windows, mismatching
    // the plan's own realpath on the next boot and starting fresh every launch.
    await writeClaudeIntegration();
    const otherDir = makeSpawnDir();
    const sup = createSupervisor({ integrationsBase: tmpDir });
    try {
      await sup.relaunch(otherDir, { persistCwd: true });
      const recs = await spawnsInOrder(1);
      const saved = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "launcher-session.json"), "utf8"),
      ) as { sessionId: string; cwd: string };
      expect(saved.cwd).toBe(otherDir);
      expect(saved.sessionId).toBe(sessionArg(recs[0].claudeArgs).id);
    } finally {
      await sup.stop();
    }
  }, 30_000);

  describe("persisting the folder (only on explicit intent)", () => {
    for (const op of ["relaunch", "startFresh"] as const) {
      it(`${op}() persists a folder the caller explicitly asked to keep`, async () => {
        await writeClaudeIntegration();
        const otherDir = makeSpawnDir();
        const sup = createSupervisor({ integrationsBase: tmpDir });
        try {
          await sup[op](otherDir, { persistCwd: true });
          await spawnsInOrder(1);
          // Without this, `scheduleRestart` → `buildPlan()` (no override) reads
          // the OLD value and undoes the move on the first crash.
          expect((await readClaudeEntry())?.workingDirectory).toBe(otherDir);
        } finally {
          await sup.stop();
        }
      }, 30_000);

      it(`${op}() does NOT persist a folder the caller merely passed through`, async () => {
        // The recovery chip sends dirname(activeDocumentPath) whenever a tab is
        // open. Durably repointing Claude off that guess would mean clicking
        // "Restart Claude Code" with a stray note open moves Claude forever.
        await writeClaudeIntegration();
        const otherDir = makeSpawnDir();
        const sup = createSupervisor({ integrationsBase: tmpDir });
        try {
          await sup[op](otherDir);
          const recs = await spawnsInOrder(1);
          expect(recs[0].cwd).toBe(otherDir); // moved for THIS spawn...
          expect((await readClaudeEntry())?.workingDirectory).toBe(spawnDir); // ...only
        } finally {
          await sup.stop();
        }
      }, 30_000);
    }

    it("a bare relaunch leaves an unset working directory unset", async () => {
      // Needs the key absent: with it set to spawnDir, a bare relaunch resolves
      // to spawnDir and the unchanged-value early return makes the write a
      // no-op regardless, so the assertion could not fail. The spawn itself
      // fails (homedir has no stub) — irrelevant, the persist is awaited first.
      await writeClaudeIntegration(null);
      const sup = createSupervisor({ integrationsBase: tmpDir });
      try {
        await sup.relaunch();
        expect(await readClaudeEntry()).toBeDefined();
        expect("workingDirectory" in ((await readClaudeEntry()) ?? {})).toBe(false);
      } finally {
        await sup.stop();
      }
    }, 30_000);
  });

  it("a crash-restart lands in the persisted folder, and resumes there", async () => {
    // The headline behaviour. Asserting the persisted CONFIG value is a proxy;
    // this asserts the thing the bug report is about — where Claude actually
    // comes back. Everything between the stored field and the spawn's cwd
    // (`readIntegration`'s predicate, `resolveCwd`, `resolveSafeCwd`) is only
    // exercised here.
    await writeClaudeIntegration();
    const otherDir = makeSpawnDir();
    const sup = createSupervisor({ integrationsBase: tmpDir, restartBackoffsMs: [50] });
    try {
      await sup.relaunch(otherDir, { persistCwd: true });
      const [first] = await spawnsInOrder(1);
      expect(first.cwd).toBe(otherDir);

      process.kill(first.pid);

      const recs = await waitFor(
        () => {
          const all = recordsWithPrefix<SpawnRecord>("spawn-");
          return all.length >= 2 ? all : null;
        },
        "the supervisor to auto-restart after a crash",
        15_000,
      );
      const second = recs.find((r) => r.pid !== first.pid);
      if (!second) throw new Error("no second spawn record");

      // Before the fix this was spawnDir — the folder the user moved out of.
      expect(second.cwd).toBe(otherDir);
      // And the relocated conversation is resumable from its new home, which is
      // the whole product claim.
      const secondArg = sessionArg(second.claudeArgs);
      expect(secondArg.flag).toBe("--resume");
      expect(secondArg.id).toBe(sessionArg(first.claudeArgs).id);
    } finally {
      await sup.stop();
    }
  }, 40_000);

  it("a fresh supervisor resumes into the persisted folder at boot", async () => {
    // The "across a Tandem restart" half of the claim, and the path a Settings
    // working-directory edit takes: a NEW supervisor over the same appData,
    // started with no override at all.
    await writeClaudeIntegration();
    const otherDir = makeSpawnDir();
    const first = createSupervisor({ integrationsBase: tmpDir });
    let firstRec: SpawnRecord;
    try {
      await first.relaunch(otherDir, { persistCwd: true });
      [firstRec] = await spawnsInOrder(1);
    } finally {
      await first.stop();
    }

    const second = createSupervisor({ integrationsBase: tmpDir });
    try {
      await second.start();
      const recs = await spawnsInOrder(2);
      const bootRec = recs.find((r) => r.pid !== firstRec.pid);
      if (!bootRec) throw new Error("no boot spawn record");
      expect(bootRec.cwd).toBe(otherDir);
      expect(sessionArg(bootRec.claudeArgs).flag).toBe("--resume");
    } finally {
      await second.stop();
    }
  }, 40_000);
});
