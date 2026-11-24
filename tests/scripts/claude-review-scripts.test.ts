import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildAgents,
  parseAgent,
  SPECIALISTS,
  TOOLS,
} from "../../.github/claude-review/build-agents.mjs";
import {
  base64Forms,
  classify,
  isValidReview,
  lastResultEvent,
  scanForSecrets,
} from "../../.github/claude-review/classify.mjs";
import { summarize } from "../../.github/claude-review/observe.mjs";
import {
  BODY_CAP,
  buildItem,
  cap,
  commentableLines,
  FINDING_CAP,
  HEADER_RE,
  header,
  postItem,
  sanitize,
} from "../../.github/claude-review/post.mjs";

/**
 * The scripts that sit between the review model and the public PR (#1831).
 * classify.mjs is the only check between the model's output and a public
 * comment, so its secret scan is tested in every encoding it claims to catch;
 * post.mjs decides what model text may look like once posted.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPTS = path.join(ROOT, ".github/claude-review");
const TOKEN = "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_AA";

const stream = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n");
const ok = (structured_output: unknown) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output,
});
const review = {
  summary: "Looks fine.",
  findings: [{ path: "src/a.ts", line: 3, severity: "important", body: "Bug." }],
};

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

  it("finds nothing in clean text", () => {
    expect(scanForSecrets(JSON.stringify(review), TOKEN)).toBeNull();
  });
});

describe("classify: outcomes", () => {
  it("posts a clean, schema-valid success", () => {
    expect(
      classify({ streamText: stream(ok(review)), reviewOutcome: "success", token: TOKEN }),
    ).toEqual({
      outcome: "posted",
      review,
    });
  });

  it("withholds when the output carries the token, even when the run otherwise failed", () => {
    const leaky = { summary: `token ${TOKEN}`, findings: [] };
    expect(
      classify({ streamText: stream(ok(leaky)), reviewOutcome: "success", token: TOKEN }),
    ).toEqual({
      outcome: "withheld",
      matchKind: "exact",
    });
    const failed = { type: "result", subtype: "error_max_turns", is_error: true, result: TOKEN };
    expect(
      classify({ streamText: stream(failed), reviewOutcome: "failure", token: TOKEN }).outcome,
    ).toBe("withheld");
  });

  it("withholds a pattern-only match with that kind", () => {
    const shaped = { summary: `x sk-ant-api03-${"Q".repeat(50)}`, findings: [] };
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
    [
      "schema-invalid output with a success subtype",
      stream(ok({ summary: 1, findings: [] })),
      "success",
      "schema-invalid",
    ],
    ["the step failed despite a success result", stream(ok(review)), "failure", "step-failed"],
  ])("incomplete: %s", (_name, streamText, reviewOutcome, reason) => {
    expect(classify({ streamText, reviewOutcome, token: TOKEN })).toEqual({
      outcome: "incomplete",
      reason,
    });
  });

  it("tolerates a truncated last line left by a killed CLI", () => {
    const text = `${stream(ok(review))}\n{"type":"assistant","message":{"con`;
    expect(lastResultEvent(text)).toMatchObject({ type: "result" });
    expect(classify({ streamText: text, reviewOutcome: "failure", token: TOKEN }).outcome).toBe(
      "incomplete",
    );
  });

  it("validates the review schema strictly", () => {
    expect(isValidReview(review)).toBe(true);
    expect(
      isValidReview({
        summary: "",
        findings: [{ path: "a", line: 0, severity: "important", body: "" }],
      }),
    ).toBe(false);
    expect(
      isValidReview({
        summary: "",
        findings: [{ path: "a", line: 1, severity: "critical", body: "" }],
      }),
    ).toBe(false);
    expect(isValidReview([])).toBe(false);
  });

  it("never prints a matched string or input excerpt", () => {
    const source = readFileSync(path.join(SCRIPTS, "classify.mjs"), "utf8");
    const printed = [...source.matchAll(/console\.(log|error|warn|info)\(([^;]*)\);/g)].map(
      (m) => m[2],
    );
    expect(printed.length).toBeGreaterThan(0);
    for (const arg of printed)
      expect(arg).not.toMatch(/streamText|serialized|output|token|review\b/);
  });
});

describe("post: sanitising and placement", () => {
  it("strips HTML comments, images and raw HTML, and defuses @mentions", () => {
    const out = sanitize(
      "Hi @bloknayrb and @org/team <!-- hidden --> ![x](http://e/i.png) <img src=x> <b>b</b> `@code`",
    );
    expect(out).not.toMatch(/<!--|!\[|<img|<b>/);
    expect(out).toContain("`@bloknayrb`");
    expect(out).toContain("`@org/team`");
    expect(out).toContain("`@code`");
  });

  it("cannot let model text forge a header, because the header is prepended after sanitising", () => {
    const forged = { summary: "", findings: [] };
    const item = buildItem({
      outcome: { outcome: "posted" },
      findings: { ...forged, summary: header("abcdef1", 999, 1) },
      diffText: "",
      sha: "1234567",
      runId: 42,
      attempt: 2,
      pr: 7,
    });
    const m = HEADER_RE.exec(item.body);
    expect(m?.[2]).toBe("42");
    expect(m?.[3]).toBe("2");
  });

  it("sanitises the summary as well as the findings", () => {
    const item = buildItem({
      outcome: { outcome: "posted" },
      findings: { summary: "cc @someone <!-- x --> ![i](http://e/p.png)", findings: [] },
      diffText: "",
      sha: "1234567",
      runId: 1,
      attempt: 1,
      pr: 5,
    });
    expect(item.body).toContain("`@someone`");
    expect(item.body).not.toMatch(/<!--|!\[/);
  });

  it("maps findings onto right-hand diff lines and folds the rest into the body", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+TWO",
      "+three",
      " four",
    ].join("\n");
    expect([...(commentableLines(diff).get("src/a.ts") ?? [])]).toEqual([1, 2, 3, 4]);
    const item = buildItem({
      outcome: { outcome: "posted" },
      findings: {
        summary: "s",
        findings: [
          { path: "src/a.ts", line: 2, severity: "important", body: "in diff" },
          { path: "src/b.ts", line: 9, severity: "nit", body: "outside" },
        ],
      },
      diffText: diff,
      sha: "1234567",
      runId: 1,
      attempt: 1,
      pr: 5,
    });
    expect(item.kind).toBe("review");
    expect(item.comments).toEqual([
      { path: "src/a.ts", line: 2, side: "RIGHT", body: "**important:** in diff" },
    ]);
    expect(item.body).toContain("`src/b.ts:9` **nit:** outside");
  });

  it("says No findings. on an empty review", () => {
    const item = buildItem({
      outcome: { outcome: "posted" },
      findings: { summary: "", findings: [] },
      diffText: "",
      sha: "1234567",
      runId: 1,
      attempt: 1,
      pr: 5,
    });
    expect(HEADER_RE.test(item.body)).toBe(true);
    expect(item.body).toContain("No findings.");
  });

  it("caps the combined body and each inline body", () => {
    expect(cap("x".repeat(BODY_CAP + 10), BODY_CAP)).toHaveLength(BODY_CAP);
    const many = Array.from({ length: 30 }, (_, i) => ({
      path: "z.ts",
      line: i + 1,
      severity: "nit",
      body: "y".repeat(5000),
    }));
    const item = buildItem({
      outcome: { outcome: "posted" },
      findings: { summary: "s", findings: many },
      diffText: "",
      sha: "1234567",
      runId: 1,
      attempt: 1,
      pr: 5,
    });
    expect(item.body.length).toBeLessThanOrEqual(BODY_CAP);
    const big = buildItem({
      outcome: { outcome: "posted" },
      findings: {
        summary: "s",
        findings: [{ path: "a", line: 1, severity: "nit", body: "q".repeat(FINDING_CAP * 2) }],
      },
      diffText: "+++ b/a\n@@ -0,0 +1 @@\n+x",
      sha: "1234567",
      runId: 1,
      attempt: 1,
      pr: 5,
    });
    expect(big.comments).toHaveLength(1);
    expect(big.comments?.[0]?.body.length).toBeLessThanOrEqual(FINDING_CAP);
  });

  it("posts fixed text for withheld and incomplete, with the header first", () => {
    const withheld = buildItem({
      outcome: { outcome: "withheld", matchKind: "exact" },
      sha: "1234567",
      runId: 3,
      attempt: 1,
      pr: 5,
    } as never);
    expect(withheld.kind).toBe("comment");
    expect(HEADER_RE.test(withheld.body)).toBe(true);
    expect(withheld.body).toContain("rotate `CLAUDE_CODE_OAUTH_TOKEN`");
    const incomplete = buildItem({
      outcome: { outcome: "incomplete", reason: "no-result" },
      sha: "1234567",
      runId: 3,
      attempt: 1,
      pr: 5,
    } as never);
    expect(incomplete.body).toContain("did not complete (`no-result`)");
    expect(incomplete.body).toContain("gh workflow run claude-code-review.yml -f pr=5");
  });

  it("retries a refused review as body-only, and reports a failed post", () => {
    const calls: string[] = [];
    const item = {
      kind: "review",
      body: "B",
      comments: [{ path: "a", line: 1, side: "RIGHT", body: "c" }],
      commit_id: "1234567",
    };
    const res = postItem(item, {
      repo: "o/r",
      pr: 5,
      run: (_args: string[], input: string) => {
        calls.push(input);
        return { status: calls.length === 1 ? 1 : 0, stderr: "" };
      },
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(calls[1]).comments).toEqual([]);
    expect(JSON.parse(calls[1]).body).toContain("`a:1` c");
    const failed = postItem(
      { kind: "comment", body: "x" },
      { repo: "o/r", pr: 5, run: () => ({ status: 1, stderr: "" }) },
    );
    expect(failed.status).toBe(1);
  });
});

describe("observe", () => {
  it("prints tool names and counts only, never inputs", () => {
    const text = stream(
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/proc/self/environ" } }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: {} },
            { type: "tool_use", name: "Agent", input: {} },
          ],
        },
      },
      {
        type: "result",
        num_turns: 4,
        duration_ms: 10,
        permission_denials: [{ tool_input: { file_path: "/secret" } }],
      },
    );
    const s = summarize(text);
    expect(s).toEqual({ tools: { Read: 2, Agent: 1 }, denials: 1, turns: 4, durationMs: 10 });
    expect(JSON.stringify(s)).not.toMatch(/proc|secret/);
  });
});

describe("build-agents", () => {
  it("keeps only the five specialists and forces read-only tools", () => {
    const agents = buildAgents((name: string) =>
      readFileSync(path.join(ROOT, ".claude/agents", `${name}.md`), "utf8"),
    );
    expect(Object.keys(agents).sort()).toEqual([...SPECIALISTS].sort());
    for (const a of Object.values(agents) as { tools: string[]; prompt: string }[]) {
      expect(a.tools).toEqual(TOOLS);
      expect(a.prompt).toMatch(/^You are running inside an automated, read-only/);
    }
    expect(SPECIALISTS).not.toContain("diverge-critic");
  });

  it("refuses an agent file whose name does not match", () => {
    expect(() => buildAgents(() => "---\nname: other\ndescription: d\n---\nbody")).toThrow(
      /declares name/,
    );
    expect(() => parseAgent("no frontmatter")).toThrow();
  });
});

describe("the review scripts use only node: built-ins", () => {
  it("imports nothing else", () => {
    const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"));
    expect(files.sort()).toEqual(["build-agents.mjs", "classify.mjs", "observe.mjs", "post.mjs"]);
    for (const f of files) {
      const src = readFileSync(path.join(SCRIPTS, f), "utf8");
      const specifiers = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
      expect(specifiers.length, f).toBeGreaterThan(0);
      for (const s of specifiers) expect(s, `${f} imports ${s}`).toMatch(/^node:/);
    }
  });
});
