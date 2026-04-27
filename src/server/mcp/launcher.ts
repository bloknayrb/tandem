/**
 * Claude Code launcher — spawns Claude Code with the Tandem channel active.
 *
 * Called by `POST /api/launch-claude` when the user clicks "Launch Claude" in the browser.
 */

import { type ChildProcess, spawn } from "child_process";
import { DEFAULT_MCP_PORT } from "../../shared/constants.js";

let claudeProcess: ChildProcess | null = null;

const TANDEM_SYSTEM_PROMPT = [
  "You are Claude, connected to Tandem — a collaborative document editor.",
  "You will receive real-time push notifications via the tandem-channel when users",
  "create annotations, send chat messages, accept/dismiss your suggestions, or switch documents.",
  "Use your tandem MCP tools (tandem_getTextContent, tandem_comment, tandem_highlight,",
  "tandem_edit, etc.) to review and annotate documents.",
  "Start by calling tandem_checkInbox to see what needs attention.",
].join(" ");

export function launchClaude(): { status: string; pid?: number } {
  // Idempotency: don't spawn twice
  if (claudeProcess && !claudeProcess.killed) {
    return { status: "already_running", pid: claudeProcess.pid };
  }

  const claudeCmd = process.env.TANDEM_CLAUDE_CMD || "claude";
  const tandemUrl = `http://localhost:${process.env.TANDEM_MCP_PORT || DEFAULT_MCP_PORT}`;

  const args = [
    "--dangerously-load-development-channels",
    "server:tandem-channel",
    "--append-system-prompt",
    TANDEM_SYSTEM_PROMPT,
    "--name",
    "tandem-reviewer",
  ];

  claudeProcess = spawn(claudeCmd, args, {
    env: { ...process.env, TANDEM_URL: tandemUrl },
    stdio: "pipe",
    detached: true,
  });

  // Feed initial prompt via stdin
  if (claudeProcess.stdin?.writable) {
    claudeProcess.stdin.write(
      "A document has been opened in Tandem for review. " +
        "Call tandem_checkInbox to see what needs attention, then begin reviewing.\n",
      (err) => {
        if (err) console.error("[Launcher] Failed to send initial prompt:", err.message);
      },
    );
  } else {
    console.error("[Launcher] Claude process has no writable stdin — initial prompt not delivered");
  }

  const pid = claudeProcess.pid;

  claudeProcess.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.error(
        "[Launcher] Claude Code not found. Install with: npm i -g @anthropic-ai/claude-code",
      );
    } else {
      console.error("[Launcher] spawn error:", err);
    }
    claudeProcess = null;
  });

  claudeProcess.on("exit", (code) => {
    console.error(`[Launcher] Claude Code exited with code ${code}`);
    claudeProcess = null;
  });

  // Capture stderr for debugging
  claudeProcess.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[Claude] ${chunk.toString().trimEnd()}`);
  });

  claudeProcess.unref();

  console.error(`[Launcher] Claude Code launched (pid: ${pid})`);
  return { status: "launched", pid };
}

/** Kill the Claude Code process (called on server shutdown or doc close). */
export function killClaude(): void {
  if (claudeProcess && !claudeProcess.killed) {
    console.error(`[Launcher] Killing Claude Code (pid: ${claudeProcess.pid})`);
    try {
      claudeProcess.kill("SIGTERM");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        console.error("[Launcher] Failed to kill Claude process:", err);
      }
    }
    claudeProcess = null;
  }
}
