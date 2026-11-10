import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The hooks under `.claude/hooks/` that can stop a tool call, run for real.
 *
 * On a `PreToolUse` exit 2, Claude Code shows the model the hook's STDERR and
 * nothing else. `block-no-verify.sh` and `block-sensitive.sh` used to `echo`
 * their reason to stdout, so the call was refused and the model was told
 * nothing: it could not tell a blocked flag from a broken hook, or learn that a
 * commit message which only mentions the flag is blocked too. So every block
 * here is asserted on stderr, and on stdout being empty.
 *
 * A block that names no way out is the other half of the same problem, so each
 * spec also pins that the message says what to do next. The wording itself is
 * not pinned beyond the one phrase that carries the remedy.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const HOOKS = path.join(ROOT, ".claude", "hooks");

/** The flag, assembled so this file can be named in a command that the hook reads. */
const SKIP_FLAG = ["--no", "verify"].join("-");

type Run = { status: number | null; stdout: string; stderr: string };

function runBashHook(script: string, event: unknown, env: Record<string, string> = {}): Run {
  const run = spawnSync("bash", [path.join(HOOKS, script)], {
    cwd: ROOT,
    input: JSON.stringify(event),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  expect(run.error, `could not spawn bash: ${run.error?.message}`).toBeUndefined();
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const bashEvent = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const editEvent = (file_path: string) => ({ tool_name: "Edit", tool_input: { file_path } });

// The `.sh` hooks are bash and CI's `check` job is ubuntu-only; a Windows dev
// box may resolve `bash` to WSL, which cannot see these paths. Same convention
// as workflow-state-hook.test.ts. The `.mjs` gate below runs everywhere.
const bashOnly = it.skipIf(process.platform === "win32");

describe("block-no-verify.sh", () => {
  bashOnly("blocks the flag and gives its reason on stderr", () => {
    const run = runBashHook("block-no-verify.sh", bashEvent(`git commit ${SKIP_FLAG} -m x`));
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(SKIP_FLAG);
    expect(run.stderr).toContain("block-no-verify.sh");
  });

  bashOnly("still blocks a command that only mentions the flag, and says how to proceed", () => {
    const run = runBashHook(
      "block-no-verify.sh",
      bashEvent(`gh pr create --body 'never use ${SKIP_FLAG}'`),
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("--body-file");
    expect(run.stderr).toContain("git commit -F");
  });

  bashOnly("allows a command without the flag, silently", () => {
    const run = runBashHook("block-no-verify.sh", bashEvent("git status"));
    expect(run).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  bashOnly("fails closed on unreadable input, and says so on stderr", () => {
    const run = spawnSync("bash", [path.join(HOOKS, "block-no-verify.sh")], {
      cwd: ROOT,
      input: "not json",
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("fail-closed");
  });
});

describe("block-sensitive.sh", () => {
  bashOnly("blocks package-lock.json and names the regenerate command on stderr", () => {
    const run = runBashHook("block-sensitive.sh", editEvent("/repo/package-lock.json"));
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("npm install --package-lock-only");
  });

  bashOnly("blocks .env and sends the change to the user", () => {
    const run = runBashHook("block-sensitive.sh", editEvent("/repo/.env"));
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Ask the user");
    expect(run.stderr).not.toContain("npm install");
  });

  bashOnly("allows the suffixes it documents as passing", () => {
    for (const file of ["/repo/.env.local", "/repo/.env.example", "/repo/src-tauri/Cargo.lock"]) {
      expect(runBashHook("block-sensitive.sh", editEvent(file)), file).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
    }
  });
});

describe("check-token-violation.sh worktree guard", () => {
  // The scanner always writes to stderr when it runs ("clean", a violation
  // list, or a failure notice for a file that does not exist). So an EMPTY
  // stderr is what shows the guard returned before the scanner started. None
  // of these files exist; nothing here depends on their content.
  const project = "/home/dev/tandem";

  bashOnly("skips a file in a nested worktree", () => {
    const run = runBashHook(
      "check-token-violation.sh",
      editEvent(`${project}/.claude/worktrees/agent-1/src/client/svelte-harness/Harness.svelte`),
      { CLAUDE_PROJECT_DIR: project },
    );
    expect(run).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  bashOnly("skips a file in a sibling worktree, outside the project directory", () => {
    const run = runBashHook(
      "check-token-violation.sh",
      editEvent("/home/dev/tandem-fix-x/src/client/svelte-harness/Harness.svelte"),
      { CLAUDE_PROJECT_DIR: project },
    );
    expect(run).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  bashOnly("skips a sibling worktree given as a Windows drive path, whatever its case", () => {
    const run = runBashHook(
      "check-token-violation.sh",
      editEvent("C:\\dev\\tandem-fix-x\\src\\client\\svelte-harness\\Harness.svelte"),
      { CLAUDE_PROJECT_DIR: "c:\\dev\\tandem" },
    );
    expect(run).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  bashOnly("does not skip a drive path inside the project when only the case differs", () => {
    const run = runBashHook(
      "check-token-violation.sh",
      editEvent("C:\\Dev\\Tandem\\src\\client\\does-not-exist.ts"),
      { CLAUDE_PROJECT_DIR: "c:\\dev\\tandem" },
    );
    expect(run.stderr, "the guard returned before the scanner ran").not.toBe("");
  });

  bashOnly("still runs the scanner for a file inside the project", () => {
    const run = runBashHook(
      "check-token-violation.sh",
      editEvent(`${ROOT}/src/client/does-not-exist.ts`),
      { CLAUDE_PROJECT_DIR: ROOT },
    );
    expect(run.stderr, "the guard returned before the scanner ran").not.toBe("");
  });
});

describe("block-plan-without-agent-review.mjs", () => {
  let home: string;
  let planFile: string;

  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "tandem-plan-gate-"));
    const plans = path.join(home, ".claude", "plans");
    mkdirSync(plans, { recursive: true });
    planFile = path.join(plans, "plan.md");
    writeFileSync(planFile, "# Plan\n");
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const toolUse = (name: string, input: Record<string, unknown> = {}) =>
    `${JSON.stringify({ message: { content: [{ type: "tool_use", name, input }] } })}\n`;
  const planWrite = () => toolUse("Write", { file_path: planFile });
  const review = () => toolUse("Agent", { prompt: "review the plan" });

  function runGate(name: string, transcript: string): Run {
    const transcriptPath = path.join(home, `${name}.jsonl`);
    writeFileSync(transcriptPath, transcript);
    const run = spawnSync(
      process.execPath,
      [path.join(HOOKS, "block-plan-without-agent-review.mjs")],
      {
        input: JSON.stringify({ transcript_path: transcriptPath }),
        encoding: "utf8",
        // `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows.
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );
    expect(run.error, `could not spawn node: ${run.error?.message}`).toBeUndefined();
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  it("allows when an Agent ran after the last plan write", () => {
    const run = runGate("reviewed", planWrite() + review());
    expect(run.status, run.stderr).toBe(0);
  });

  it("blocks an unreviewed plan and lists both ways to unblock", () => {
    const run = runGate("unreviewed", review() + planWrite());
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Unblock via EITHER");
  });

  it("blocks when no plan file was written, and says how to unblock", () => {
    const run = runGate("no-plan", toolUse("Bash", { command: "ls" }) + review());
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("To unblock");
    expect(run.stderr).toContain("call ExitPlanMode again");
  });

  describe("a transcript over the 50 MB cap is scanned from its tail", () => {
    // 51 lines of 1 MiB: more than the cap, so everything written before the
    // padding is outside the scanned tail and everything after is inside it.
    const padding = `${JSON.stringify({ message: { content: "x".repeat(1024 * 1024) } })}\n`.repeat(
      51,
    );

    it("allows a plan written and reviewed inside the tail", () => {
      const run = runGate("big-reviewed", padding + planWrite() + review());
      expect(run.status, run.stderr).toBe(0);
    });

    it("blocks an unreviewed plan in the tail even when an older revision was reviewed", () => {
      // The case a tail scan must not get wrong: the review belongs to the
      // revision before the padding, not to the one being approved.
      const run = runGate("big-stale-review", planWrite() + review() + padding + planWrite());
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("Unblock via EITHER");
    });

    it("blocks when the plan write is outside the tail, and says the scan was partial", () => {
      const run = runGate("big-old-plan", planWrite() + review() + padding);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("only the tail is scanned");
      expect(run.stderr).toContain("To unblock");
    });

    it("does not count a review in the tail for a plan write outside it", () => {
      const run = runGate("big-split", planWrite() + padding + review());
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("To unblock");
    });
  });
});
