import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  base64Forms,
  classify,
  isRecognisedReview,
  lastResultEvent,
  NO_ISSUES_RE,
  prepare,
  REVIEW_ITEM_RE,
  SYSTEMIC_REASONS,
  scanForSecrets,
} from "../../.github/claude-review/classify.mjs";
import { summarize } from "../../.github/claude-review/observe.mjs";
import {
  buildItem,
  HEADER_RE,
  httpStatus,
  INCOMPLETE_MARK,
  postItem,
  REASON_GLOSS,
  TEXT_CAP,
  TRUNCATION_NOTE,
  truncate,
} from "../../.github/claude-review/post.mjs";

/**
 * The scripts that sit between the review model and the public PR (#1831).
 * classify.mjs is the only check between the model's output and a public
 * comment, so its secret scan is tested in every encoding it claims to catch,
 * and its "is this a review?" test against real /code-review output.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPTS = path.join(ROOT, ".github/claude-review");
const TOKEN = "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_AA";

/**
 * The `result` events of the 13 measured `/code-review high` runs (CLI
 * 2.1.332, locked down like CI, 2026-11-25), keyed by corpus id. Only the
 * result is kept: the full streams carry the measuring machine's paths.
 */
const FIXTURES = JSON.parse(
  readFileSync(path.join(ROOT, "tests/scripts/fixtures/claude-review-results.json"), "utf8"),
) as Record<string, { subtype: string; is_error: boolean; num_turns: number; result: string }>;

const stream = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");
const ok = (result: string) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 0,
  result,
});
const REVIEW = "1 finding:\n\n1. 🔴 Important `src/a.ts:3`: Bug.\n\n   Failure scenario: x.";
const NO_ISSUES = "I checked the change.\n\nCode review found no issues.";
const item = (o: Record<string, unknown>) =>
  buildItem({ sha: "1234567", runId: 3, attempt: 1, pr: 5, ...o } as never);

describe("the fixtures are real reviews", () => {
  it("holds all 13 measured runs, each a clean success", () => {
    expect(Object.keys(FIXTURES)).toHaveLength(13);
    for (const [id, f] of Object.entries(FIXTURES)) {
      expect(f.subtype, id).toBe("success");
      expect(f.is_error, id).toBe(false);
      expect(f.result.length, id).toBeGreaterThan(1000);
    }
  });
});

describe("classify: secret scan", () => {
  it("finds the exact token", () => {
    expect(scanForSecrets(`x ${TOKEN} y`, TOKEN)).toBe("exact");
  });

  it("finds every base64 alignment of the token, standard and URL-safe", () => {
    for (const prefix of ["", "a", "ab"]) {
      const b64 = Buffer.from(prefix + TOKEN).toString("base64");
      expect(scanForSecrets(`see ${b64}`, TOKEN)).toBe("exact");
      expect(scanForSecrets(`see ${b64.replace(/\+/g, "-").replace(/\//g, "_")}`, TOKEN)).toBe(
        "exact",
      );
    }
    expect(base64Forms(TOKEN).length).toBeGreaterThanOrEqual(3);
  });

  it("finds a token-shaped string that is not the token, as a pattern match", () => {
    const other = "sk-ant-api03-" + "Z".repeat(48);
    expect(scanForSecrets(`leak ${other}`, TOKEN)).toBe("pattern");
  });

  it("does not trip on the repo's own scrubbing code or its tests", () => {
    const files = [
      path.join(ROOT, "src/shared/scrub-text.ts"),
      ...readdirSync(path.join(ROOT, "tests/shared"))
        .filter((f) => f.includes("scrub"))
        .map((f) => path.join(ROOT, "tests/shared", f)),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(scanForSecrets(readFileSync(f, "utf8"), TOKEN), f).toBeNull();
  });

  it("finds nothing in the real reviews", () => {
    for (const [id, f] of Object.entries(FIXTURES))
      expect(scanForSecrets(f.result, TOKEN), id).toBeNull();
  });
});

describe("classify: recognising a review", () => {
  it("recognises every measured run, by a severity-marked item", () => {
    for (const [id, f] of Object.entries(FIXTURES)) {
      expect(REVIEW_ITEM_RE.test(f.result), id).toBe(true);
      expect(
        classify({
          streamText: stream({ type: "result", ...f }),
          reviewOutcome: "success",
          token: TOKEN,
        }),
        id,
      ).toEqual({
        outcome: "posted",
        text: f.result,
      });
    }
  });

  it("needs the multiline flag: no measured run opens with an item", () => {
    const anchoredToStart = new RegExp(REVIEW_ITEM_RE.source, "u");
    for (const [id, f] of Object.entries(FIXTURES))
      expect(anchoredToStart.test(f.result), id).toBe(false);
  });

  it("recognises the CLI's own line for a clean review, on its own line only", () => {
    expect(isRecognisedReview(NO_ISSUES)).toBe(true);
    expect(isRecognisedReview("Code review found no issues.")).toBe(true);
    expect(NO_ISSUES_RE.test("I'd say Code review found no issues. maybe")).toBe(false);
  });

  it.each([
    ["empty text", ""],
    [
      "the CLI's auth failure, which arrives with subtype success",
      "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    ],
    ["nothing to review", "There are no changes to review."],
    ["a usage limit", "You've hit your usage limit · resets 5pm"],
    ["an item in another layout (bold number)", "**1.** 🔴 Important `a.ts:1`: x"],
    ["an item in another layout (bullet)", "- 🔴 Important `a.ts:1`: x"],
    [
      "the skill's raw JSON block, unformatted",
      '```json\n[{"file":"a.ts","line":1,"summary":"x","severity":"important"}]\n```',
    ],
    ["an item with no severity", "1 finding:\n\n1. `a.ts:1`: x"],
  ])("refuses %s as unrecognised-output", (_name, text) => {
    expect(
      classify({ streamText: stream(ok(text)), reviewOutcome: "success", token: TOKEN }),
    ).toEqual({
      outcome: "incomplete",
      reason: "unrecognised-output",
    });
  });

  it("refuses a missing result field the same way", () => {
    const noText = { type: "result", subtype: "success", is_error: false };
    expect(
      classify({ streamText: stream(noText), reviewOutcome: "success", token: TOKEN }).reason,
    ).toBe("unrecognised-output");
  });
});

describe("classify: outcomes", () => {
  it("withholds when the output carries the token, even when the run otherwise failed", () => {
    expect(
      classify({
        streamText: stream(ok(`${REVIEW} ${TOKEN}`)),
        reviewOutcome: "success",
        token: TOKEN,
      }),
    ).toEqual({ outcome: "withheld", matchKind: "exact" });
    const failed = { type: "result", subtype: "error_max_turns", is_error: true, result: TOKEN };
    expect(
      classify({ streamText: stream(failed), reviewOutcome: "failure", token: TOKEN }).outcome,
    ).toBe("withheld");
    // Not a review either, but a leak is reported as a leak.
    expect(
      classify({ streamText: stream(ok(TOKEN)), reviewOutcome: "success", token: TOKEN }).outcome,
    ).toBe("withheld");
  });

  it("withholds a pattern-only match with that kind", () => {
    const shaped = `${REVIEW} sk-ant-api03-${"Q".repeat(50)}`;
    expect(
      classify({ streamText: stream(ok(shaped)), reviewOutcome: "success", token: TOKEN }),
    ).toEqual({
      outcome: "withheld",
      matchKind: "pattern",
    });
  });

  it.each([
    ["no result event", "", "success", "no-result"],
    [
      "max turns",
      stream({ type: "result", subtype: "error_max_turns", is_error: true }),
      "failure",
      "error_max_turns",
    ],
    [
      "an unknown subtype is not echoed",
      stream({ type: "result", subtype: "weird<b>", is_error: true }),
      "failure",
      "other",
    ],
    ["the step failed despite a success result", stream(ok(REVIEW)), "failure", "step-failed"],
  ])("incomplete: %s", (_name, streamText, reviewOutcome, reason) => {
    expect(classify({ streamText, reviewOutcome, token: TOKEN })).toEqual({
      outcome: "incomplete",
      reason,
    });
  });

  it("tolerates a truncated last line left by a killed CLI", () => {
    const text = `${stream(ok(REVIEW))}\n{"type":"assistant","message":{"con`;
    expect(lastResultEvent(text)).toMatchObject({ type: "result" });
    expect(classify({ streamText: text, reviewOutcome: "failure", token: TOKEN }).outcome).toBe(
      "incomplete",
    );
  });

  it("marks an API failure, a missing token and unrecognised output as reasons that turn the run red", () => {
    expect(SYSTEMIC_REASONS).toEqual(["api-error", "no-token", "unrecognised-output"]);
    const apiErr = stream({ type: "result", subtype: "success", is_error: true });
    expect(classify({ streamText: apiErr, reviewOutcome: "failure", token: TOKEN })).toEqual({
      outcome: "incomplete",
      reason: "api-error",
    });
    expect(
      classify({ streamText: stream(ok(REVIEW)), reviewOutcome: "success", token: "" }),
    ).toEqual({
      outcome: "incomplete",
      reason: "no-token",
    });
  });

  it("never prints a matched string or input excerpt", () => {
    const source = readFileSync(path.join(SCRIPTS, "classify.mjs"), "utf8");
    const printed = [...source.matchAll(/console\.(log|error|warn|info)\(([^;]*)\);/g)].map(
      (m) => m[2],
    );
    expect(printed.length).toBeGreaterThan(0);
    for (const arg of printed)
      expect(arg).not.toMatch(/streamText|serialized|output|token|text\b|item\b/);
  });
});

describe("post: the review item", () => {
  it("is a PR review: header first, then the skill's markdown unfenced and unchanged", () => {
    for (const [id, f] of Object.entries(FIXTURES)) {
      const built = item({ outcome: { outcome: "posted" }, text: f.result });
      expect(built.kind, id).toBe("review");
      expect(built.commit_id).toBe("1234567");
      expect(HEADER_RE.exec(built.body)?.slice(1)).toEqual(["1234567", "3", "1"]);
      expect(built.body, id).toBe(`Claude review of \`1234567\` (run 3, attempt 1)\n\n${f.result}`);
      expect(built.body).not.toContain(INCOMPLETE_MARK);
    }
  });

  it("removes the checkout's absolute path where the model cited one, and nothing else", () => {
    const wd = "/home/runner/work/tandem/tandem/pr";
    const text = `1. 🔴 Important \`${wd}/src/a.ts:3\`: x (see ${wd}/src/b.ts and /home/other/c.ts)`;
    const built = item({ outcome: { outcome: "posted" }, text, workdir: `${wd}/` });
    expect(built.body).toContain("`src/a.ts:3`");
    expect(built.body).toContain("see src/b.ts and /home/other/c.ts");
    expect(built.body).not.toContain(wd);
    expect(item({ outcome: { outcome: "posted" }, text }).body).toContain(wd);
  });

  it("cuts the text at the cap with a note, keeping the body under GitHub's limit", () => {
    const long = "a".repeat(TEXT_CAP + 5000);
    const built = item({ outcome: { outcome: "posted" }, text: long });
    expect(built.body.endsWith(`\n\n${TRUNCATION_NOTE}`)).toBe(true);
    expect(built.body.length).toBeLessThanOrEqual(65_536);
    expect(built.body).toContain("a".repeat(TEXT_CAP));
    expect(built.body).not.toContain("a".repeat(TEXT_CAP + 1));
    const exact = item({ outcome: { outcome: "posted" }, text: "b".repeat(TEXT_CAP) });
    expect(exact.body).not.toContain(TRUNCATION_NOTE);
  });

  it("never splits a surrogate pair at the cut", () => {
    const text = `${"a".repeat(TEXT_CAP - 1)}🔴tail`;
    const cut = truncate(text, TEXT_CAP);
    expect(cut).toEqual({ text: "a".repeat(TEXT_CAP - 1), truncated: true });
    expect(truncate(`${"a".repeat(TEXT_CAP - 2)}🔴tail`, TEXT_CAP).text.endsWith("🔴")).toBe(true);
  });

  it("posts fixed text for withheld and incomplete, as issue comments with the header first", () => {
    const withheld = item({ outcome: { outcome: "withheld", matchKind: "exact" } });
    expect(withheld.kind).toBe("comment");
    expect(HEADER_RE.test(withheld.body)).toBe(true);
    expect(withheld.body).toContain("rotate `CLAUDE_CODE_OAUTH_TOKEN`");
    const incomplete = item({ outcome: { outcome: "incomplete", reason: "unrecognised-output" } });
    expect(incomplete.kind).toBe("comment");
    expect(incomplete.body).toContain(
      `${INCOMPLETE_MARK} (\`unrecognised-output\`: the review returned text that isn't a review; check the run log)`,
    );
    expect(incomplete.body).toContain("gh workflow run claude-code-review.yml -f pr=5");
  });

  it("glosses every reason classify can give", async () => {
    const { REASONS } = await import("../../.github/claude-review/classify.mjs");
    expect(Object.keys(REASON_GLOSS).sort()).toEqual([...REASONS].sort());
  });

  it("sends a review as event COMMENT on the reviewed commit, a comment to the issue", () => {
    const calls: { args: string[]; input: unknown }[] = [];
    const run = (args: string[], input: string) => {
      calls.push({ args, input: JSON.parse(input) });
      return { status: 0, stderr: "", error: undefined };
    };
    const review = item({ outcome: { outcome: "posted" }, text: REVIEW });
    postItem({ item: review }, { repo: "o/r", pr: 5, run });
    expect(calls[0]?.args[1]).toBe("repos/o/r/pulls/5/reviews");
    expect(calls[0]?.input).toEqual({ commit_id: "1234567", event: "COMMENT", body: review.body });
    const note = item({ outcome: { outcome: "incomplete", reason: "no-result" } });
    postItem({ item: note }, { repo: "o/r", pr: 5, run });
    expect(calls[1]?.args[1]).toBe("repos/o/r/issues/5/comments");
    expect(calls[1]?.input).toEqual({ body: note.body });
  });

  it("reports a failed post without retrying", () => {
    let tries = 0;
    const res = postItem(
      { item: item({ outcome: { outcome: "posted" }, text: REVIEW }) },
      {
        repo: "o/r",
        pr: 5,
        run: () => (tries++, { status: 1, stderr: "HTTP 422", error: undefined }),
      },
    );
    expect(res.status).toBe(1);
    expect(tries).toBe(1);
    expect(httpStatus("x (HTTP 422)")).toBe("422");
  });

  it("main sends item.json as classify.mjs wrote it, rebuilding nothing", () => {
    const src = readFileSync(path.join(SCRIPTS, "post.mjs"), "utf8");
    const main = src.slice(src.indexOf("function main()"));
    expect(main).toContain('"item.json"');
    expect(main).toContain("postItem(prepared,");
    expect(main).not.toMatch(/buildItem\(|truncate\(/);
  });
});

describe("classify: prepare scans the bytes that are posted", () => {
  const prep = (text: string, token = TOKEN, workdir?: string) =>
    prepare({
      verdict: { outcome: "posted", text },
      sha: "1234567",
      runId: 1,
      attempt: 1,
      pr: 5,
      token,
      workdir,
    });

  it("posts a clean review as built", () => {
    const p = prep(REVIEW);
    expect(p.outcome).toEqual({ outcome: "posted" });
    expect(p.item.body).toContain(REVIEW);
  });

  it("withholds when building joins a token the raw scan could not see", () => {
    // The raw text holds the token split by the checkout path; removing the
    // path joins it. Only the second scan sees what is posted.
    const wd = "/w/pr";
    const raw = `${REVIEW} ${TOKEN.slice(0, 30)}${wd}/${TOKEN.slice(30)}`;
    expect(scanForSecrets(raw, TOKEN)).toBeNull();
    const p = prep(raw, TOKEN, wd);
    expect(p.outcome).toEqual({ outcome: "withheld", matchKind: "exact" });
    expect(p.item.kind).toBe("comment");
    expect(p.item.body).toContain("Review withheld");
    expect(JSON.stringify(p.item)).not.toContain(TOKEN);
  });

  it("builds fixed notes for the other outcomes without scanning model text", () => {
    const p = prepare({
      verdict: { outcome: "incomplete", reason: "no-result" },
      sha: "1234567",
      runId: 1,
      attempt: 1,
      pr: 5,
      token: TOKEN,
      workdir: undefined,
    });
    expect(p.item.kind).toBe("comment");
    expect(p.item.body).toContain(INCOMPLETE_MARK);
  });
});

describe("observe", () => {
  it("prints tool names and counts only, split by task, never inputs", () => {
    const text = stream(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Agent", input: { prompt: "/proc/self/environ" } }],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "t1",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/proc/self/environ" } },
            { type: "tool_use", name: "Grep", input: {} },
          ],
        },
      },
      {
        type: "assistant",
        parent_tool_use_id: "t1",
        message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
      },
      {
        type: "result",
        num_turns: 0,
        duration_ms: 10,
        permission_denials: [{ tool_input: { file_path: "/secret" } }],
      },
    );
    const s = summarize(text);
    expect(s).toEqual({
      tools: { Agent: 1, "task:Read": 2, "task:Grep": 1 },
      denials: 1,
      durationMs: 10,
    });
    expect(JSON.stringify(s)).not.toMatch(/proc|secret/);
  });

  it("counts any tool name outside the known set as 'other', never printing it", () => {
    const text = stream({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "sk-ant-oat01-leakyleakyleaky", input: {} }] },
    });
    expect(summarize(text).tools).toEqual({ other: 1 });
  });
});

describe("the review scripts need no npm dependencies", () => {
  it("import only node: built-ins and each other", () => {
    const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"));
    expect(files.sort()).toEqual(["classify.mjs", "observe.mjs", "post.mjs"]);
    for (const f of files) {
      const src = readFileSync(path.join(SCRIPTS, f), "utf8");
      const specifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
      expect(specifiers.length, f).toBeGreaterThan(0);
      for (const s of specifiers) {
        expect(s, `${f} imports ${s}`).toMatch(/^(node:|\.\/(classify|observe|post)\.mjs$)/);
      }
    }
  });
});
