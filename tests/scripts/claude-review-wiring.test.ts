import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * ADR-051 wiring test for the cloud Claude review (#1831). Nothing else reads
 * `claude-code-review.yml` inside `check`, and each control below is a
 * one-line edit that would quietly widen what a PR's content can make the
 * review model do with the owner's subscription token. docs/security.md's
 * accepted entry for this workflow lists these same controls as its void-if
 * conditions; this file is what notices when one goes.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIR = path.join(ROOT, ".github/workflows");
const FILE = "claude-code-review.yml";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  "working-directory"?: string;
};
type Job = {
  if?: string;
  env?: Record<string, string>;
  steps: Step[];
  concurrency?: { group: string; "cancel-in-progress": boolean };
  "timeout-minutes"?: number;
};
type Workflow = {
  on: Record<string, unknown>;
  "run-name"?: string;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const raw = readFileSync(path.join(WORKFLOW_DIR, FILE), "utf8");
const wf = parse(raw) as Workflow;
const job = wf.jobs.review;
if (!job) throw new Error(`${FILE} has no 'review' job`);
const steps = job.steps;

function step(id: string): Step {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`${FILE}: no step with id '${id}'`);
  return s;
}
function stepNamed(name: string): Step {
  const s = steps.find((x) => x.name === name);
  if (!s) throw new Error(`${FILE}: no step named '${name}'`);
  return s;
}
const indexOfName = (name: string) => steps.indexOf(stepNamed(name));

const PR_EXPR = "${{ github.event.pull_request.number || inputs.pr }}";
const SKIP = "steps.recheck.outputs.skip == 'false'";
const STARTED = `always() && ${SKIP} && steps.mark-started.outputs.review_started == 'true'`;
const OAUTH = "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}";
const LAST_STEP = "Fail if the review was withheld or the review system is down";

describe("trigger, identity and limits", () => {
  it("runs on new PRs and on owner dispatch, and nothing else", () => {
    expect(wf.on).toEqual({
      pull_request: { types: ["opened", "reopened", "ready_for_review"] },
      workflow_dispatch: {
        inputs: { pr: { description: expect.any(String), required: true, type: "number" } },
      },
    });
    expect(raw).not.toMatch(/pull_request_target|issue_comment|workflow_run/);
  });

  it("names and serialises runs by PR number", () => {
    expect(wf["run-name"]).toBe(`Claude review PR #${PR_EXPR}`);
    expect(job.concurrency).toEqual({
      group: `claude-review-${PR_EXPR}`,
      "cancel-in-progress": false,
    });
  });

  it("holds only contents:read and pull-requests:write", () => {
    expect(wf.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    expect(Object.values(wf.jobs).every((j) => !("permissions" in j))).toBe(true);
  });

  it("gates on not-draft, same-repo, not-Bot, or an owner dispatch", () => {
    const cond = (job.if ?? "").replace(/\s+/g, " ");
    expect(cond).toBe(
      "(github.event_name == 'pull_request' && github.event.pull_request.draft == false && " +
        "github.event.pull_request.head.repo.full_name == github.repository && " +
        "github.event.pull_request.user.type != 'Bot') || " +
        "(github.event_name == 'workflow_dispatch' && github.actor == github.repository_owner)",
    );
  });

  it("re-checks the PR first and refuses forks, drafts, bots and closed PRs without failing", () => {
    expect(steps[0].id).toBe("recheck");
    const run = steps[0].run ?? "";
    expect(run).toMatch(
      /"\$cross" != "false" \] \|\| \[ "\$draft" != "false" \] \|\| \[ "\$state" != "OPEN" \] \|\| \[ "\$bot" = "true" \]/,
    );
    expect(run).toMatch(/echo "skip=true" >> "\$GITHUB_OUTPUT"\n\s*exit 0/);
    for (const s of steps.slice(1)) expect(s.if ?? "", s.name ?? s.uses).toContain(SKIP);
  });

  it("times out the job at 60 and the review step at 40", () => {
    expect(job["timeout-minutes"]).toBe(60);
    expect(step("review")["timeout-minutes"]).toBe(40);
  });

  it("never interpolates an expression into a run script", () => {
    for (const s of steps) expect(s.run ?? "", s.name).not.toMatch(/\$\{\{/);
  });
});

describe("authentication: the subscription token only, never an API key", () => {
  it("no workflow anywhere carries an API-key or cloud-provider path", () => {
    for (const f of readdirSync(WORKFLOW_DIR).filter((x) => /\.ya?ml$/.test(x))) {
      const text = readFileSync(path.join(WORKFLOW_DIR, f), "utf8");
      expect(text, f).not.toMatch(
        /ANTHROPIC_API_KEY|anthropic_api_key|ANTHROPIC_AUTH_TOKEN|use_bedrock|use_vertex|use_foundry|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)|secrets:\s*inherit/i,
      );
    }
  });

  it("holds the OAuth token in exactly the review and classify steps, and no GitHub token there", () => {
    const holders = steps
      .filter((s) => JSON.stringify(s.env ?? {}).includes("secrets.CLAUDE_CODE_OAUTH_TOKEN"))
      .map((s) => s.id);
    expect(raw.match(/secrets\.CLAUDE_CODE_OAUTH_TOKEN/g)).toHaveLength(2);
    expect(holders).toEqual(["review", "classify"]);
    for (const id of ["review", "classify"]) {
      const env = step(id).env ?? {};
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(OAUTH);
      expect(JSON.stringify(env)).not.toMatch(/github\.token|GITHUB_TOKEN|GH_TOKEN/);
    }
    expect(JSON.stringify(wf.env ?? {})).not.toMatch(/secrets\.|token/i);
    expect(Object.keys(job.env ?? {}).sort()).toEqual([
      "CLAUDE_CODE_INTEGRITY",
      "CLAUDE_CODE_VERSION",
    ]);
  });

  it("gives the review step exactly the token and foreground agents", () => {
    // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is deliberately absent: on CLI 2.1.331
    // it forces the permission mode back to default, overriding dontAsk, and
    // with no shell tool there is no subprocess for it to protect.
    expect(step("review").env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    });
    const envKeys = [wf.env, job.env, ...steps.map((s) => s.env)].flatMap((e) =>
      Object.keys(e ?? {}),
    );
    expect(envKeys).not.toContain("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB");
  });

  it("pins the CLI to an exact version and tarball hash, with no install script", () => {
    expect(job.env?.CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(job.env?.CLAUDE_CODE_INTEGRITY).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    const install = stepNamed("Install Claude Code").run ?? "";
    expect(install).toContain(
      'npm pack "@anthropic-ai/claude-code-linux-x64@${CLAUDE_CODE_VERSION}"',
    );
    expect(install).toContain('if [ "$actual" != "$CLAUDE_CODE_INTEGRITY" ]; then');
    expect(install).not.toMatch(/npm (install|i|ci)\b/);
  });
});

describe("the review command", () => {
  const EXPECTED_RUN = [
    "prompt=$(cat ../trusted/.github/claude-review/prompt.md)",
    "schema=$(cat ../trusted/.github/claude-review/schema.json)",
    '"$RUNNER_TEMP/claude-cli/package/claude" -p "$prompt" \\',
    "  --model opus --max-turns 80 \\",
    "  --restricted --permission-mode dontAsk --permission-prompts none \\",
    "  --setting-sources user --strict-mcp-config \\",
    '  --tools "Read,Grep,Glob,Agent" \\',
    '  --disallowedTools "Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch" \\',
    "  --agents ../inputs/agents.json \\",
    '  --json-schema "$schema" \\',
    "  --output-format stream-json --verbose > ../stream.jsonl",
    "",
  ].join("\n");

  it("is exactly the locked-down invocation", () => {
    const review = step("review");
    expect(review.run).toBe(EXPECTED_RUN);
    expect(review["working-directory"]).toBe("pr");
    expect(review["continue-on-error"]).toBe(true);
    expect(review.if).toBe(SKIP);
  });

  it("carries none of the flags that would widen it", () => {
    for (const s of steps) {
      expect(s.run ?? "", s.name).not.toMatch(
        /--add-dir|--mcp-config|--plugin-dir|--settings\b|--bare|--dangerously|--allowedTools|--allowed-tools|bypassPermissions/,
      );
    }
  });

  it("is preceded by its own mark-started step", () => {
    const mark = step("mark-started");
    expect(mark.run).toBe('echo "review_started=true" >> "$GITHUB_OUTPUT"');
    expect(steps.indexOf(mark)).toBe(steps.indexOf(step("review")) - 1);
  });
});

describe("workspace", () => {
  it("checks out master's review config sparse and non-cone, without credentials", () => {
    const trusted = stepNamed("Check out master's review config");
    expect(trusted.with).toEqual({
      ref: "${{ github.event.repository.default_branch }}",
      path: "trusted",
      "persist-credentials": false,
      "sparse-checkout-cone-mode": false,
      "sparse-checkout": "/CLAUDE.md\n/AGENTS.md\n/.github/claude-review/\n/.claude/agents/\n",
    });
  });

  it("checks out the PR head with full history and no credentials", () => {
    expect(stepNamed("Check out the PR").with).toEqual({
      ref: "${{ steps.recheck.outputs.head_sha }}",
      path: "pr",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
  });

  it("deletes symlinks, then agent config at every depth, then restores master's root copies", () => {
    const run = stepNamed("Neutralise the PR checkout").run ?? "";
    const links = run.indexOf("-type l");
    const names = run.indexOf("-name 'CLAUDE.md'");
    const copy = run.indexOf("cp ../trusted/CLAUDE.md ../trusted/AGENTS.md .");
    expect(links).toBeGreaterThanOrEqual(0);
    expect(names).toBeGreaterThan(links);
    expect(copy).toBeGreaterThan(names);
    // The deleting command itself, not the verification find after it, must
    // name every path (the verifier repeats the names, so a check over the
    // whole step would pass with one dropped from the delete).
    const del = run.slice(names, run.indexOf("xargs -0 -r rm -rf") + "xargs -0 -r rm -rf".length);
    expect(del).toContain("-prune -print0 | xargs -0 -r rm -rf");
    for (const n of [
      "'CLAUDE.md'",
      "'CLAUDE.local.md'",
      "'AGENTS.md'",
      "'.claude*'",
      "'.mcp.json'",
      "'.review-input'",
    ]) {
      expect(del).toContain(`-name ${n}`);
    }
    expect(run.startsWith("set -o pipefail\n")).toBe(true);
    expect(run).toMatch(/if \[ "\$left" -ne 0 \]; then[\s\S]*exit 1/);
    expect(run.indexOf('"$left"')).toBeLessThan(copy);
  });

  it("diffs with the default branch's attributes, without textconv or external diff drivers", () => {
    const prep = stepNamed("Prepare review inputs");
    expect(prep.run).toContain(
      'git -C pr --attr-source="origin/$DEFAULT_BRANCH" diff --no-textconv --no-ext-diff \\\n' +
        '  --merge-base "origin/$BASE_REF" "$HEAD_SHA" > inputs/pr.diff',
    );
    expect(prep.run).not.toContain("--text");
    expect(prep.env?.DEFAULT_BRANCH).toBe("${{ github.event.repository.default_branch }}");
  });

  it("lists every path git shows as binary, for the model to Read, under pipefail", () => {
    const prep = stepNamed("Prepare review inputs").run ?? "";
    expect(prep.startsWith("set -o pipefail\n")).toBe(true);
    // No -z: git C-quotes names with a tab or newline, so one file is one
    // line and a filename cannot forge or hide an entry.
    expect(prep).toContain(
      'git -C pr -c core.quotePath=false --attr-source="origin/$DEFAULT_BRANCH" diff \\\n' +
        "  --no-textconv --no-ext-diff --no-renames --numstat \\\n" +
        '  --merge-base "origin/$BASE_REF" "$HEAD_SHA" \\\n' +
        "  | awk '/^-\\t-\\t/ { print substr($0, 5) }' > inputs/binary-paths.txt",
    );
    expect(prep).not.toMatch(/--numstat -z|tr '\\0'/);
    expect(prep).toContain("cp inputs/pr.json inputs/binary-paths.txt pr/.review-input/");
    const prompt = readFileSync(path.join(ROOT, ".github/claude-review/prompt.md"), "utf8");
    expect(prompt).toContain("`.review-input/binary-paths.txt`");
    expect(prompt).toContain("file names (including those in `binary-paths.txt`)");
  });

  it("gives the model a line-numbered diff and keeps the raw diff, outside its reach, for posting", () => {
    const prep = stepNamed("Prepare review inputs").run ?? "";
    expect(prep).toContain(
      "node trusted/.github/claude-review/number-diff.mjs inputs/pr.diff > pr/.review-input/pr.diff",
    );
    // The raw diff stays in inputs/ (post.mjs maps lines against it); the
    // model's copy is the numbered one, never a copy of the raw file.
    expect(prep).not.toMatch(/cp [^\n]*inputs\/pr\.diff/);
    const prompt = readFileSync(path.join(ROOT, ".github/claude-review/prompt.md"), "utf8");
    expect(prompt).toContain("**line number in the new version of the file**");
    expect(prompt).toContain("**never** from a line's position within `pr.diff`");
  });

  it("keeps the step order the controls depend on", () => {
    const order = [
      "Re-check the PR",
      "Check out master's review config",
      "Check out the PR",
      "Neutralise the PR checkout",
      "Prepare review inputs",
      "Install Claude Code",
      "Mark review started",
      "Review",
      "Classify and scan for secrets",
      "Summarise tool use",
      "Post to the PR",
      LAST_STEP,
    ].map(indexOfName);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("posting", () => {
  it("classifies from the review step's outcome, never its conclusion, and builds what is posted", () => {
    const classify = step("classify");
    expect(classify.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
      REVIEW_OUTCOME: "${{ steps.review.outcome }}",
      RUN_ID: "${{ github.run_id }}",
      RUN_ATTEMPT: "${{ github.run_attempt }}",
    });
    expect(classify.if).toBe(STARTED);
    expect(JSON.stringify(wf)).not.toContain("steps.review.conclusion");
  });

  it("posts only after classify succeeded, with the GitHub token and not the OAuth token", () => {
    const post = stepNamed("Post to the PR");
    expect(post.if).toBe(`${STARTED} && steps.classify.outcome == 'success'`);
    expect(post.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    expect(post.run).toBe("node trusted/.github/claude-review/post.mjs inputs");
  });

  it("runs every script from master's checkout, never from the PR", () => {
    for (const s of steps) {
      for (const m of (s.run ?? "").matchAll(/node (\S+\.mjs)/g))
        expect(m[1], s.name).toMatch(/^trusted\/\.github\/claude-review\//);
    }
  });

  it("turns the job red on a withheld review or a review system that is down", () => {
    const last = steps[steps.length - 1];
    expect(last.name).toBe(LAST_STEP);
    expect(last.if).toBe(`${STARTED} && steps.classify.outcome == 'success'`);
    expect(last.run).toMatch(/if \[ "\$outcome" = "withheld" \]; then[\s\S]*?exit 1/);
    expect(last.run).toMatch(
      /if \[ "\$reason" = "api-error" \] \|\| \[ "\$reason" = "no-token" \]; then[\s\S]*?exit 1/,
    );
  });
});
