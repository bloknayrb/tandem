/**
 * The run loop (#1123 brief, R3 "Judged by"): stop and resume, refused
 * resumes, the lock, safe paths, the preflight, the warm-up, endpoint errors,
 * and where a run may write. No model, no network: scripted streams only.
 *
 * Real files are written under `os.tmpdir()`; every path is built with
 * `path.join` and nothing asserts on a separator, so this holds on Windows.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TapRecord } from "../../../../probe/local-model-spike/harness/fetch-tap.js";
import { RUN_DEADLINE_DETAIL } from "../../../../probe/local-model-spike/harness/classify.js";
import { harnessConfig } from "../../../../probe/local-model-spike/harness/model-config.js";
import {
  isSafeRunId,
  makeRunId,
  runDirFor,
  safeTagName,
} from "../../../../probe/local-model-spike/harness/paths.js";
import {
  type PreflightResult,
  preflight,
} from "../../../../probe/local-model-spike/harness/preflight.js";
import type {
  InfraRecord,
  PlannedTrial,
  TrialRecord,
} from "../../../../probe/local-model-spike/harness/record.js";
import {
  acquireLock,
  appendTrial,
  damagedLogLines,
  existingRunDir,
  fixtureProblems,
  lockPath,
  type RunIdentity,
  type RunSession,
  readFixtures,
  readInfra,
  readTrials,
  trialsPath,
} from "../../../../probe/local-model-spike/harness/run-store.js";
import {
  isSilentError,
  MAX_CONSECUTIVE_INFRASTRUCTURE,
  machineRefusal,
  type RunDeps,
  type RunOptions,
  runMeasurement,
} from "../../../../probe/local-model-spike/harness/runner.js";
import { selectScenarios } from "../../../../probe/local-model-spike/harness/scenarios/index.js";
import type { ScriptedTurn } from "../../../../probe/local-model-spike/harness/scripted-model.js";
import {
  runTrial,
  type TrialObservation,
} from "../../../../probe/local-model-spike/harness/trial.js";
import { stubScript } from "./helpers.js";

const TAG = "hf.co/some-org/Model-GGUF:Q4_K_M";

let root: string;
let runsDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-harness-"));
  runsDir = path.join(root, "runs");
  fs.mkdirSync(runsDir);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const OK_PREFLIGHT: PreflightResult = {
  ok: true,
  notes: [],
  facts: {
    exists: true,
    toolSupport: true,
    digest: "sha256:abc",
    ollamaVersion: "0.0.0-test",
    contextLength: 4096,
    serverSettings: "unknown",
  },
};

function options(over: Partial<RunOptions> = {}): RunOptions {
  return {
    modelTag: TAG,
    endpoint: "http://127.0.0.1:11434",
    tier: "chat",
    mode: "screen",
    repeats: 1,
    hardware: "test bench",
    includeExtended: false,
    clearStaleLock: false,
    runsDir,
    ...over,
  };
}

function deps(over: Partial<RunDeps> = {}): RunDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    now: () => new Date("2026-11-12T10:00:00Z"),
    commit: () => ({ commit: "a".repeat(40), dirty: false }),
    config: harnessConfig,
    preflight: async () => OK_PREFLIGHT,
    fingerprint: async () => "fp-1",
    runTrial,
    log: (l) => lines.push(l),
    lines,
    ...over,
  };
}

const ANSWER: ScriptedTurn = { content: ["The document does not say."] };

describe("paths built from a model tag", () => {
  it("turns a tag with a colon and slashes into one safe segment", () => {
    const name = safeTagName(TAG);
    expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(name).not.toMatch(/[:/\\]/);
    expect(isSafeRunId(name)).toBe(true);
    // Two tags that sanitise alike still differ.
    expect(safeTagName("a/b:c")).not.toBe(safeTagName("a:b/c"));
    // A long tag stays short enough for a Windows path.
    expect(safeTagName(`x${"/long".repeat(80)}`).length).toBeLessThanOrEqual(49);
  });

  it("makes a run id with no separator and no colon, built without the host's separator", () => {
    const id = makeRunId({
      date: new Date("2026-11-12T10:00:00Z"),
      tier: "chat",
      mode: "full",
      modelTag: TAG,
    });
    expect(id).toMatch(/^20261112T100000Z-chat-full-[A-Za-z0-9._-]+$/);
    expect(path.basename(runDirFor(id, runsDir))).toBe(id);
    expect(path.dirname(runDirFor(id, runsDir))).toBe(runsDir);
  });

  it("refuses a run id that is a path, a dot name or empty", () => {
    for (const bad of ["..", ".", "", "a/b", "a\\b", "../x", ".hidden", "C:run", "a b"]) {
      expect(isSafeRunId(bad), bad).toBe(false);
      expect(() => runDirFor(bad, runsDir), bad).toThrow();
      expect(() => existingRunDir(bad, runsDir), bad).toThrow();
    }
    expect(() => existingRunDir("20261112T100000Z-none", runsDir)).toThrow(/no such run/);
  });
});

describe("a run", () => {
  it("scores every planned trial once, writes only inside its run directory, and the screen is a subset of the full run", async () => {
    stubScript([ANSWER]);
    const d = deps();
    const result = await runMeasurement(options(), d);
    expect(result.status).toBe("complete");

    const screen = selectScenarios({ tier: "chat", mode: "screen" });
    const full = new Set(selectScenarios({ tier: "chat", mode: "full" }).map((s) => s.id));
    expect(screen).toHaveLength(20);
    for (const s of screen) expect(full.has(s.id), s.id).toBe(true);
    expect(new Set(screen.map((s) => s.group))).toEqual(
      new Set(["editing-request", "unanswerable", "answerable"]),
    );

    const runDir = result.runDir as string;
    const trials = readTrials<TrialRecord>(runDir);
    expect(trials.map((t) => t.scenarioId)).toEqual(screen.map((s) => s.id));
    expect(new Set(trials.map((t) => t.trialId)).size).toBe(20);
    const planned = JSON.parse(
      fs.readFileSync(path.join(runDir, "planned.json"), "utf8"),
    ) as PlannedTrial[];
    expect(planned.map((p) => p.trialId)).toEqual(trials.map((t) => t.trialId));

    // Nothing beside the run directory: the temp root holds only `runs/` and
    // `runs/` holds only this run. (That the PRODUCT's app data also lands
    // inside the run directory is proved in a child process, where the
    // variable is really set before the product loads: `entry-scripts.test.ts`.)
    expect(fs.readdirSync(root)).toEqual(["runs"]);
    expect(fs.readdirSync(runsDir)).toEqual([result.runId]);
    expect(fs.readdirSync(runDir).sort()).toEqual([
      "fixtures.json",
      "identity.json",
      "planned.json",
      "trials.jsonl",
    ]);
    // The documents the model saw are stored with the run, each matching every
    // trial that ran on it (review M3: the reader sees these, not the checkout's).
    const stored = readFixtures(runDir);
    expect(Object.keys(stored).sort()).toEqual([...new Set(trials.map((t) => t.fixture))].sort());
    expect(fixtureProblems(stored, trials)).toEqual([]);
    for (const t of trials) expect(t.documentHash).toBe(stored[t.fixture].sha256);
    // A stored text edited afterwards, or a trial whose document differs, is caught.
    const key = trials[0].fixture;
    expect(
      fixtureProblems(
        { ...stored, [key]: { ...stored[key], text: `${stored[key].text}!` } },
        trials,
      ).join("\n"),
    ).toMatch(/does not match its own hash/);
    expect(
      fixtureProblems(stored, [{ ...trials[0], documentHash: "0".repeat(64) }]).join("\n"),
    ).toMatch(/ran on a different text/);
    expect(fixtureProblems({}, trials.slice(0, 1)).join("\n")).toMatch(
      /is not stored in fixtures.json/,
    );
    // The lock is released.
    expect(fs.existsSync(lockPath(runDir))).toBe(false);
    // A progress line per trial, with timings and an estimate.
    expect(
      d.lines.filter((l) => /^\[\d+\/20\] .* first text .* total .* min left$/.test(l)),
    ).toHaveLength(20);
  });

  it("stops after consecutive endpoint errors without scoring them, and a resume runs exactly the missing trials", async () => {
    // Trials 1-4 answer; then the endpoint goes away.
    let n = 0;
    stubScript(() => {
      n += 1;
      return n <= 4 ? ANSWER : { connectionError: "ECONNREFUSED" };
    });
    const first = await runMeasurement(options(), deps());
    expect(first.status).toBe("stopped");
    expect(first.reason).toMatch(/--resume/);
    const runDir = first.runDir as string;
    expect(readTrials<TrialRecord>(runDir)).toHaveLength(4);
    expect(readInfra<InfraRecord>(runDir)).toHaveLength(MAX_CONSECUTIVE_INFRASTRUCTURE);
    expect(first.scoredThisSession).toBe(4);

    // Resume with the endpoint back.
    stubScript([ANSWER]);
    const warmUps = { count: 0 };
    const second = await runMeasurement(
      options({ resume: first.runId }),
      deps({
        preflight: async () => {
          warmUps.count += 1;
          return OK_PREFLIGHT;
        },
        now: () => new Date("2026-11-13T09:00:00Z"),
      }),
    );
    expect(second.status).toBe("complete");
    expect(second.runId).toBe(first.runId);
    expect(second.scoredThisSession).toBe(16);
    expect(warmUps.count).toBe(1); // the preflight (and its warm-up) runs at every start

    const trials = readTrials<TrialRecord>(runDir);
    const ids = trials.map((t) => t.trialId);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20); // no duplicate
    const planned = selectScenarios({ tier: "chat", mode: "screen" }).map((s) => `${s.id}#1`);
    expect([...ids].sort()).toEqual([...planned].sort()); // none missing
    // The date is recorded again, as a second session of the same run.
    const identity = JSON.parse(fs.readFileSync(path.join(runDir, "identity.json"), "utf8")) as {
      sessions: { startedAt: string }[];
    };
    expect(identity.sessions.map((s) => s.startedAt)).toEqual([
      "2026-11-12T10:00:00.000Z",
      "2026-11-13T09:00:00.000Z",
    ]);
  });

  it("holds back errors that came before any text, and stops instead of scoring a server that keeps failing", async () => {
    stubScript([{ status: 500 }]);
    const result = await runMeasurement(options(), deps());
    expect(result.status).toBe("stopped");
    expect(result.scoredThisSession).toBe(0);
    expect(readTrials<TrialRecord>(result.runDir as string)).toEqual([]);
    expect(readInfra<InfraRecord>(result.runDir as string).map((i) => i.detail)).toEqual([
      "held-silent-error:http-500",
      "held-silent-error:http-500",
      "held-silent-error:http-500",
    ]);
  });

  it("on a resume, a trial it already stopped on is scored if it fails the same way: the run can finish", async () => {
    stubScript([{ status: 500 }]);
    const first = await runMeasurement(options(), deps());
    expect(first.status).toBe("stopped");
    const runDir = first.runDir as string;

    // Still failing after the person looked at the endpoint: the model's failure.
    let n = 0;
    stubScript(() => {
      n += 1;
      return n <= 3 ? { status: 500 } : ANSWER;
    });
    const second = await runMeasurement(options({ resume: first.runId }), deps());
    expect(second.status).toBe("complete");
    const trials = readTrials<TrialRecord>(runDir);
    expect(trials).toHaveLength(20);
    expect(new Set(trials.map((t) => t.trialId)).size).toBe(20);
    expect(trials.filter((t) => t.ending === "error").map((t) => t.detail)).toEqual([
      "http-500",
      "http-500",
      "http-500",
    ]);
  });

  it("counts endpoint errors and held errors in one streak, in either order, and logs what it held", async () => {
    for (const order of [
      [{ status: 500 }, { status: 500 }, { connectionError: "ECONNREFUSED" }],
      [{ connectionError: "ECONNREFUSED" }, { status: 500 }, { connectionError: "ECONNREFUSED" }],
    ] as ScriptedTurn[][]) {
      let n = 0;
      stubScript(() => order[Math.min(n++, order.length - 1)]);
      const result = await runMeasurement(
        options(),
        deps({ now: () => new Date(Date.UTC(2026, 10, 12, 10, 0, order.length + n)) }),
      );
      expect(result.status).toBe("stopped");
      expect(readTrials<TrialRecord>(result.runDir as string)).toEqual([]);
      // Every attempt is logged and counted, the held ones included.
      expect(readInfra<InfraRecord>(result.runDir as string)).toHaveLength(3);
      fs.rmSync(result.runDir as string, { recursive: true, force: true });
    }
  });

  describe("a timeout before any text is silent (round 3, M2)", () => {
    /** A trial that answers 500 before any text, reported as the loop timing out instead. */
    const TIMED_OUT: ScriptedTurn = { status: 500 };
    /** Runs the real trial, then turns a no-text error into a no-text timeout. */
    const timingOut =
      (when: (n: number) => boolean): RunDeps["runTrial"] =>
      async (input) => {
        const obs = await runTrial(input);
        timingOut.calls += 1;
        if (!when(timingOut.calls) || obs.loop === null) return obs;
        return {
          ...obs,
          loop: {
            ...obs.loop,
            metrics: { ...obs.loop.metrics, exit: "timeout", errorMessage: undefined },
          },
        };
      };
    timingOut.calls = 0;
    beforeEach(() => {
      timingOut.calls = 0;
    });

    it("a server that accepts connections and never answers stops the run as infrastructure, not FAIL", async () => {
      stubScript([TIMED_OUT]);
      const d = deps({ runTrial: timingOut(() => true) });
      const result = await runMeasurement(options(), d);
      expect(result.status).toBe("stopped");
      expect(result.reason).toMatch(/that looks like the server, not the model/);
      expect(result.scoredThisSession).toBe(0);
      expect(readTrials<TrialRecord>(result.runDir as string)).toEqual([]);
      expect(readInfra<InfraRecord>(result.runDir as string).map((i) => i.detail)).toEqual([
        "held-silent-error:timeout",
        "held-silent-error:timeout",
        "held-silent-error:timeout",
      ]);
      expect(
        d.lines.some((l) =>
          /TIMEOUT with nothing from the failing request \(timeout\) — held$/.test(l),
        ),
      ).toBe(true);
    });

    it("joins one streak with endpoint errors and silent errors, in either order", async () => {
      // n is the trial's number in the run; the stub's answer for it, and whether it times out.
      for (const order of [
        // timeout, timeout, endpoint error
        [
          { turn: TIMED_OUT, timeout: true },
          { turn: TIMED_OUT, timeout: true },
          { turn: { connectionError: "ECONNREFUSED" }, timeout: false },
        ],
        // endpoint error, silent error, timeout
        [
          { turn: { connectionError: "ECONNREFUSED" }, timeout: false },
          { turn: { status: 500 }, timeout: false },
          { turn: TIMED_OUT, timeout: true },
        ],
      ] as { turn: ScriptedTurn; timeout: boolean }[][]) {
        timingOut.calls = 0;
        let n = 0;
        stubScript(() => order[Math.min(n++, order.length - 1)].turn);
        const result = await runMeasurement(
          options(),
          deps({
            runTrial: timingOut((k) => order[Math.min(k - 1, order.length - 1)].timeout),
            now: () => new Date(Date.UTC(2026, 10, 12, 11, 0, n)),
          }),
        );
        expect(result.status).toBe("stopped");
        expect(readTrials<TrialRecord>(result.runDir as string)).toEqual([]);
        expect(readInfra<InfraRecord>(result.runDir as string)).toHaveLength(3);
        fs.rmSync(result.runDir as string, { recursive: true, force: true });
      }
    });

    it("a timeout with streamed reasoning but no text is the model's, not the server's", async () => {
      stubScript([TIMED_OUT]);
      const reasoning: RunDeps["runTrial"] = async (input) => {
        const obs = await timingOut(() => true)(input);
        // The shipped client streamed reasoning in a separate field.
        return { ...obs, fetches: obs.fetches.map((f) => ({ ...f, separateReasoningChars: 500 })) };
      };
      const result = await runMeasurement(options(), deps({ runTrial: reasoning }));
      expect(result.status).toBe("complete");
      const trials = readTrials<TrialRecord>(result.runDir as string);
      expect(trials).toHaveLength(20);
      expect(trials.every((t) => t.ending === "timeout" && t.signals.reasoning !== "none")).toBe(
        true,
      );
    });

    it('a held timeout that times out again on resume is scored (rule 4, detail "timeout")', async () => {
      stubScript([TIMED_OUT]);
      const first = await runMeasurement(options(), deps({ runTrial: timingOut(() => true) }));
      expect(first.status).toBe("stopped");
      timingOut.calls = 0;
      let n = 0;
      stubScript(() => (++n <= 3 ? TIMED_OUT : ANSWER));
      const second = await runMeasurement(
        options({ resume: first.runId }),
        deps({ runTrial: timingOut((k) => k <= 3) }),
      );
      expect(second.status).toBe("complete");
      const trials = readTrials<TrialRecord>(first.runDir as string);
      expect(trials.filter((t) => t.ending === "timeout")).toHaveLength(3);
    });

    it("is held at the run's end, not scored as a FAIL; a timeout the server then answers after is scored", async () => {
      let n = 0;
      stubScript(() => {
        n += 1;
        return n >= 19 ? TIMED_OUT : ANSWER;
      });
      const first = await runMeasurement(options(), deps({ runTrial: timingOut((k) => k >= 19) }));
      expect(first.status).toBe("stopped");
      expect(first.reason).toMatch(/reached its end with 2 trial\(s\) held/);
      expect(readTrials<TrialRecord>(first.runDir as string)).toHaveLength(18);
      expect(readInfra<InfraRecord>(first.runDir as string).map((i) => i.detail)).toEqual([
        "held-silent-error:timeout",
        "held-silent-error:timeout",
      ]);
      fs.rmSync(first.runDir as string, { recursive: true, force: true });

      // One timeout, then the server answers: the streak closes and the timeout is scored.
      timingOut.calls = 0;
      n = 0;
      stubScript(() => {
        n += 1;
        return n === 1 ? TIMED_OUT : ANSWER;
      });
      const second = await runMeasurement(
        options(),
        deps({ runTrial: timingOut((k) => k === 1), now: () => new Date("2026-11-12T12:00:00Z") }),
      );
      expect(second.status).toBe("complete");
      const trials = readTrials<TrialRecord>(second.runDir as string);
      expect(trials).toHaveLength(20);
      expect(trials.filter((t) => t.ending === "timeout")).toHaveLength(1);
    });
  });

  describe("the failing request, not the trial's history, decides silence (round 4, item 1)", () => {
    const TOOL_CALL: ScriptedTurn = {
      toolCalls: [{ id: "call_1", name: "get_outline", args: {} }],
    };
    /** True for a request that follows a tool result: the trial's second request. */
    const afterTool = (body: Record<string, unknown>) =>
      (body.messages as { role?: string }[] | undefined)?.some((m) => m.role === "tool") === true;

    it("a tool call then a 500, trial after trial, is held and stops the run: nothing is scored", async () => {
      stubScript((_i, body) => (afterTool(body) ? { status: 500 } : TOOL_CALL));
      const result = await runMeasurement(options(), deps());
      expect(result.status).toBe("stopped");
      expect(result.reason).toMatch(/Nothing was scored for them/);
      expect(result.scoredThisSession).toBe(0);
      expect(readTrials<TrialRecord>(result.runDir as string)).toEqual([]);
      expect(readInfra<InfraRecord>(result.runDir as string).map((i) => i.detail)).toEqual([
        "held-silent-error:http-500",
        "held-silent-error:http-500",
        "held-silent-error:http-500",
      ]);
    });

    it("a held trial, then tool call then 500, does not close the streak or score what was held", async () => {
      let trial = 0;
      stubScript((_i, body) => {
        if (!afterTool(body)) trial += 1;
        // Trial 1 fails on its first request; the others call a tool first.
        if (trial === 1) return { status: 500 };
        return afterTool(body) ? { status: 500 } : TOOL_CALL;
      });
      const result = await runMeasurement(options(), deps());
      expect(result.status).toBe("stopped");
      expect(result.scoredThisSession).toBe(0);
      expect(readTrials<TrialRecord>(result.runDir as string)).toEqual([]);
      expect(readInfra<InfraRecord>(result.runDir as string)).toHaveLength(3);
    });

    it("isSilentError reads only the failing request", () => {
      const rec = (ending: TrialRecord["ending"]) => ({ ending }) as TrialRecord;
      const fetch = (over: Partial<TapRecord> = {}): TapRecord => ({
        path: "/v1/chat/completions",
        requestBody: null,
        requestChars: 0,
        status: 200,
        thrown: null,
        separateReasoningChars: 0,
        errorFrame: false,
        promptTokens: null,
        readIncomplete: false,
        responseBytes: 0,
        ...over,
      });
      const obs = (turns: TrialObservation["turns"], fetches: TapRecord[]) =>
        ({ turns, fetches }) as unknown as TrialObservation;
      const answered = fetch({ responseBytes: 900 });
      const toolTurn = { turn: 1, text: "Let me look.", hadToolCalls: true };
      // Tool call (with a preamble) then a 500: silent.
      expect(isSilentError(rec("error"), obs([toolTurn], [answered, fetch({ status: 500 })]))).toBe(
        true,
      );
      // The failing request sent bytes, or reasoning, or text: not silent.
      expect(
        isSilentError(rec("timeout"), obs([toolTurn], [answered, fetch({ responseBytes: 12 })])),
      ).toBe(false);
      expect(
        isSilentError(
          rec("timeout"),
          obs([], [fetch({ separateReasoningChars: 40, responseBytes: 0 })]),
        ),
      ).toBe(false);
      expect(
        isSilentError(
          rec("error"),
          obs(
            [toolTurn, { turn: 2, text: "The answer is", hadToolCalls: null }],
            [answered, fetch()],
          ),
        ),
      ).toBe(false);
      // Review round 5, item 4: a trial that ended in an error or a timeout
      // before any chat request was made streamed nothing: silent.
      expect(isSilentError(rec("error"), obs([], []))).toBe(true);
      expect(isSilentError(rec("timeout"), obs([], []))).toBe(true);
      expect(isSilentError(rec("timeout"), obs([toolTurn], []))).toBe(true);
      // Review round 5, item 1: a timeout at the run's own deadline is never
      // silent, with or without a request, with or without bytes.
      const atDeadline = { ending: "timeout", detail: RUN_DEADLINE_DETAIL } as TrialRecord;
      expect(isSilentError(atDeadline, obs([toolTurn], [answered, fetch()]))).toBe(false);
      expect(isSilentError(atDeadline, obs([], []))).toBe(false);
      // Only errors and timeouts can be silent.
      expect(isSilentError(rec("completed"), obs([], [fetch()]))).toBe(false);
      expect(isSilentError(rec("budget"), obs([], [fetch()]))).toBe(false);
    });

    describe("a request cut short by the run deadline (review round 5, item 1)", () => {
      // Only Date is faked, and it moves only when the scripted server moves
      // it: a slow model that takes 150 s for each tool call. Timers are real,
      // so the request the client clamps to the last millisecond really expires.
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });
      const toolMessages = (body: Record<string, unknown>) =>
        ((body.messages as { role?: string }[] | undefined) ?? []).filter((m) => m.role === "tool")
          .length;
      /** Each tool call takes 150 s; the second takes `secondMs`; a third request goes quiet. */
      const slowModel = (secondMs: number) =>
        stubScript((_i, body) => {
          const done = toolMessages(body);
          if (done >= 2) return { hang: [] };
          return {
            ...TOOL_CALL,
            onRequest: () => vi.setSystemTime(Date.now() + (done === 0 ? 150_000 : secondMs)),
          };
        });

      it("ends the same way whether the deadline passes between requests or with 1 ms left", async () => {
        const outcomes: { ending: string; detail: string; scorerPass: boolean }[][] = [];
        // 300 s used: the loop's top-of-turn check ends the run before a third request.
        // 299.999 s used: the third request is clamped to 1 ms, gets nothing, and expires.
        for (const [secondMs, requestsPerTrial] of [
          [150_000, 2],
          [149_999, 3],
        ] as const) {
          const calls = slowModel(secondMs);
          // A run id per run: the two runs share one runs directory.
          const d = deps({ now: () => new Date(`2026-11-12T1${outcomes.length}:00:00Z`) });
          const result = await runMeasurement(options(), d);
          expect(result.status, `second request ${secondMs} ms`).toBe("complete");
          expect(calls).toHaveLength(20 * requestsPerTrial);
          expect(readInfra<InfraRecord>(result.runDir as string)).toEqual([]);
          expect(d.lines.some((l) => /— held$/.test(l))).toBe(false);
          const trials = readTrials<TrialRecord>(result.runDir as string);
          expect(trials).toHaveLength(20);
          outcomes.push(
            trials.map((t) => ({ ending: t.ending, detail: t.detail, scorerPass: t.scorerPass })),
          );
          vi.unstubAllGlobals();
        }
        expect(outcomes[0].every((t) => t.ending === "timeout" && t.detail === RUN_DEADLINE_DETAIL)).toBe(
          true,
        );
        expect(outcomes[1]).toEqual(outcomes[0]);
      }, 60_000);
    });

    describe("a real hang: the server sends headers and then nothing (fake clock)", () => {
      beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      });
      afterEach(() => {
        vi.useRealTimers();
      });
      /** Drive the fake clock until the run settles. */
      async function settle<T>(p: Promise<T>): Promise<T> {
        let done = false;
        void p.finally(() => {
          done = true;
        });
        for (let i = 0; i < 2000 && !done; i++) await vi.advanceTimersByTimeAsync(5_000);
        return p;
      }

      it("a tool call, then a request that hangs until the client's own timeout, is held", async () => {
        stubScript((_i, body) => (afterTool(body) ? { hang: [] } : TOOL_CALL));
        const d = deps();
        const result = await settle(runMeasurement(options(), d));
        expect(result.status).toBe("stopped");
        expect(result.scoredThisSession).toBe(0);
        expect(readTrials<TrialRecord>(result.runDir as string)).toEqual([]);
        // The product's own timeout fired: the loop exited "timeout", not an error.
        expect(readInfra<InfraRecord>(result.runDir as string).map((i) => i.detail)).toEqual([
          "held-silent-error:timeout",
          "held-silent-error:timeout",
          "held-silent-error:timeout",
        ]);
        expect(
          d.lines.some((l) =>
            /TIMEOUT with nothing from the failing request \(timeout\) — held$/.test(l),
          ),
        ).toBe(true);
      });

      it("a failing request that streamed bytes before it hung is the model's: scored, and the streak closes", async () => {
        // The failing request streams a frame with no text, then goes quiet.
        const someBytes = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "" } }] })}\n\n`,
        ];
        let n = 0;
        stubScript((_i, body) => {
          if (!afterTool(body)) n += 1;
          if (n === 1) return afterTool(body) ? { hang: someBytes } : TOOL_CALL;
          return ANSWER;
        });
        const d = deps();
        const result = await settle(runMeasurement(options(), d));
        expect(result.status).toBe("complete");
        const trials = readTrials<TrialRecord>(result.runDir as string);
        expect(trials).toHaveLength(20);
        expect(trials.filter((t) => t.ending === "timeout")).toHaveLength(1);
        // Scored at once, never held (a hold would be scored too, by rule 2).
        expect(d.lines.some((l) => /— held$/.test(l))).toBe(false);
        expect(readInfra<InfraRecord>(result.runDir as string)).toEqual([]);
      });
    });
  });

  it("a hold followed by a plain endpoint error is no longer a hold on the next resume (rule 4 reads the latest record)", async () => {
    stubScript([{ status: 500 }]);
    const first = await runMeasurement(options(), deps());
    expect(first.status).toBe("stopped");
    // Resume: the same three trials now fail as plain endpoint errors.
    stubScript([{ connectionError: "ECONNREFUSED" }]);
    const second = await runMeasurement(options({ resume: first.runId }), deps());
    expect(second.status).toBe("stopped");
    // Resume again: the same 500 as when they were first held. Their latest
    // record is not a hold, so rule 4 does not score them at once: they are
    // held again, and three in a row stop the run.
    let n = 0;
    stubScript(() => (++n <= 3 ? { status: 500 } : ANSWER));
    const d = deps();
    const third = await runMeasurement(options({ resume: first.runId }), d);
    expect(third.status).toBe("stopped");
    expect(d.lines.some((l) => /again, as when it was held/.test(l))).toBe(false);
    expect(readTrials<TrialRecord>(first.runDir as string)).toEqual([]);
  });

  it("holds a streak still open at the run's end, and a resume runs those trials again", async () => {
    let n = 0;
    stubScript(() => {
      n += 1;
      return n >= 19 ? { status: 500 } : ANSWER;
    });
    const first = await runMeasurement(options(), deps());
    expect(first.status).toBe("stopped");
    expect(first.reason).toMatch(/reached its end with 2 trial\(s\) held/);
    const runDir = first.runDir as string;
    expect(readTrials<TrialRecord>(runDir)).toHaveLength(18);
    expect(readInfra<InfraRecord>(runDir).map((i) => i.detail)).toEqual([
      "held-silent-error:http-500",
      "held-silent-error:http-500",
    ]);

    stubScript([ANSWER]);
    const second = await runMeasurement(options({ resume: first.runId }), deps());
    expect(second.status).toBe("complete");
    const trials = readTrials<TrialRecord>(runDir);
    expect(trials).toHaveLength(20);
    expect(trials.filter((t) => t.ending === "error")).toEqual([]);
  });

  it("on a resume, a held trial that errors with a different detail is held again, not scored at once", async () => {
    stubScript([{ status: 500 }]);
    const first = await runMeasurement(options(), deps());
    expect(first.status).toBe("stopped");
    const runDir = first.runDir as string;

    let n = 0;
    stubScript(() => {
      n += 1;
      return n === 1 ? { status: 400 } : ANSWER;
    });
    const d = deps();
    const second = await runMeasurement(options({ resume: first.runId }), d);
    expect(second.status).toBe("complete");
    // Held (a different error from the one it was held for), then scored when
    // the next trial showed the server answering.
    expect(
      d.lines.some((l) =>
        /ERROR with nothing from the failing request \(http-400\) — held$/.test(l),
      ),
    ).toBe(true);
    expect(d.lines.some((l) => /again, as when it was held/.test(l))).toBe(false);
    const trials = readTrials<TrialRecord>(runDir);
    expect(trials).toHaveLength(20);
    expect(trials.filter((t) => t.ending === "error").map((t) => t.detail)).toEqual(["http-400"]);
  });

  it("refuses to start when a gold anchor does not resolve through the product's dispatch", async () => {
    const calls = stubScript([ANSWER]);
    const real = selectScenarios({ tier: "editing", mode: "full" });
    const broken = real.map((s, i) =>
      i === 0 && s.expect.kind === "annotation"
        ? {
            ...s,
            expect: { ...s.expect, target: { quoted_text: "words that are not in the fixture" } },
          }
        : s,
    );
    const preflightCalled = { n: 0 };
    const result = await runMeasurement(
      options({ tier: "editing", mode: "full" }),
      deps({
        scenarios: () => broken,
        preflight: async () => {
          preflightCalled.n += 1;
          return OK_PREFLIGHT;
        },
      }),
    );
    expect(result.status).toBe("refused");
    expect(result.reason).toMatch(/does not validate/);
    expect(result.reason).toContain(real[0].id);
    expect(calls).toHaveLength(0);
    expect(preflightCalled.n).toBe(0);
    expect(fs.readdirSync(runsDir)).toEqual([]);
  });

  it("a half-written last line from a killed process does not swallow the next trial", async () => {
    stubScript([ANSWER]);
    const first = await runMeasurement(options(), deps());
    const runDir = first.runDir as string;
    const file = path.join(runDir, "trials.jsonl");
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    // Keep 5 whole records and half of the sixth, with no newline.
    fs.writeFileSync(file, `${lines.slice(0, 5).join("\n")}\n${lines[5].slice(0, 40)}`, "utf8");
    expect(readTrials<TrialRecord>(runDir)).toHaveLength(5);

    const second = await runMeasurement(options({ resume: first.runId }), deps());
    expect(second.status).toBe("complete");
    expect(second.scoredThisSession).toBe(15);
    const ids = readTrials<TrialRecord>(runDir).map((t) => t.trialId);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("scores a single error between good trials as the model's failure", async () => {
    let n = 0;
    stubScript(() => {
      n += 1;
      return n === 2 ? { status: 500 } : ANSWER;
    });
    const result = await runMeasurement(options(), deps());
    expect(result.status).toBe("complete");
    const trials = readTrials<TrialRecord>(result.runDir as string);
    expect(trials).toHaveLength(20);
    expect(trials.filter((t) => t.ending === "error")).toHaveLength(1);
  });

  it("refuses a resume when what is measured has changed, and when the digest is unknown", async () => {
    stubScript([ANSWER]);
    const first = await runMeasurement(options(), deps());
    const resume = (over: Partial<RunDeps>, opts: Partial<RunOptions> = {}) =>
      runMeasurement(options({ resume: first.runId, ...opts }), deps(over));

    // One at a time: each resume holds the run's lock from before its preflight.
    const changes: [string, () => Promise<{ status: string; reason?: string }>][] = [
      ["fingerprint", () => resume({ fingerprint: async () => "fp-2" })],
      ["commit", () => resume({ commit: () => ({ commit: "b".repeat(40), dirty: false }) })],
      [
        "modelDigest",
        () =>
          resume({
            preflight: async () => ({
              ...OK_PREFLIGHT,
              facts: { ...OK_PREFLIGHT.facts, digest: "sha256:other" },
            }),
          }),
      ],
      [
        "ollamaVersion",
        () =>
          resume({
            preflight: async () => ({
              ...OK_PREFLIGHT,
              facts: { ...OK_PREFLIGHT.facts, ollamaVersion: "9.9.9" },
            }),
          }),
      ],
      ["repeats", () => resume({}, { repeats: 2 })],
      ["mode", () => resume({}, { mode: "full" })],
    ];
    for (const [field, pending] of changes) {
      const r = await pending();
      expect(r.status, field).toBe("refused");
      expect(r.reason, field).toContain(field);
    }
    const unknown = await resume({
      preflight: async () => ({
        ...OK_PREFLIGHT,
        facts: { ...OK_PREFLIGHT.facts, digest: "unknown" },
      }),
    });
    expect(unknown.status).toBe("refused");
    expect(unknown.reason).toMatch(/digest is unknown/);

    // Another machine: the hardware description given on the command line.
    const elsewhere = await resume({}, { hardware: "a desktop with a GPU" });
    expect(elsewhere.status).toBe("refused");
    expect(elsewhere.reason).toMatch(/measured on one machine[\s\S]*hardware \(was "test bench"/);

    // A dirty tree or a later date does not refuse a resume.
    const again = await resume({ commit: () => ({ commit: "a".repeat(40), dirty: true }) });
    expect(again.status).toBe("complete");
    expect(again.scoredThisSession).toBe(0);
  });

  it("a resume of a locked run is refused before its preflight sends anything", async () => {
    stubScript([ANSWER]);
    const first = await runMeasurement(options(), deps());
    const release = acquireLock(existingRunDir(first.runId as string, runsDir));
    try {
      let preflights = 0;
      const r = await runMeasurement(
        options({ resume: first.runId }),
        deps({
          preflight: async () => {
            preflights += 1;
            return OK_PREFLIGHT;
          },
        }),
      );
      expect(r).toMatchObject({ status: "refused" });
      expect(r.reason).toMatch(/locked/);
      expect(preflights).toBe(0);
    } finally {
      release();
    }
  });

  it("a throw after the lock is taken gives the lock back, and a new run leaves nothing", async () => {
    stubScript([ANSWER]);
    const first = await runMeasurement(options(), deps());
    const boom = () => {
      throw new Error("config failed");
    };
    await expect(
      runMeasurement(options({ resume: first.runId }), deps({ config: boom })),
    ).rejects.toThrow("config failed");
    // The resumed run's lock was given back: it can be taken again.
    acquireLock(existingRunDir(first.runId as string, runsDir))();
    const before = fs.readdirSync(runsDir);
    await expect(
      runMeasurement(options({ runId: "fresh-run" }), deps({ config: boom })),
    ).rejects.toThrow("config failed");
    expect(fs.readdirSync(runsDir)).toEqual(before);
  });

  it("refuses to start when the preflight says no, and starts no trial", async () => {
    const calls = stubScript([ANSWER]);
    const result = await runMeasurement(
      options(),
      deps({ preflight: async () => ({ ...OK_PREFLIGHT, ok: false, stop: "no such model" }) }),
    );
    expect(result).toMatchObject({ status: "refused", reason: "no such model" });
    expect(calls).toHaveLength(0);
    expect(fs.readdirSync(runsDir)).toEqual([]);
  });

  it("refuses the extended bank in the chat tier and a screen of the editing tier", async () => {
    stubScript([ANSWER]);
    expect(
      (await runMeasurement(options({ includeExtended: true, mode: "full" }), deps())).status,
    ).toBe("refused");
    expect((await runMeasurement(options({ tier: "editing" }), deps())).status).toBe("refused");
  });
});

describe("the preflight", () => {
  const config = harnessConfig("m:1", "http://127.0.0.1:11434");
  const facts = OK_PREFLIGHT.facts;

  it("stops on a missing model and on an explicit no to tools, before any warm-up", async () => {
    const warmUp = vi.fn(async () => {});
    const missing = await preflight(config, {
      readFacts: async () => ({ ...facts, exists: false }),
      warmUp,
      env: {},
    });
    expect(missing.ok).toBe(false);
    const noTools = await preflight(config, {
      readFacts: async () => ({ ...facts, toolSupport: false }),
      warmUp,
      env: {},
    });
    expect(noTools.ok).toBe(false);
    expect(warmUp).not.toHaveBeenCalled();
  });

  it("continues on unknown tool support and says so; says an unknown digest cannot be resumed", async () => {
    const warmUp = vi.fn(async () => {});
    const r = await preflight(config, {
      readFacts: async () => ({ ...facts, toolSupport: "unknown", digest: "unknown" }),
      readContext: async () => "unknown",
      warmUp,
      env: {},
    });
    expect(r.ok).toBe(true);
    expect(warmUp).toHaveBeenCalledTimes(1);
    expect(r.notes.join("\n")).toMatch(/Tool support: unknown/);
    expect(r.notes.join("\n")).toMatch(/CANNOT BE RESUMED/);
  });

  it("refuses a non-loopback endpoint with the product's own check, and an armed licence gate", async () => {
    const remote = await preflight(harnessConfig("m", "http://example.com:11434"), { env: {} });
    expect(remote.ok).toBe(false);
    expect(remote.stop).toMatch(/NON_LOOPBACK_HOST/);
    const gated = await preflight(config, { env: { TANDEM_LICENSE_GATE: "1" } });
    expect(gated.ok).toBe(false);
  });

  it("the warm-up goes through the shipped client, is streamed, offers no tools, and is not a trial", async () => {
    const calls = stubScript([{ content: ["ready"] }]);
    const r = await preflight(config, {
      readFacts: async () => facts,
      readContext: async () => 8192,
      env: {},
    });
    expect(r.ok).toBe(true);
    expect(r.facts.contextLength).toBe(8192);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe("/v1/chat/completions");
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.tools).toBeUndefined();
    expect(fs.readdirSync(runsDir)).toEqual([]); // nothing recorded
  });
});

describe("a resume on another machine (review M2)", () => {
  it("is refused on a different host or hardware description", () => {
    const session: RunSession = {
      startedAt: "t",
      dirty: false,
      hardware: "laptop",
      contextLength: 4096,
      serverSettings: "unknown",
      toolSupport: "yes",
      host: "h1",
    };
    const stored = { sessions: [session] } as unknown as RunIdentity;
    expect(machineRefusal(stored, { ...session, startedAt: "later", dirty: true })).toBeNull();
    expect(machineRefusal(stored, { ...session, host: "h2" })).toMatch(
      /host \(was "h1", now "h2"\)/,
    );
    expect(machineRefusal(stored, { ...session, hardware: "desktop" })).toMatch(/hardware/);
  });
});

describe("the run's logs", () => {
  it("a torn last line is dropped quietly; a damaged line before it is reported", () => {
    const dir = path.join(runsDir, "logs");
    fs.mkdirSync(dir);
    fs.writeFileSync(trialsPath(dir), '{"trialId":"a#1"}\n{"trialId":"b#1"}\n{"trialId":"c#');
    expect(readTrials<{ trialId: string }>(dir).map((t) => t.trialId)).toEqual(["a#1", "b#1"]);
    expect(damagedLogLines(dir)).toEqual([]);
    // A kill mid-append and a resume that appends after it: the fragment is
    // cut, so the log stays readable (correctness review, High).
    appendTrial(dir, { trialId: "c#1" });
    expect(readTrials<{ trialId: string }>(dir).map((t) => t.trialId)).toEqual([
      "a#1",
      "b#1",
      "c#1",
    ]);
    expect(damagedLogLines(dir)).toEqual([]);
    // A whole record that lost only its newline was counted as recorded: kept.
    fs.appendFileSync(trialsPath(dir), '{"trialId":"d#1"}');
    appendTrial(dir, { trialId: "e#1" });
    expect(readTrials<{ trialId: string }>(dir).map((t) => t.trialId)).toEqual([
      "a#1",
      "b#1",
      "c#1",
      "d#1",
      "e#1",
    ]);
    fs.writeFileSync(trialsPath(dir), '{"trialId":"a#1"}\n{"trialId":"b#\n{"trialId":"c#1"}\n');
    expect(damagedLogLines(dir)).toEqual([
      "trials.jsonl has unreadable line(s) 2 that are not a torn last line",
    ]);
  });
});

describe("the run lock", () => {
  it("lets one process in, and clears a stale lock only on request and only when the holder is gone", () => {
    const dir = path.join(runsDir, "r1");
    fs.mkdirSync(dir);
    const release = acquireLock(dir, { pid: 111, host: "h" });
    expect(() => acquireLock(dir, { pid: 222, host: "h" })).toThrow(/locked by process 111/);
    // Asked to clear, but the holder is alive.
    expect(() =>
      acquireLock(dir, { pid: 222, host: "h", clearStale: true, isRunning: () => true }),
    ).toThrow(/cannot be shown to be stale/);
    // Asked to clear, but the lock is from another computer.
    expect(() =>
      acquireLock(dir, { pid: 222, host: "other", clearStale: true, isRunning: () => false }),
    ).toThrow(/cannot be shown to be stale/);
    // The holder is gone: cleared.
    const second = acquireLock(dir, {
      pid: 222,
      host: "h",
      clearStale: true,
      isRunning: () => false,
    });
    expect(JSON.parse(fs.readFileSync(lockPath(dir), "utf8")).pid).toBe(222);
    release(); // the first holder's release must not remove the second's lock
    expect(fs.existsSync(lockPath(dir))).toBe(true);
    second();
    expect(fs.existsSync(lockPath(dir))).toBe(false);
  });

  it("a clearer that finds the lock has changed hands puts it back and refuses", () => {
    const dir = path.join(runsDir, "r2");
    fs.mkdirSync(dir);
    acquireLock(dir, { pid: 111, host: "h" });
    // Between this clearer reading the stale lock and moving it aside, another
    // process cleared it and took the run.
    let swapped = false;
    const isRunning = () => {
      if (!swapped) {
        swapped = true;
        fs.writeFileSync(
          lockPath(dir),
          `${JSON.stringify({ pid: 333, host: "h", startedAt: "2026-11-12T11:00:00.000Z" })}\n`,
        );
      }
      return false;
    };
    expect(() => acquireLock(dir, { pid: 222, host: "h", clearStale: true, isRunning })).toThrow(
      /lock changed while it was being cleared/,
    );
    expect(JSON.parse(fs.readFileSync(lockPath(dir), "utf8")).pid).toBe(333);
    expect(fs.readdirSync(dir)).toEqual(["lock"]);
  });

  it("the put-back never replaces a lock a third process took meanwhile (review L1)", () => {
    const dir = path.join(runsDir, "r3");
    fs.mkdirSync(dir);
    acquireLock(dir, { pid: 111, host: "h" });
    const lockAt = (pid: number) =>
      `${JSON.stringify({ pid, host: "h", startedAt: `2026-11-12T1${pid % 10}:00:00.000Z` })}\n`;
    let swapped = false;
    const isRunning = () => {
      if (!swapped) {
        swapped = true;
        fs.writeFileSync(lockPath(dir), lockAt(333)); // a second clearer took it
      }
      return false;
    };
    // After this clearer moved the lock aside, a third process takes the run.
    const realRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (typeof file === "string" && file.includes(".stale-") && !fs.existsSync(lockPath(dir))) {
        fs.writeFileSync(lockPath(dir), lockAt(444));
      }
      return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    expect(() => acquireLock(dir, { pid: 222, host: "h", clearStale: true, isRunning })).toThrow(
      /could not be put back because another lock is in its place/,
    );
    vi.restoreAllMocks();
    expect(JSON.parse(fs.readFileSync(lockPath(dir), "utf8")).pid).toBe(444);
    const aside = fs.readdirSync(dir).filter((f) => f.startsWith("lock.stale-"));
    expect(aside).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, aside[0]), "utf8")).pid).toBe(333);
  });

  it("a refusal says how to clear the lock by hand (review L2)", () => {
    const dir = path.join(runsDir, "r4");
    fs.mkdirSync(dir);
    acquireLock(dir, { pid: 111, host: "h" });
    for (const opts of [
      { pid: 222, host: "h" },
      { pid: 222, host: "h", clearStale: true, isRunning: () => true },
    ]) {
      let message = "";
      try {
        acquireLock(dir, opts);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("delete");
      expect(message).toContain(lockPath(dir));
      expect(message).toMatch(/process id can be reused/);
    }
  });

  it("a locked run refuses a second measure process", async () => {
    stubScript([ANSWER]);
    const first = await runMeasurement(options(), deps());
    const release = acquireLock(first.runDir as string, { pid: 999_999, host: "elsewhere" });
    const second = await runMeasurement(options({ resume: first.runId }), deps());
    expect(second.status).toBe("refused");
    expect(second.reason).toMatch(/locked/);
    release();
  });
});
