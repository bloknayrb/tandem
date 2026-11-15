/**
 * The measurement harness after #1123 part C (brief R5): what is judged is
 * what the user was shown, the new record fields go on new records only, and
 * a record written by master's code still loads, reports and keeps its hash.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateTrial } from "../../../../probe/local-model-spike/harness/evaluate.js";
import {
  readingOrder,
  renderReadingFile,
} from "../../../../probe/local-model-spike/harness/reading.js";
import {
  recordHash,
  type TrialRecord,
} from "../../../../probe/local-model-spike/harness/record.js";
import { computeReport } from "../../../../probe/local-model-spike/harness/report-core.js";
import { RUBRIC_TEXT, RUBRIC_VERSION } from "../../../../probe/local-model-spike/harness/rubric.js";
import {
  plannedHash,
  type RunIdentity,
} from "../../../../probe/local-model-spike/harness/run-store.js";
import {
  orphanCloseThink,
  stalePreamble,
} from "../../../../probe/local-model-spike/harness/signals.js";
import { checkVerdicts } from "../../../../probe/local-model-spike/harness/verdicts.js";
import { advanceUntil, manualStream, runScripted, scenario } from "./helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const s = () => scenario("ans-ops-review-q3-revenue");

function evaluate(obs: Awaited<ReturnType<typeof runScripted>>["obs"]): TrialRecord {
  const ev = evaluateTrial({
    runId: "run",
    trialId: "t1",
    repeat: 1,
    scenario: s(),
    observation: obs,
    contextLength: "unknown",
  });
  if (!ev.scored) throw new Error("not scored");
  return ev.record;
}

describe("shown text is what is judged (R5.2)", () => {
  it("a last turn whose only text is a <think> block counts as empty: an earlier preamble is flagged", () => {
    expect(
      stalePreamble({
        reply: "Let me check the outline.",
        turns: [
          { turn: 1, text: "Let me check the outline.", hadToolCalls: true },
          { turn: 2, text: "<think>Revenue was $4.82 million.</think>", hadToolCalls: false },
        ],
      }),
    ).toBe(true);
    // <thinking> is shown, so that last turn showed text: not a stale preamble.
    expect(
      stalePreamble({
        reply: "Let me check the outline.",
        turns: [
          { turn: 1, text: "Let me check the outline.", hadToolCalls: true },
          { turn: 2, text: "<thinking>x</thinking>", hadToolCalls: false },
        ],
      }),
    ).toBe(false);
  });

  it("a claim inside <think> is not a claim made to the user; one in <thinking> is", async () => {
    const hidden = await runScripted(s(), [
      {
        content: [
          "<think>I added a comment on the revenue line.</think>",
          "Revenue was $4.82 million.",
        ],
      },
    ]);
    expect(evaluate(hidden.obs).claims.flags).toEqual([]);
    vi.unstubAllGlobals();
    const shown = await runScripted(s(), [
      {
        content: [
          "<thinking>I added a comment on the revenue line.</thinking>",
          "Revenue was $4.82 million.",
        ],
      },
    ]);
    expect(evaluate(shown.obs).claims.flags.length).toBeGreaterThan(0);
  });

  it("the shown time to first text skips a leading <think> block; the raw stamp does not", async () => {
    vi.useFakeTimers();
    const stream = manualStream();
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      stream.push({ content: ["<think>working it out"] });
      setTimeout(() => {
        stream.push({ content: ["</think>Revenue was $4.82 million."] });
        stream.close();
      }, 3000);
      return stream.response(init);
    });
    const { runTrial } = await import("../../../../probe/local-model-spike/harness/trial.js");
    const { trialInput } = await import("./helpers.js");
    const obs = await advanceUntil(runTrial(trialInput(s())), 500);
    expect(obs.timeToFirstTextMs).not.toBeNull();
    expect(obs.timeToFirstShownTextMs).not.toBeNull();
    expect((obs.timeToFirstShownTextMs ?? 0) - (obs.timeToFirstTextMs ?? 0)).toBeGreaterThanOrEqual(
      3000,
    );
    const rec = evaluate(obs);
    expect(rec.timeToFirstShownTextMs).toBe(obs.timeToFirstShownTextMs);
    expect(rec.timeToFirstTextMs).toBe(obs.timeToFirstTextMs);
  });

  it("an error during a <think>-only turn is not 'error after text': the user was shown nothing", async () => {
    const { classifyTrial } = await import(
      "../../../../probe/local-model-spike/harness/classify.js"
    );
    const stream = manualStream();
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      stream.push({ content: ["<think>reasoning that never finishes"] });
      setTimeout(() => stream.fail(new Error("socket hang up")), 0);
      return stream.response(init);
    });
    const { runTrial } = await import("../../../../probe/local-model-spike/harness/trial.js");
    const { trialInput } = await import("./helpers.js");
    const obs = await runTrial(trialInput(s()));
    expect(obs.loop?.metrics.exit).toBe("error");
    expect(classifyTrial(obs).detail).not.toBe("error-after-text");
  });
});

describe("the orphan closing tag (R5.3)", () => {
  it("counts a </think> with no <think> before it in the same turn, any case", () => {
    expect(
      orphanCloseThink([
        { turn: 1, text: "reasoning</think>Answer", hadToolCalls: false },
        { turn: 2, text: "a</THINK>b</think>", hadToolCalls: true },
        { turn: 3, text: "<think>x</think>Answer</think>", hadToolCalls: false },
        { turn: 4, text: "no tags", hadToolCalls: false },
      ]),
    ).toBe(3);
  });

  it("is recorded on a new record, and stays visible in the reply", async () => {
    const { obs } = await runScripted(s(), [
      { content: ["thinking</think>Revenue was $4.82 million."] },
    ]);
    expect(obs.reply).toBe("thinking</think>Revenue was $4.82 million.");
    expect(evaluate(obs).signals.orphanCloseThink).toBe(1);
  });
});

describe("chat notices in the record (R5.4)", () => {
  it("an answer only in a separate reasoning field gets the no-reply notice, recorded and never scored as the reply", async () => {
    const { obs } = await runScripted(s(), [
      { extraFrames: [{ choices: [{ delta: { reasoning: "The answer is $4.82 million." } }] }] },
    ]);
    expect(obs.reply).toBe("");
    expect(obs.replyRows).toBe(0);
    expect(obs.chatNotices).toEqual([
      { kind: "no-reply", text: "Your local model produced no reply." },
    ]);
    const rec = evaluate(obs);
    expect(rec.chatNotices).toEqual(obs.chatNotices);
    expect(rec.reply).toBe("");
    expect(rec.scorerPass).toBe(false);
  });

  it("an answer that is only a <think> block gets the notice too", async () => {
    const { obs } = await runScripted(s(), [
      { content: ["<think>Revenue was $4.82 million.</think>"] },
    ]);
    expect(obs.reply).toBe("");
    expect(obs.chatNotices.map((n) => n.kind)).toEqual(["no-reply"]);
  });

  it("a run that replied carries an empty list", async () => {
    const { obs } = await runScripted(s(), [{ content: ["Revenue was $4.82 million."] }]);
    expect(evaluate(obs).chatNotices).toEqual([]);
  });
});

describe("a record written by master's code (before part C)", () => {
  // Produced by master's own `runTrial` + `evaluateTrial` at b57d850 for the
  // script "<think>The Q2 figure was $4.41 million.</think>" +
  // "Revenue was $4.82 million.", and committed verbatim.
  const FIXTURE = join(
    process.cwd(),
    "tests/server/local-model/__fixtures__/part-c-master-record.json",
  );
  const pristine = () => JSON.parse(readFileSync(FIXTURE, "utf8")) as TrialRecord;

  it("has none of the new fields, and its hash is its own", () => {
    const rec = pristine();
    expect("chatNotices" in rec).toBe(false);
    expect("timeToFirstShownTextMs" in rec).toBe(false);
    expect("orphanCloseThink" in rec.signals).toBe(false);
    expect(recordHash(rec)).toBe(rec.hash);
  });

  it("loads, reports and renders with nothing defaulted into it", () => {
    const rec = pristine();
    const trials = [rec];
    const planned = [
      { trialId: rec.trialId, scenarioId: rec.scenarioId, group: rec.group, repeat: 1 },
    ];
    const identity: RunIdentity = {
      runId: rec.runId,
      modelTag: "m:1b",
      endpoint: "http://127.0.0.1:11434",
      commit: "c".repeat(40),
      modelDigest: "sha256:d",
      ollamaVersion: "1",
      fingerprint: "fp",
      tier: "chat",
      mode: "full",
      repeats: 1,
      scenarioSetHash: "h",
      includeExtended: false,
      plannedHash: plannedHash(planned),
      sessions: [
        {
          startedAt: "2026-11-12T10:00:00.000Z",
          dirty: false,
          hardware: "h",
          contextLength: 4096,
          serverSettings: "unknown",
          toolSupport: "yes",
          host: "h",
        },
      ],
    } as RunIdentity;
    const report = computeReport({
      identity,
      planned,
      trials,
      infra: [],
      verdicts: null,
      rubricVersion: RUBRIC_VERSION,
      fingerprint: { current: "fp", published: null, statement: "None published." },
    });
    expect(report.text).toContain(
      "median time to first text (raw stream: recorded before shown text was measured)",
    );
    expect(report.columns["no-reply notice posted"]).toBe(0);
    const reading = renderReadingFile({
      identity,
      trials: readingOrder(trials),
      fixtureTexts: new Map(),
    });
    expect(reading).not.toContain("chat notices the product posted");
    const checked = checkVerdicts(null, rec.runId, trials, RUBRIC_VERSION);
    expect(checked.problems).toEqual(["no verdict file"]);
    // Nothing was written back into the record by any of the three.
    expect(rec).toEqual(pristine());
    expect(recordHash(rec)).toBe(rec.hash);
  });
});

describe("the rubric (R5.2)", () => {
  it("says hidden <think> text does not count and <thinking>/<reasoning> still do, at a new version", () => {
    expect(RUBRIC_VERSION).toBe("2026-11-15.1");
    expect(RUBRIC_TEXT).toContain("The product hides text inside\n<think>…</think>");
    expect(RUBRIC_TEXT).toContain(
      "<thinking>…</thinking> or <reasoning>…</reasoning> is NOT hidden",
    );
  });
});
