import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A hook that exits 0 is heard by the model only through stdout JSON
 * (`hookSpecificOutput.additionalContext`). Its stderr goes to the user's
 * transcript view, so a nudge written there reached nobody who could act on it,
 * while ADR-058 leaned on these nudges. Every `nudge-*.sh` now goes through
 * `_ws_emit_context` (`.claude/hooks/_workflow-state.sh`), which builds the
 * JSON with jq, then node, and falls back to stderr only when neither runs.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const HOOKS = path.join(ROOT, ".claude", "hooks");
const NUDGES = readdirSync(HOOKS).filter((f) => /^nudge-.*\.sh$/.test(f));

type HookOut = { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };

function context(stdout: string, event: string): string {
  if (stdout.trim() === "") return "";
  const lines = stdout.trim().split("\n");
  expect(lines, "one JSON object per run: two are not valid hook output").toHaveLength(1);
  const out = JSON.parse(lines[0]) as HookOut;
  expect(out.hookSpecificOutput?.hookEventName).toBe(event);
  return out.hookSpecificOutput?.additionalContext ?? "";
}

describe("nudge hooks speak to the model, not only to stderr", () => {
  it("finds the nudges", () => {
    expect(NUDGES.sort()).toEqual(
      expect.arrayContaining([
        "nudge-plan-review.sh",
        "nudge-pr-review.sh",
        "nudge-simplify-before-commit.sh",
      ]),
    );
  });

  it.each(NUDGES)("%s emits through _ws_emit_context and never writes stderr itself", (f) => {
    const src = readFileSync(path.join(HOOKS, f), "utf8");
    expect(src).toContain("_ws_emit_context");
    expect(src, "a nudge on stderr is invisible to the model on exit 0").not.toMatch(/>&2/);
  });
});

describe.skipIf(process.platform === "win32")("nudge hooks at run time", () => {
  const runHook = (hook: string, input: object, env: NodeJS.ProcessEnv = process.env) =>
    spawnSync("bash", [path.join(".claude", "hooks", hook)], {
      cwd: ROOT,
      encoding: "utf8",
      env,
      input: JSON.stringify(input),
    });
  const withState = (label: string, fn: (session: string, dir: string) => void) => {
    const session = `vitest-nudge-${label}-${process.pid}`;
    const dir = path.join(ROOT, ".claude", ".workflow-state", session);
    mkdirSync(dir, { recursive: true });
    try {
      fn(session, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("simplify: once per edit, as PreToolUse context", () => {
    withState("simplify", (session, dir) => {
      writeFileSync(path.join(dir, "last-source-edit"), "");
      const input = {
        session_id: session,
        tool_name: "Bash",
        tool_input: { command: "git commit -m x" },
      };
      const first = runHook("nudge-simplify-before-commit.sh", input);
      expect(first.status).toBe(0);
      expect(first.stderr).toBe("");
      expect(context(first.stdout, "PreToolUse")).toContain("/simplify");
      const again = runHook("nudge-simplify-before-commit.sh", input);
      expect(context(again.stdout, "PreToolUse"), "one-shot").toBe("");
    });
  });

  it("pr-review: after a successful gh pr create, as PostToolUse context", () => {
    const run = runHook("nudge-pr-review.sh", {
      session_id: `vitest-nudge-pr-${process.pid}`,
      tool_name: "Bash",
      tool_input: { command: "gh pr create --fill" },
      tool_response: { exit_code: 0 },
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(context(run.stdout, "PostToolUse")).toContain("/pr-review-toolkit:review-pr");
  });

  it("plan-review: a plan with no Agent call since, as PreToolUse context", () => {
    withState("plan", (session, dir) => {
      writeFileSync(path.join(dir, "last-plan-write"), "/root/.claude/plans/p.md\n");
      const run = runHook("nudge-plan-review.sh", {
        session_id: session,
        tool_name: "Edit",
        tool_input: { file_path: path.join(ROOT, "src", "server", "index.ts") },
      });
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(context(run.stdout, "PreToolUse")).toContain("dispatch adversarial agents");
    });
  });

  it("the emitter falls back to node when jq fails, and still prints one object", () => {
    const bin = mkdtempSync(path.join(os.tmpdir(), "nudge-bin-"));
    try {
      writeFileSync(path.join(bin, "jq"), "#!/bin/sh\nexit 1\n");
      chmodSync(path.join(bin, "jq"), 0o755);
      const run = spawnSync(
        "bash",
        [
          "-c",
          'source .claude/hooks/_workflow-state.sh; _ws_emit_context Stop "a \\"quoted\\" line"',
        ],
        {
          cwd: ROOT,
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        },
      );
      expect(run.stderr).toBe("");
      expect(context(run.stdout, "Stop")).toBe('a "quoted" line');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("an empty message emits nothing", () => {
    const run = spawnSync(
      "bash",
      ["-c", 'source .claude/hooks/_workflow-state.sh; _ws_emit_context PreToolUse ""'],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});
