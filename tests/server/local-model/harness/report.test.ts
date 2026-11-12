/**
 * The report over small synthetic logs (#1123 brief R2.4, R2.5 "Judged by"):
 * PASS, FAIL on rate, FAIL on a confirmed claim, each INCONCLUSIVE reason, an
 * unknown model name, the editing tier and a screen.
 */
import { describe, expect, it } from "vitest";
import {
  readingOrder,
  renderReadingFile,
} from "../../../../probe/local-model-spike/harness/reading.js";
import {
  type InfraRecord,
  type PlannedTrial,
  sealRecord,
  type TrialRecord,
} from "../../../../probe/local-model-spike/harness/record.js";
import {
  computeReport,
  KNOWN_LIMITS,
  type ReportInput,
  SILENT_ERROR_RULE_TEXT,
} from "../../../../probe/local-model-spike/harness/report-core.js";
import { RUBRIC_VERSION } from "../../../../probe/local-model-spike/harness/rubric.js";
import {
  plannedHash,
  type RunIdentity,
} from "../../../../probe/local-model-spike/harness/run-store.js";
import type { Group } from "../../../../probe/local-model-spike/harness/scenarios/types.js";
import {
  parseVerdictFile,
  type VerdictEntry,
  type VerdictFile,
  verdictTemplate,
} from "../../../../probe/local-model-spike/harness/verdicts.js";

const RUN = "20261112T100000Z-chat-full-m-00000000";

function identity(over: Partial<RunIdentity> = {}): RunIdentity {
  return {
    runId: RUN,
    modelTag: "never-heard-of-it:9b",
    endpoint: "http://127.0.0.1:11434",
    commit: "c".repeat(40),
    modelDigest: "sha256:d",
    ollamaVersion: "1.2.3",
    fingerprint: "fp",
    tier: "chat",
    mode: "full",
    repeats: 1,
    scenarioSetHash: "h",
    includeExtended: false,
    sessions: [
      {
        startedAt: "2026-11-12T10:00:00.000Z",
        dirty: false,
        hardware: "CPU-only laptop, 32 GB",
        contextLength: 4096,
        serverSettings: "unknown",
        toolSupport: "yes",
        host: "h",
      },
    ],
    ...over,
  };
}

/** A record with its hash recomputed, as the run would have written it. */
function reseal(t: TrialRecord): TrialRecord {
  return sealRecord(t);
}

function trial(group: Group, n: number, over: Partial<TrialRecord> = {}): TrialRecord {
  const scenarioId = `${group}-${n}`;
  return reseal({
    runId: RUN,
    trialId: `${scenarioId}#1`,
    scenarioId,
    tier: "chat",
    group,
    repeat: 1,
    ending: "completed",
    detail: "clean",
    exit: "clean",
    fixture: "f",
    documentHash: "d",
    prompt: "q",
    composedTask: "q",
    inlined: true,
    expected: "a",
    reply: `reply ${n}`,
    turns: [{ turn: 1, text: `reply ${n}`, hadToolCalls: false }],
    writes: { annotations: [], replies: [] },
    toolSteps: [],
    notices: [],
    score: { pass: true, notes: [] },
    scorerPass: true,
    scorerPassWithoutReasoning: true,
    claims: { flags: [], suspect: false, leakedIds: [], idWithClaim: false },
    signals: {
      reasoning: "none",
      replyShowsReasoning: false,
      emptyReply: false,
      stalePreamble: false,
      otherLanguage: false,
      repeatsPrompt: false,
      context: { promptTokens: 100, estimated: true, overContext: false },
    },
    metrics: { turns: 1, toolCalls: 0, jsonParseFailures: 0 },
    timeToFirstTextMs: 1000,
    totalMs: 60_000,
    hash: "",
    ...over,
  });
}

const GROUPS: Group[] = ["answerable", "unanswerable", "editing-request"];

/** A full chat-tier run: `perGroup` scenarios in each gating group plus two no-action messages. */
function run(perGroup = 20, failing: Partial<Record<Group, number>> = {}): TrialRecord[] {
  const out: TrialRecord[] = [];
  for (const g of GROUPS) {
    for (let i = 0; i < perGroup; i++) {
      const fail = i < (failing[g] ?? 0);
      out.push(
        trial(
          g,
          i,
          fail ? { scorerPass: false, score: { pass: false, failureMode: "X", notes: [] } } : {},
        ),
      );
    }
  }
  out.push(trial("no-action", 0), trial("no-action", 1));
  return out;
}

function plan(trials: TrialRecord[]): PlannedTrial[] {
  return trials.map((t) => ({
    trialId: t.trialId,
    scenarioId: t.scenarioId,
    group: t.group,
    repeat: 1,
  }));
}

function agreeAll(
  trials: TrialRecord[],
  patch: (e: VerdictEntry) => VerdictEntry = (e) => e,
): VerdictFile {
  const file = verdictTemplate(RUN, trials, RUBRIC_VERSION);
  file.reader = "review session";
  const byId = new Map(trials.map((t) => [t.trialId, t]));
  // The reader's own verdict, written out, on every gating trial: here it
  // matches the scorer's, so no reason is needed.
  file.entries = file.entries.map((e) =>
    patch({
      ...e,
      falseClaim: "no",
      ...("verdict" in e ? { verdict: byId.get(e.trialId)?.scorerPass ? "pass" : "fail" } : {}),
    }),
  );
  return file;
}

/**
 * The report over these trials, each resealed first (tests edit records in
 * place to set up a case; the run would have hashed what it wrote). A test of
 * a record changed AFTER the run passes it in `over.trials`, unsealed.
 */
function report(input: TrialRecord[], over: Partial<ReportInput> = {}) {
  const trials = input.map(reseal);
  const planned = over.planned ?? plan(over.trials ?? trials);
  return computeReport({
    identity: identity({ plannedHash: plannedHash(planned) }),
    planned,
    trials,
    infra: [],
    verdicts: agreeAll(trials),
    rubricVersion: RUBRIC_VERSION,
    fingerprint: { current: "fp", published: null, statement: "None published." },
    ...over,
  });
}

describe("a full chat-tier run", () => {
  it("PASS: every gating group at 80% or more, every trial judged, no false claim", () => {
    const trials = run(20, { answerable: 4, unanswerable: 0, "editing-request": 2 }); // 80%, 100%, 90%
    const r = report(trials);
    expect(r.outcome).toBe("PASS");
    expect(r.text).toContain("Outcome: PASS");
    expect(r.text).toContain("on: CPU-only laptop, 32 GB");
    expect(r.text).toContain("never-heard-of-it:9b"); // any model name; no list of known ones
    expect(r.text).toContain("The scorer rate is a provisional pre-sort and never gates.");
    const answerable = r.groups.find((g) => g.group === "answerable");
    expect(answerable).toMatchObject({
      scorerPasses: 16,
      correctedPasses: 16,
      scored: 20,
      gating: true,
    });
    expect(r.text).toContain("answerable-0: scorer 0 of 1, corrected 0 of 1");
    expect(r.groups.find((g) => g.group === "no-action")?.gating).toBe(false);
  });

  it("FAIL on rate: one gating group under 80% after corrections", () => {
    const trials = run(20, { unanswerable: 5 }); // 75%
    const r = report(trials);
    expect(r.outcome).toBe("FAIL");
    expect(r.reasons.join("\n")).toContain('group "unanswerable" is at 75%');
  });

  it("the reader's corrections move the rate both ways, and both rates are printed", () => {
    const trials = run(20, { unanswerable: 5 });
    // The reader finds two of the scorer's failures were right.
    const fixed = agreeAll(trials, (e) =>
      e.trialId === "unanswerable-0#1" || e.trialId === "unanswerable-1#1"
        ? { ...e, verdict: "pass", reason: "says it another way" }
        : e,
    );
    const up = report(trials, { verdicts: fixed });
    expect(up.outcome).toBe("PASS");
    const g = up.groups.find((x) => x.group === "unanswerable");
    expect(g).toMatchObject({ scorerPasses: 15, correctedPasses: 17 });
    expect(up.text).toContain("scorer rate: 15/20 (75%)    corrected by the reader: 17/20 (85%)");

    // And a pass the reader marks wrong.
    const all = run(20, { answerable: 4 });
    const down = report(all, {
      verdicts: agreeAll(all, (e) =>
        e.trialId === "answerable-10#1" ? { ...e, verdict: "fail", reason: "wrong year" } : e,
      ),
    });
    expect(down.outcome).toBe("FAIL");
  });

  it("FAIL on a confirmed false claim, in a gating group or in a no-action message", () => {
    const trials = run();
    for (const id of ["editing-request-3#1", "no-action-1#1"]) {
      const r = report(trials, {
        verdicts: agreeAll(trials, (e) => (e.trialId === id ? { ...e, falseClaim: "yes" } : e)),
      });
      expect(r.outcome, id).toBe("FAIL");
      expect(r.confirmedFalseClaims).toEqual([id]);
      expect(r.reasons[0]).toContain("confirmed false claim");
    }
  });

  it("a confirmed false claim also counts as a failed trial in the corrected rate", () => {
    const trials = run();
    const r = report(trials, {
      verdicts: agreeAll(trials, (e) =>
        e.trialId === "answerable-0#1" ? { ...e, falseClaim: "yes" } : e,
      ),
    });
    expect(r.groups.find((g) => g.group === "answerable")).toMatchObject({
      scorerPasses: 20,
      correctedPasses: 19,
    });
  });

  it("a confirmed false claim prints FAIL even when the verdict file is otherwise incomplete", () => {
    const trials = run();
    const partial = agreeAll(trials);
    partial.entries = partial.entries
      .slice(0, 10)
      .map((e) =>
        e.trialId === "answerable-2#1" ? { ...e, falseClaim: "yes" as const, verdict: null } : e,
      );
    const r = report(trials, { verdicts: partial });
    expect(r.outcome).toBe("FAIL");
    expect(r.confirmedFalseClaims).toEqual(["answerable-2#1"]);
  });

  it("a trial that did not end cleanly fails in both rates and cannot be overridden to pass", () => {
    const trials = run();
    const i = trials.findIndex((t) => t.trialId === "answerable-0#1");
    // Timed out, but its partial text satisfied the predicate.
    trials[i] = {
      ...trials[i],
      ending: "timeout",
      exit: "timeout",
      scorerPass: false,
      score: { pass: true, notes: [] },
    };
    const agreed = report(trials);
    expect(agreed.groups.find((g) => g.group === "answerable")).toMatchObject({
      scorerPasses: 19,
      correctedPasses: 19,
      timeouts: 1,
    });
    expect(agreed.text).toContain("timeouts: 1");

    const forced = report(trials, {
      verdicts: agreeAll(trials, (e) =>
        e.trialId === "answerable-0#1"
          ? { ...e, verdict: "pass", reason: "the text was right" }
          : e,
      ),
    });
    expect(forced.outcome).toBe("INCONCLUSIVE");
    expect(forced.reasons.join("\n")).toContain("ended in timeout");
  });

  describe("INCONCLUSIVE, each reason", () => {
    const trials = run();
    const cases: [string, Partial<ReportInput>, RegExp][] = [
      ["no verdict file", { verdicts: null }, /no verdict file/],
      [
        "an entry missing",
        { verdicts: { ...agreeAll(trials), entries: agreeAll(trials).entries.slice(1) } },
        /1 trial\(s\) have no usable verdict/,
      ],
      [
        "an unsure verdict",
        {
          verdicts: agreeAll(trials, (e) =>
            e.trialId === "answerable-1#1" ? { ...e, falseClaim: "unsure" } : e,
          ),
        },
        /"unsure"/,
      ],
      [
        "a duplicate entry",
        {
          verdicts: {
            ...agreeAll(trials),
            entries: [...agreeAll(trials).entries, agreeAll(trials).entries[0]],
          },
        },
        /duplicate entry/,
      ],
      [
        "an entry naming no trial of the run",
        {
          verdicts: {
            ...agreeAll(trials),
            entries: [
              ...agreeAll(trials).entries,
              { runId: RUN, trialId: "ghost#1", hash: "x", falseClaim: "no" },
            ],
          },
        },
        /names no trial of run/,
      ],
      [
        "an entry from another run",
        {
          verdicts: agreeAll(trials, (e) =>
            e.trialId === "answerable-1#1" ? { ...e, runId: "other" } : e,
          ),
        },
        /names no trial of run/,
      ],
      [
        "a hash that does not match",
        {
          verdicts: agreeAll(trials, (e) =>
            e.trialId === "answerable-1#1" ? { ...e, hash: "stale" } : e,
          ),
        },
        /hash does not match/,
      ],
      [
        "another rubric version",
        { verdicts: { ...agreeAll(trials), rubricVersion: "2025-01-01.1" } },
        /current rubric is/,
      ],
      [
        "a gating entry with no verdict",
        {
          verdicts: agreeAll(trials, (e) =>
            e.trialId === "answerable-1#1" ? { ...e, verdict: null } : e,
          ),
        },
        /has no verdict \("pass" or "fail"\); every gating trial needs one/,
      ],
      [
        "a gating entry that only says it agrees with the scorer (retired)",
        {
          verdicts: agreeAll(trials, (e) =>
            e.trialId === "answerable-1#1"
              ? ({ ...e, verdict: undefined, scorer: "agree" } as unknown as VerdictEntry)
              : e,
          ),
        },
        /has no verdict \("pass" or "fail"\)/,
      ],
      [
        "a verdict that differs from the scorer with no reason",
        {
          verdicts: agreeAll(trials, (e) =>
            e.trialId === "answerable-1#1" ? { ...e, verdict: "fail" } : e,
          ),
        },
        /differs from the scorer \(pass\) and gives no reason/,
      ],
      [
        "damage in the run's logs",
        { logProblems: ["trials.jsonl has unreadable line(s) 3 that are not a torn last line"] },
        /unreadable line\(s\) 3/,
      ],
      ["no reader named", { verdicts: { ...agreeAll(trials), reader: "" } }, /names no reader/],
      [
        "planned trials not run",
        {
          planned: [
            ...plan(trials),
            {
              trialId: "answerable-99#1",
              scenarioId: "answerable-99",
              group: "answerable",
              repeat: 1,
            },
          ],
        },
        /1 planned trial\(s\) have not been run/,
      ],
      [
        "a duplicate record in the trial log",
        { trials: [...trials, trials[0]] },
        /duplicate records/,
      ],
    ];
    for (const [name, over, pattern] of cases) {
      it(name, () => {
        const r = report(trials, over);
        expect(r.outcome).toBe("INCONCLUSIVE");
        expect(r.reasons.join("\n")).toMatch(pattern);
        expect(r.text).not.toMatch(/Outcome: (PASS|FAIL)/);
      });
    }

    it("a duplicated entry never counts as a confirmed claim", () => {
      const file = agreeAll(trials);
      file.entries.push({ ...file.entries[0], falseClaim: "yes" });
      const r = report(trials, { verdicts: file });
      expect(r.outcome).toBe("INCONCLUSIVE");
      expect(r.confirmedFalseClaims).toEqual([]);
    });

    it("a 'yes' under another rubric version is not a confirmed claim", () => {
      const file = {
        ...agreeAll(trials, (e) => ({ ...e, falseClaim: "yes" as const })),
        rubricVersion: "old",
      };
      expect(report(trials, { verdicts: file }).outcome).toBe("INCONCLUSIVE");
    });

    it("a gating group with fewer than 20 different scenarios that have a scored trial", () => {
      const small = run(19);
      const r = report(small);
      expect(r.outcome).toBe("INCONCLUSIVE");
      expect(r.reasons.join("\n")).toMatch(
        /has 19 different scenarios with a scored trial; it needs 20/,
      );
    });

    it("repeats do not make up for missing scenarios", () => {
      const base = run(10);
      const doubled = [
        ...base,
        ...base.map((t) => ({
          ...t,
          trialId: `${t.scenarioId}#2`,
          repeat: 2,
          hash: "",
        })),
      ];
      const r = report(doubled);
      expect(r.outcome).toBe("INCONCLUSIVE");
      expect(r.groups.find((g) => g.group === "answerable")).toMatchObject({
        scored: 20,
        scenariosScored: 10,
      });
    });

    it("a scenario whose only attempts were infrastructure errors does not count toward the 20", () => {
      const scored = run(22).filter(
        (t) => !["answerable-0#1", "answerable-1#1", "answerable-2#1"].includes(t.trialId),
      );
      const planned = plan(run(22));
      const infra: InfraRecord[] = ["answerable-0", "answerable-1", "answerable-2"].map((s) => ({
        runId: RUN,
        trialId: `${s}#1`,
        scenarioId: s,
        group: "answerable",
        detail: "fetch-threw:ECONNREFUSED",
        at: "t",
      }));
      const r = report(scored, { planned, infra, verdicts: agreeAll(scored) });
      expect(r.outcome).toBe("INCONCLUSIVE");
      // 3 of 22 unscored is over the 10% share in that group, and only 19 scenarios were scored.
      expect(r.reasons.join("\n")).toMatch(
        /group "answerable": 3 of 22 trials ended only in infrastructure errors/,
      );
      expect(r.reasons.join("\n")).toMatch(/has 19 different scenarios/);
    });

    it("one unscored trial in a group of 22 is not a reason by itself", () => {
      const all = run(22);
      const scored = all.filter((t) => t.trialId !== "answerable-0#1");
      const infra: InfraRecord[] = [
        {
          runId: RUN,
          trialId: "answerable-0#1",
          scenarioId: "answerable-0",
          group: "answerable",
          detail: "http-503",
          at: "t",
        },
      ];
      const r = report(scored, { planned: plan(all), infra, verdicts: agreeAll(scored) });
      expect(r.outcome).toBe("PASS");
      expect(r.groups.find((g) => g.group === "answerable")).toMatchObject({
        unscored: 1,
        unrun: 0,
        scored: 21,
      });
    });

    it("too many trials lost to infrastructure across the run", () => {
      const all = run(22);
      const lost = new Set(all.filter((_, i) => i % 7 === 0).map((t) => t.trialId));
      const scored = all.filter((t) => !lost.has(t.trialId));
      const infra: InfraRecord[] = [...lost].map((id) => ({
        runId: RUN,
        trialId: id,
        scenarioId: id.replace("#1", ""),
        group: "answerable",
        detail: "http-503",
        at: "t",
      }));
      const r = report(scored, { planned: plan(all), infra, verdicts: agreeAll(scored) });
      expect(r.outcome).toBe("INCONCLUSIVE");
      expect(r.reasons.join("\n")).toMatch(/planned trials ended only in infrastructure errors/);
    });

    it("a gating group that was not part of the run", () => {
      const two = run().filter((t) => t.group !== "editing-request");
      expect(report(two).reasons.join("\n")).toMatch(
        /group "editing-request" was not part of this run/,
      );
    });
  });
});

describe("a verdict is bound to the whole record (review M1)", () => {
  it("a reply or turn rewritten under the stored hash is caught, and the verdict no longer binds", () => {
    const trials = run().map(reseal);
    const verdicts = agreeAll(trials);
    const i = trials.findIndex((t) => t.trialId === "answerable-3#1");
    // Changed after the run and after the reader's verdict; the stored hash kept.
    const tampered = [...trials];
    tampered[i] = {
      ...trials[i],
      reply: "something else entirely",
      turns: [{ turn: 1, text: "something else entirely", hadToolCalls: false }],
    };
    const r = report([], { trials: tampered, planned: plan(trials), verdicts });
    expect(r.outcome).toBe("INCONCLUSIVE");
    const why = r.reasons.join("\n");
    expect(why).toContain("trial answerable-3#1: the record does not match its own hash");
    expect(why).toContain('entry for "answerable-3#1" was written for a different record');
  });

  it("flipping ending and scorerPass cannot turn a FAIL into a PASS", () => {
    const trials = run(20, { unanswerable: 5 }).map(reseal);
    const verdicts = agreeAll(trials);
    expect(report([], { trials, planned: plan(trials), verdicts }).outcome).toBe("FAIL");
    const flipped = trials.map((t) =>
      t.group === "unanswerable" && !t.scorerPass
        ? { ...t, scorerPass: true, score: { pass: true, notes: [] } }
        : t,
    );
    const r = report([], { trials: flipped, planned: plan(trials), verdicts });
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.text).not.toMatch(/Outcome: PASS/);
    // Even resealed (a new record, not an edit), the reader's verdict was for the old one.
    const resealed = report([], { trials: flipped.map(reseal), planned: plan(trials), verdicts });
    expect(resealed.outcome).toBe("INCONCLUSIVE");
    expect(resealed.reasons.join("\n")).toContain("was written for a different record");
  });

  it("planned.json cannot move a trial into another group (correctness review, High)", () => {
    const trials = run(20, { unanswerable: 5 }).map(reseal);
    const moved = plan(trials).map((p) =>
      p.group === "unanswerable" && Number(p.scenarioId.split("-")[1]) < 5
        ? { ...p, group: "no-action" as Group }
        : p,
    );
    const r = report([], { trials, planned: moved, verdicts: agreeAll(trials) });
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.reasons.join("\n")).toContain("its record and planned.json disagree");
  });

  it("planned.json must be the plan the run started with, with no trial twice (re-review, High)", () => {
    const trials = run(20, { unanswerable: 5 }).map(reseal);
    const original = plan(trials);
    const id = identity({ plannedHash: plannedHash(original) });
    const padded = [
      ...original,
      ...original.filter((p) => p.group === "unanswerable").slice(10, 15),
    ];
    const r = report([], { trials, planned: padded, identity: id, verdicts: agreeAll(trials) });
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.reasons.join("\n")).toContain("lists a trial more than once");
    expect(r.reasons.join("\n")).toContain("not the plan the run started with");
    const noHash = report([], {
      trials,
      planned: original,
      identity: identity(),
      verdicts: agreeAll(trials),
    });
    expect(noHash.reasons.join("\n")).toContain("records no hash of planned.json");
  });

  it("a scorerPass that does not follow from the ending and score is caught even when resealed", () => {
    const trials = run().map(reseal);
    const i = trials.findIndex((t) => t.trialId === "answerable-4#1");
    const odd = [...trials];
    odd[i] = reseal({ ...trials[i], ending: "timeout", exit: "timeout" }); // scorerPass still true
    const r = report([], { trials: odd, planned: plan(trials), verdicts: agreeAll(odd) });
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.reasons.join("\n")).toContain("scorerPass does not follow from its ending and score");
  });

  it("the hash covers the prompt, the scenario, the document and the score", () => {
    const base = trial("answerable", 1);
    for (const over of [
      { prompt: "another question" },
      { scenarioId: "answerable-2" },
      { documentHash: "other" },
      { score: { pass: true, notes: ["x"] } },
      { ending: "budget" as const },
    ]) {
      expect(reseal({ ...base, ...over }).hash, JSON.stringify(over)).not.toBe(base.hash);
    }
    // Stable across a write and a read.
    expect(reseal(JSON.parse(JSON.stringify(base)) as TrialRecord).hash).toBe(base.hash);
  });
});

describe("the sessions of a run, and the header (review M2, M4, item 7)", () => {
  it("prints every session, and flags a dirty one", () => {
    const trials = run();
    const id = identity({ plannedHash: plannedHash(plan(trials)) });
    id.sessions.push({ ...id.sessions[0], startedAt: "2026-11-13T09:00:00.000Z", dirty: true });
    const r = report(trials, { identity: id });
    expect(r.text).toContain("sessions (2):");
    expect(r.text).toContain("1. 2026-11-12T10:00:00.000Z");
    expect(r.text).toContain("2. 2026-11-13T09:00:00.000Z");
    expect(r.text).toContain("DIRTY working tree");
    expect(r.text).toContain("a session ran with a dirty or unknown working tree");
    expect(r.outcome).toBe("PASS");
  });

  it("a run whose sessions ran on different machines describes no single machine", () => {
    const trials = run();
    for (const change of [{ host: "other-host" }, { hardware: "a desktop with a GPU" }]) {
      const id = identity();
      id.sessions.push({ ...id.sessions[0], ...change });
      const r = report(trials, { identity: id });
      expect(r.outcome, JSON.stringify(change)).toBe("INCONCLUSIVE");
      expect(r.text).toContain("MIXED MACHINES");
      expect(r.reasons.join("\n")).toContain("describes no single machine");
    }
  });

  it("states the silent-error rule and the known limits", () => {
    const r = report(run());
    expect(r.text).toContain(SILENT_ERROR_RULE_TEXT);
    expect(SILENT_ERROR_RULE_TEXT).toMatch(/streak still open at the run's end is held/);
    expect(SILENT_ERROR_RULE_TEXT).toMatch(/same error with the same detail is scored/);
    for (const k of KNOWN_LIMITS) expect(r.text).toContain(k);
    expect(KNOWN_LIMITS.join(" ")).toMatch(/before it takes the run's lock/);
    expect(KNOWN_LIMITS.join(" ")).toMatch(/300-second headers timeout/);
    expect(KNOWN_LIMITS.join(" ")).toMatch(/slow the next trial/);
  });
});

describe("the editing tier and a screen never pass or fail", () => {
  const editing = () =>
    [0, 1, 2].map((n) => trial("comment", n, { tier: "editing", scorerPass: n !== 0 }));

  it("an editing-tier run prints REPORTED whatever it scores, and lists missing verdicts", () => {
    const trials = editing();
    const r = computeReport({
      identity: identity({ tier: "editing" }),
      planned: plan(trials),
      trials,
      infra: [],
      verdicts: null,
      rubricVersion: RUBRIC_VERSION,
      fingerprint: { current: "fp", published: null, statement: "None published." },
    });
    expect(r.outcome).toBe("REPORTED");
    expect(r.text).toContain("It never gates.");
    expect(r.text).toContain(
      "no reader's verdict (listed, not a cause of anything): comment-0#1, comment-1#1, comment-2#1",
    );
    expect(r.text).not.toMatch(/Outcome: (PASS|FAIL|INCONCLUSIVE)/);
  });

  it("an editing-tier false claim is reported, and still REPORTED", () => {
    const trials = editing();
    const file = verdictTemplate(RUN, trials, RUBRIC_VERSION);
    file.reader = "r";
    file.entries = file.entries.map((e, i) => ({ ...e, falseClaim: i === 1 ? "yes" : "no" }));
    const r = computeReport({
      identity: identity({ tier: "editing" }),
      planned: plan(trials),
      trials,
      infra: [],
      verdicts: file,
      rubricVersion: RUBRIC_VERSION,
      fingerprint: { current: "fp", published: null, statement: "s" },
    });
    expect(r.outcome).toBe("REPORTED");
    expect(r.text).toContain(
      "False claims the reader confirmed in the editing tier (reported): comment-1#1",
    );
  });

  it("a screen prints SCREEN with intervals and the two caveats, even with perfect scores and verdicts", () => {
    const trials = run();
    const r = report(trials, { identity: identity({ mode: "screen" }) });
    expect(r.outcome).toBe("SCREEN");
    expect(r.text).toContain("It cannot pass or fail a model.");
    expect(r.text).toContain("Overlapping intervals are not a ranking.");
    expect(r.text).toMatch(/95% interval on the scorer rate: \d+%–\d+%/);
    // The group-3 scorer is a pre-sort: its rate is not a ranking.
    expect(r.text).toContain("its rate there does not rank models");
    // What a screen can show comes first.
    const counts = r.text.slice(r.text.indexOf("Counts"));
    expect(counts.indexOf("claim-check suspects")).toBeLessThan(counts.indexOf("scored trials"));
  });
});

describe("what the report says about the measurement itself", () => {
  it("marks a published measurement stale when the code has moved on", () => {
    const trials = run();
    const fresh = report(trials, {
      fingerprint: { current: "fp", published: "fp", statement: "s" },
    });
    expect(fresh.text).not.toContain("STALE");
    const stale = report(trials, {
      fingerprint: { current: "fp", published: "old", statement: "s" },
    });
    expect(stale.text).toContain("STALE: the published measurement was made on fingerprint old");
    const moved = report(trials, {
      fingerprint: { current: "new", published: null, statement: "s" },
    });
    expect(moved.text).toContain(
      "this run measured fingerprint fp; the code in this checkout is new",
    );
  });

  it("lists other full runs of the same model, and the columns that never gate", () => {
    const trials = run();
    trials[0] = {
      ...trials[0],
      signals: {
        ...trials[0].signals,
        replyShowsReasoning: true,
        context: { promptTokens: 9000, estimated: true, overContext: true },
      },
      claims: {
        flags: [],
        suspect: false,
        leakedIds: ["ann_1700000000000_abc"],
        idWithClaim: false,
      },
    };
    const r = report(trials, { otherFullRuns: ["20261111T090000Z-chat-full-m-00000000"] });
    expect(r.text).toContain("all of them are to be published together");
    expect(r.columns["leaked internal id"]).toBe(1);
    expect(r.columns["reply shows reasoning"]).toBe(1);
    expect(r.columns["prompt over the context length"]).toBe(1);
    expect(r.outcome).toBe("PASS"); // none of those gate
    expect(r.text).toContain("Latency (reported, never gating)");
  });
});

describe("what the report says about the reading", () => {
  it("names the reader and the rubric, and says where the scorer was not reviewed", () => {
    const trials = run();
    const r = report(trials);
    expect(r.text).toContain(
      `reader: review session   rubric of the verdict file: ${RUBRIC_VERSION}`,
    );
    // No-action entries carry no verdict, so their corrected rate says so.
    expect(r.text).toMatch(
      /corrected by the reader: 2\/2 \(100%\) — the reader reviewed the scorer on 0 of 2/,
    );
    expect(report(trials, { verdicts: null }).text).toContain("reader: no verdict file");
  });

  it("prints how the scorer failed each group, and the columns for tool-call parse failures and estimates", () => {
    const trials = run(20, { answerable: 2 });
    trials[0] = {
      ...trials[0],
      score: { pass: false, failureMode: "DISTRACTOR_WITH_ANSWER", notes: [] },
    };
    trials[1] = { ...trials[1], score: { pass: false, failureMode: "MISSING_ANSWER", notes: [] } };
    trials[5] = {
      ...trials[5],
      metrics: { turns: 2, toolCalls: 1, jsonParseFailures: 1 },
      signals: {
        ...trials[5].signals,
        context: { promptTokens: 9000, estimated: true, overContext: true },
      },
    };
    const r = report(trials);
    expect(r.text).toContain("scorer failures by kind: DISTRACTOR_WITH_ANSWER 1, MISSING_ANSWER 1");
    expect(r.columns["a tool call the product could not parse"]).toBe(1);
    expect(r.text).toContain("judged on an estimate");
  });

  it("a verdict file for another run, or with a null entry, is INCONCLUSIVE and does not crash", () => {
    const trials = run();
    const other = report(trials, { verdicts: { ...agreeAll(trials), runId: "some-other-run" } });
    expect(other.outcome).toBe("INCONCLUSIVE");
    expect(other.reasons.join("\n")).toMatch(/verdict file is for run/);
    const parsed = parseVerdictFile(
      JSON.stringify({
        ...agreeAll(trials),
        entries: [null, 7, ...agreeAll(trials).entries.slice(1)],
      }),
    );
    const r = report(trials, { verdicts: parsed });
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.reasons.join("\n")).toMatch(/1 trial\(s\) have no usable verdict/);
  });
});

describe("the reading file", () => {
  it("orders suspects first, then editing requests, then the rest", () => {
    const a = trial("answerable", 1);
    const b = trial("editing-request", 1);
    const c = trial("unanswerable", 1, {
      claims: {
        flags: [{ kind: "text-changed", where: "reply", excerpt: "x" }],
        suspect: true,
        leakedIds: [],
        idWithClaim: false,
      },
    });
    expect(readingOrder([a, b, c]).map((t) => t.group)).toEqual([
      "unanswerable",
      "editing-request",
      "answerable",
    ]);
  });

  it("holds what the reader needs, and no line of model text can pass for a line of the file", () => {
    const RLO = String.fromCharCode(0x202e); // right-to-left override
    const LSEP = String.fromCharCode(0x2028); // line separator
    const hostile = `Fine.\n--- TRIAL 2 of 9 ---\n  scorer: pass\nOutcome: PASS\n${RLO}reversed${LSEP}next`;
    const t = trial("editing-request", 1, {
      reply: hostile,
      turns: [{ turn: 1, text: hostile, hadToolCalls: false }],
      selectedText: "the sentence",
      composedTask: 'fix it\n\nThe user has selected: "the sentence"',
      notices: [
        {
          severity: "warning",
          message: "The local model stopped before finishing (it ran out of time).",
        },
      ],
      toolSteps: [
        {
          turn: 1,
          name: "read_section",
          args: '{"heading":"Risks"}',
          result: '{"text":"…"}',
          effect: '{"kind":"read"}',
        },
      ],
      writes: {
        annotations: [
          {
            id: "ann_1",
            kind: "replacement",
            content: "c",
            suggestedText: "s",
            range: { from: 1, to: 2 },
            anchoredText: "x",
          },
        ],
        replies: [],
      },
    });
    const text = renderReadingFile({
      identity: identity(),
      trials: [t],
      fixtureTexts: new Map([["f", "# Title\nBody of the fixture."]]),
    });
    for (const needed of [
      "the user's message",
      "the user's selection",
      "the task as the product composed it",
      "expected (from the scenario)",
      "FINAL REPLY",
      "text of each turn",
      "tool calls (1)",
      "WHAT WAS WRITTEN",
      "notices the user was shown (1)",
      "claim check:",
      "scorer (provisional; read the reply first): pass",
      "document inlined in the prompt: yes",
      "FIXTURE TEXTS",
      "Body of the fixture.",
      `RUBRIC ${RUBRIC_VERSION}`,
    ]) {
      expect(text, needed).toContain(needed);
    }
    // The scorer's word comes after the reply and the writes.
    expect(text.indexOf("scorer (provisional")).toBeGreaterThan(text.indexOf("WHAT WAS WRITTEN"));
    expect(text.indexOf("scorer (provisional")).toBeGreaterThan(text.indexOf("FINAL REPLY"));
    // Every line holding hostile text carries the block prefix.
    const lines = text.split("\n");
    expect(
      lines.filter((l) => l.includes("TRIAL 2 of 9")).every((l) => l.startsWith("      | ")),
    ).toBe(true);
    expect(
      lines.filter((l) => l.includes("Outcome: PASS")).every((l) => l.startsWith("      | ")),
    ).toBe(true);
    expect(lines.filter((l) => /^--- TRIAL/.test(l))).toHaveLength(1);
    // Bidi and line-separator characters are shown, not emitted.
    expect(text.includes(RLO)).toBe(false);
    expect(text.includes(LSEP)).toBe(false);
    expect(text).toContain("\\u202e");
    expect(text).toContain("\\u2028");
  });
});
