import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HEADER_RE,
  header,
  INCOMPLETE_MARK,
  INLINE_COUNT_RE,
} from "../../.github/claude-review/post.mjs";
import {
  decide,
  HEADER_RE as GATE_HEADER_RE,
  INCOMPLETE_MARK as GATE_INCOMPLETE,
  INLINE_COUNT_RE as GATE_INLINE_RE,
  run,
  selectRuns,
  touchesReview,
} from "../../scripts/ci/await-claude-review.mjs";

/**
 * The merge gate for the cloud Claude review (#1831). It decides from run and
 * attempt conclusions and uses the bot's PR items only to find the text to act
 * on. Driven through an injected `gh`.
 */

/** The gate returns several result shapes; tests read optional fields off any of them. */
const loose = (v: unknown) => v as Record<string, unknown>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const PR = 12;
const TITLE = `Claude review PR #${PR}`;
type Run = {
  databaseId: number;
  displayTitle: string;
  status: string;
  conclusion: string;
  attempt: number;
  createdAt: string;
  url: string;
  event: string;
  headBranch: string;
};
const mkRun = (id: number, conclusion: string, opts: Partial<Run> = {}): Run => ({
  databaseId: id,
  displayTitle: TITLE,
  status: "completed",
  conclusion,
  attempt: 1,
  createdAt: `2026-11-24T10:${String(id).padStart(2, "0")}:00Z`,
  url: `https://example/runs/${id}`,
  event: "pull_request",
  headBranch: "fix/x",
  ...opts,
});
const dispatchRun = (id: number, conclusion: string, opts: Partial<Run> = {}) =>
  mkRun(id, conclusion, { event: "workflow_dispatch", headBranch: "master", ...opts });
const SCOPE = { headBranch: "fix/x", defaultBranch: "master" };
const item = (runId: number, attempt: number) => ({
  body: `${header("abc1234", runId, attempt)}\n\nNo findings.`,
});

describe("gate integrity", () => {
  it("ignores a run with the right title from a dispatch off the default branch, another branch, or another event", () => {
    const forgedDispatch = dispatchRun(7, "success", { headBranch: "evil" });
    const otherBranch = mkRun(8, "success", { headBranch: "other" });
    const pushEvent = mkRun(9, "success", { event: "push" });
    expect(selectRuns([[otherBranch, pushEvent], [forgedDispatch]], PR, SCOPE)).toEqual([]);
  });

  it("stops (exit 2) for a PR that changes the review workflow, its scripts or the gate", async () => {
    for (const file of [
      ".github/workflows/claude-code-review.yml",
      ".github/claude-review/post.mjs",
      "scripts/ci/await-claude-review.mjs",
    ]) {
      expect(touchesReview(["src/a.ts", file])).toEqual([file]);
      const gh = fakeGh([
        {
          match: /^pr view 12 /,
          out: { headRefName: "fix/x", headRefOid: "abc", files: [{ path: file }] },
        },
        {
          match: /^repo view /,
          out: { nameWithOwner: "o/r", defaultBranchRef: { name: "master" } },
        },
      ]);
      const v = await run(PR, { gh, sleep: async () => {}, log: () => {} });
      expect(v.exit).toBe(2);
    }
    expect(touchesReview([".github/workflows/ci.yml", "scripts/ci/other.mjs"])).toEqual([]);
  });

  it("carries post.mjs's header, incomplete mark and inline-count pattern, and imports nothing local", () => {
    expect(GATE_HEADER_RE.source).toBe(HEADER_RE.source);
    expect(GATE_INCOMPLETE).toBe(INCOMPLETE_MARK);
    expect(GATE_INLINE_RE.source).toBe(INLINE_COUNT_RE.source);
    const src = readFileSync(path.join(ROOT, "scripts/ci/await-claude-review.mjs"), "utf8");
    const specifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s).toMatch(/^node:/);
  });
});

describe("selectRuns", () => {
  it("merges the branch and dispatch lists, de-duplicates, and matches the exact title", () => {
    const branch = [mkRun(1, "success")];
    const dispatch = [
      dispatchRun(2, "success"),
      mkRun(1, "success"),
      mkRun(3, "success", { displayTitle: "Claude review PR #123" }),
    ];
    expect(selectRuns([branch, dispatch], PR, SCOPE).map((r) => r.databaseId)).toEqual([2, 1]);
  });
});

describe("decide", () => {
  it("exit 0 when the newest successful attempt has its bot item", () => {
    const runs = [mkRun(2, "success"), mkRun(1, "success")];
    const attempts = [
      { runId: 2, attempt: 1, conclusion: "success" },
      { runId: 1, attempt: 1, conclusion: "success" },
    ];
    const v = decide({ runs, attempts, items: [item(1, 1), item(2, 1)] });
    expect(v.exit).toBe(0);
    expect(v.why).toContain("run 2");
  });

  it("exit 2 on any failed attempt, even after a green re-run", () => {
    const runs = [mkRun(5, "success", { attempt: 2 })];
    const attempts = [
      { runId: 5, attempt: 1, conclusion: "failure", url: "u" },
      { runId: 5, attempt: 2, conclusion: "success" },
    ];
    expect(decide({ runs, attempts, items: [item(5, 2)] }).exit).toBe(2);
  });

  it.each(["timed_out", "startup_failure", "action_required", "neutral"])(
    "exit 2 on %s",
    (conclusion) => {
      expect(
        decide({
          runs: [mkRun(1, conclusion)],
          attempts: [{ runId: 1, attempt: 1, conclusion }],
          items: [],
        }).exit,
      ).toBe(2);
    },
  );

  it("exit 2 when a dispatched re-review (recorded against master) failed", () => {
    const runs = selectRuns([[mkRun(1, "success")], [dispatchRun(2, "failure")]], PR, SCOPE);
    const attempts = [
      { runId: 2, attempt: 1, conclusion: "failure" },
      { runId: 1, attempt: 1, conclusion: "success" },
    ];
    expect(decide({ runs, attempts, items: [item(1, 1)] }).exit).toBe(2);
  });

  it("exit 3 for no run or only skipped runs", () => {
    expect(decide({ runs: [], attempts: [], items: [] }).exit).toBe(3);
    expect(
      decide({
        runs: [mkRun(1, "skipped")],
        attempts: [{ runId: 1, attempt: 1, conclusion: "skipped" }],
        items: [],
      }).exit,
    ).toBe(3);
  });

  it("exit 2 when every attempt was cancelled (a job timeout looks like this)", () => {
    expect(
      decide({
        runs: [mkRun(1, "cancelled")],
        attempts: [{ runId: 1, attempt: 1, conclusion: "cancelled" }],
        items: [],
      }).exit,
    ).toBe(2);
  });

  it("exit 2 when a skipped re-run follows a red attempt", () => {
    const runs = [mkRun(1, "skipped", { attempt: 2 })];
    const attempts = [
      { runId: 1, attempt: 1, conclusion: "failure" },
      { runId: 1, attempt: 2, conclusion: "skipped" },
    ];
    expect(decide({ runs, attempts, items: [] }).exit).toBe(2);
  });

  it("exit 4 for a 'did not complete' note, so exit 0 always means a review exists", () => {
    const note = {
      body: `${header("abc1234", 1, 1)}\n\nClaude review did not complete (\`error_max_turns\`). Re-run: ...`,
    };
    const v = decide({
      runs: [mkRun(1, "success")],
      attempts: [{ runId: 1, attempt: 1, conclusion: "success" }],
      items: [note],
    });
    expect(v.exit).toBe(4);
  });

  it("reads the inline count from a review body", () => {
    const review = {
      body: `${header("abc1234", 1, 1)}\n\n_2 inline comments._\n\nSummary.`,
      reviewId: 7,
    };
    const v = decide({
      runs: [mkRun(1, "success")],
      attempts: [{ runId: 1, attempt: 1, conclusion: "success" }],
      items: [review],
    });
    expect(v.exit).toBe(0);
    expect(loose(v).inlineExpected).toBe(2);
  });

  it("exit 3 for a green attempt that posted nothing (the re-check refused the PR)", () => {
    expect(
      decide({
        runs: [mkRun(1, "success")],
        attempts: [{ runId: 1, attempt: 1, conclusion: "success" }],
        items: [],
      }).exit,
    ).toBe(3);
  });

  it("reads the newest successful attempt's item, not a stale one, when a later attempt was cancelled", () => {
    const runs = [mkRun(1, "cancelled", { attempt: 2 })];
    const attempts = [
      { runId: 1, attempt: 1, conclusion: "success" },
      { runId: 1, attempt: 2, conclusion: "cancelled" },
    ];
    expect(decide({ runs, attempts, items: [item(1, 1)] }).exit).toBe(0);
  });

  it("does not accept another attempt's item for the newest successful attempt", () => {
    const runs = [mkRun(1, "success", { attempt: 2 })];
    const attempts = [
      { runId: 1, attempt: 1, conclusion: "success" },
      { runId: 1, attempt: 2, conclusion: "success" },
    ];
    expect(decide({ runs, attempts, items: [item(1, 1)] }).exit).toBe(3);
    expect(decide({ runs, attempts, items: [item(1, 1), item(1, 2)] }).exit).toBe(0);
  });

  it("matches on run id and attempt, so a later fix commit does not hide the review", () => {
    const v = decide({
      runs: [mkRun(1, "success")],
      attempts: [{ runId: 1, attempt: 1, conclusion: "success" }],
      items: [item(1, 1)],
    });
    expect(v.exit).toBe(0);
    expect(loose(v).sha).toBe("abc1234");
  });
});

/** A scripted gh: answers by matching the joined argument list. */
function fakeGh(table: { match: RegExp; out: unknown | (() => unknown) }[], seen: string[] = []) {
  return (args: string[]) => {
    const line = args.join(" ");
    seen.push(line);
    const hit = table.find((t) => t.match.test(line));
    if (!hit) return { status: 1, stdout: "", stderr: `unexpected: ${line}` };
    const out = typeof hit.out === "function" ? (hit.out as () => unknown)() : hit.out;
    return { status: 0, stdout: typeof out === "string" ? out : JSON.stringify(out), stderr: "" };
  };
}
const base = [
  {
    match: /^pr view 12 /,
    out: { headRefName: "fix/x", headRefOid: "abc1234ffff", files: [{ path: "src/a.ts" }] },
  },
  { match: /^repo view /, out: { nameWithOwner: "o/r", defaultBranchRef: { name: "master" } } },
];
const lines = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");

describe("run (through an injected gh)", () => {
  it("finds the bot item in issue comments and ignores a header copied into a human's item", async () => {
    const gh = fakeGh([
      ...base,
      { match: /^run list .*--branch fix\/x/, out: [mkRun(1, "success")] },
      { match: /^run list .*--event workflow_dispatch/, out: [] },
      { match: /attempts\/1$/, out: { conclusion: "success" } },
      { match: /pulls\/12\/reviews --jq/, out: "" },
      { match: /issues\/12\/comments --jq/, out: lines({ body: item(1, 1).body, id: 9 }) },
    ]);
    const v = await run(PR, { gh, sleep: async () => {}, log: () => {} });
    expect(v.exit).toBe(0);
    const forged = fakeGh([
      ...base,
      { match: /^run list .*--branch/, out: [mkRun(1, "success")] },
      { match: /^run list .*--event/, out: [] },
      { match: /attempts\/1$/, out: { conclusion: "success" } },
      // The jq filter keeps github-actions[bot] only; a human's copy never reaches decide().
      { match: /pulls\/12\/reviews --jq .*github-actions\[bot\]/, out: "" },
      { match: /issues\/12\/comments --jq .*github-actions\[bot\]/, out: "" },
    ]);
    expect((await run(PR, { gh: forged, sleep: async () => {}, log: () => {} })).exit).toBe(3);
  });

  it("finds the bot review on a later page (paginated) and reads every attempt", async () => {
    const seen: string[] = [];
    const gh = fakeGh(
      [
        ...base,
        { match: /^run list .*--branch/, out: [mkRun(4, "success", { attempt: 2 })] },
        { match: /^run list .*--event/, out: [] },
        { match: /attempts\/1$/, out: { conclusion: "success" } },
        { match: /attempts\/2$/, out: { conclusion: "success" } },
        { match: /pulls\/12\/reviews\/2\/comments/, out: "" },
        {
          match: /api --paginate repos\/o\/r\/pulls\/12\/reviews --jq/,
          out: lines({ body: "page1", id: 1 }, { body: item(4, 2).body, id: 2 }),
        },
        { match: /issues\/12\/comments/, out: "" },
        { match: /compare\//, out: "1" },
      ],
      seen,
    );
    const v = await run(PR, { gh, sleep: async () => {}, log: () => {} });
    expect(v.exit).toBe(0);
    expect(loose(v).reviewId).toBe(2);
    expect(seen.filter((s) => /attempts\/\d$/.test(s))).toHaveLength(2);
    expect(seen.some((s) => s.startsWith("api --paginate"))).toBe(true);
  });

  it("polls up to the first-run wait, then exits 3 when no run appears", async () => {
    let t = 0;
    let polls = 0;
    const gh = fakeGh([
      ...base,
      { match: /^run list/, out: () => (polls++, []) },
      { match: /reviews|comments/, out: "" },
    ]);
    const v = await run(PR, {
      gh,
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      log: () => {},
      opts: { firstRunWaitMs: 60_000, pollMs: 20_000 },
    });
    expect(v.exit).toBe(3);
    expect(polls).toBeGreaterThan(2);
  });

  it("a draft's skipped run does not end the wait: the ready run that follows is read", async () => {
    let t = 0;
    let lists = 0;
    const gh = fakeGh([
      ...base,
      {
        match: /^run list .*--branch/,
        out: () =>
          ++lists < 3 ? [mkRun(1, "skipped")] : [mkRun(2, "success"), mkRun(1, "skipped")],
      },
      { match: /^run list .*--event/, out: [] },
      { match: /runs\/1\/attempts\/1$/, out: { conclusion: "skipped" } },
      { match: /runs\/2\/attempts\/1$/, out: { conclusion: "success" } },
      { match: /issues\/12\/comments --jq/, out: lines({ body: item(2, 1).body }) },
      { match: /reviews --jq/, out: "" },
    ]);
    const v = await run(PR, {
      gh,
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      log: () => {},
    });
    expect(v.exit).toBe(0);
    expect(lists).toBeGreaterThanOrEqual(3);
  });

  it("only skipped runs, still only skipped after the wait, exit 3", async () => {
    let t = 0;
    const gh = fakeGh([
      ...base,
      { match: /^run list .*--branch/, out: [mkRun(1, "skipped")] },
      { match: /^run list .*--event/, out: [] },
      { match: /attempts\/1$/, out: { conclusion: "skipped" } },
      { match: /reviews|comments/, out: "" },
    ]);
    const v = await run(PR, {
      gh,
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      log: () => {},
      opts: { firstRunWaitMs: 60_000, pollMs: 20_000 },
    });
    expect(v.exit).toBe(3);
  });

  it("fails (exit 1 in main) when the review's inline comments cannot all be fetched", async () => {
    const review = { body: `${header("abc1234", 1, 1)}\n\n_2 inline comments._\n\nS.`, id: 5 };
    const table = (inlineOut: string) =>
      fakeGh([
        ...base,
        { match: /^run list .*--branch/, out: [mkRun(1, "success")] },
        { match: /^run list .*--event/, out: [] },
        { match: /attempts\/1$/, out: { conclusion: "success" } },
        { match: /reviews\/5\/comments/, out: inlineOut },
        { match: /reviews --jq/, out: lines(review) },
        { match: /comments --jq/, out: "" },
      ]);
    const deps = { sleep: async () => {}, log: () => {} };
    await expect(
      run(PR, { gh: table(lines({ path: "a", line: 1, body: "x" })), ...deps }),
    ).rejects.toThrow(/lists 2 inline comments but 1/);
    const ok = await run(PR, {
      gh: table(lines({ path: "a", line: 1, body: "x" }, { path: "b", line: null, body: "y" })),
      ...deps,
    });
    expect(ok.exit).toBe(0);
    expect(loose(ok).inline).toHaveLength(2);
  });

  it("reports a failed run on the branch that never got the review title", async () => {
    const gh = fakeGh([
      ...base,
      {
        match: /^run list .*--branch/,
        out: [
          mkRun(1, "success"),
          mkRun(2, "failure", { displayTitle: ".github/workflows/claude-code-review.yml" }),
        ],
      },
      { match: /^run list .*--event/, out: [] },
      { match: /attempts\/1$/, out: { conclusion: "success" } },
      { match: /issues\/12\/comments --jq/, out: lines({ body: item(1, 1).body }) },
      { match: /reviews --jq/, out: "" },
    ]);
    const v = await run(PR, { gh, sleep: async () => {}, log: () => {} });
    expect(v.exit).toBe(0);
    expect(loose(v).untitledFailures).toEqual(["https://example/runs/2"]);
  });

  it("re-selects after a watch, so a replacement run and a re-run are both followed", async () => {
    let listCalls = 0;
    const seen: string[] = [];
    const gh = fakeGh(
      [
        ...base,
        {
          match: /^run list .*--branch/,
          out: () => {
            listCalls++;
            return listCalls === 1
              ? [mkRun(1, "", { status: "in_progress" })]
              : [mkRun(1, "success", { attempt: 2 })];
          },
        },
        {
          match: /^run list .*--event/,
          out: () => (listCalls === 1 ? [] : [dispatchRun(2, "failure")]),
        },
        { match: /^run watch 1 /, out: "" },
        { match: /runs\/1\/attempts\/1$/, out: { conclusion: "success" } },
        { match: /runs\/1\/attempts\/2$/, out: { conclusion: "success" } },
        { match: /runs\/2\/attempts\/1$/, out: { conclusion: "failure" } },
        { match: /reviews|comments/, out: "" },
      ],
      seen,
    );
    const v = await run(PR, { gh, sleep: async () => {}, log: () => {} });
    expect(seen.some((s) => s.startsWith("run watch 1"))).toBe(true);
    expect(v.exit).toBe(2);
  });

  it("throws (exit 1 in main) when gh fails", async () => {
    const gh = fakeGh([]);
    await expect(run(PR, { gh, sleep: async () => {}, log: () => {} })).rejects.toThrow(/failed/);
  });
});
