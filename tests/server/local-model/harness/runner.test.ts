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
  existingRunDir,
  lockPath,
  readInfra,
  readTrials,
} from "../../../../probe/local-model-spike/harness/run-store.js";
import {
  MAX_CONSECUTIVE_INFRASTRUCTURE,
  type RunDeps,
  type RunOptions,
  runMeasurement,
} from "../../../../probe/local-model-spike/harness/runner.js";
import { selectScenarios } from "../../../../probe/local-model-spike/harness/scenarios/index.js";
import type { ScriptedTurn } from "../../../../probe/local-model-spike/harness/scripted-model.js";
import { runTrial } from "../../../../probe/local-model-spike/harness/trial.js";
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
      "identity.json",
      "planned.json",
      "trials.jsonl",
    ]);
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
      "repeated-error:http-500",
      "repeated-error:http-500",
      "repeated-error:http-500",
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

  it("scores a short streak of errors at the very end of the run", async () => {
    let n = 0;
    stubScript(() => {
      n += 1;
      return n >= 19 ? { status: 500 } : ANSWER;
    });
    const result = await runMeasurement(options(), deps());
    expect(result.status).toBe("complete");
    const trials = readTrials<TrialRecord>(result.runDir as string);
    expect(trials).toHaveLength(20);
    expect(trials.slice(-2).map((t) => t.ending)).toEqual(["error", "error"]);
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
