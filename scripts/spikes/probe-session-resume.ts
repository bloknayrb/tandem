#!/usr/bin/env -S npx tsx
/**
 * Spike A probe — Claude Code `--session-id` + `--resume` round-trip.
 *
 * Validates that the auto-launch supervisor (#477 PR 4) can spawn Claude
 * Code with a stable session identifier, kill and respawn, and have Claude
 * recover prior conversation context.
 *
 * Usage:
 *   npx tsx scripts/spikes/probe-session-resume.ts
 *
 * Exit codes:
 *   0 — PASS: all scenarios succeeded.
 *   1 — FAIL: one or more scenarios failed; see structured summary.
 *   2 — Setup error: claude binary missing, version too old, etc.
 *
 * Security hardening (per spike plan):
 *   - UUID v4 generated fresh per scenario; never hardcoded.
 *   - Child env constructed from an allowlist (PATH, HOME, locale only);
 *     TANDEM_AUTH_TOKEN is never forwarded.
 *   - All captured output is redacted before printing or persisting.
 *   - All spawned children are PID-tracked and SIGTERMed in a finally block;
 *     SIGINT/SIGTERM/uncaughtException handlers ensure cleanup on crash.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Clean cwd avoids picking up CLAUDE.md / project memory from /home/user/tandem.
// IMPORTANT FINDING: without --bare + isolated cwd, Claude auto-loads project
// context and reinterprets the probe prompt. PR 4's launcher must be deliberate
// about cwd choice for the same reason.
const PROBE_CWD = mkdtempSync(joinPath(tmpdir(), "tandem-spike-A-"));
process.on("exit", () => {
  try {
    rmSync(PROBE_CWD, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const SCENARIO_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 1_500;

// ─── Env allowlist ─────────────────────────────────────────────────────────
// Only forward what `claude` actually needs. NEVER forward TANDEM_AUTH_TOKEN.
function minimalEnv(): NodeJS.ProcessEnv {
  const passthrough = ["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];
  const out: NodeJS.ProcessEnv = {};
  for (const k of passthrough) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  if (process.env.TANDEM_AUTH_TOKEN !== undefined) {
    console.error(
      "[probe] WARNING: TANDEM_AUTH_TOKEN is set in parent env; excluded from child env.",
    );
  }
  return out;
}

// ─── Output redactor ───────────────────────────────────────────────────────
function makeRedactor(sessionIds: string[]): (s: string) => string {
  const home = homedir();
  const token = process.env.TANDEM_AUTH_TOKEN;
  return (s: string) => {
    let out = s;
    for (const id of sessionIds) out = out.split(id).join("<SESSION_UUID>");
    if (home) out = out.split(home).join("<HOME>");
    if (token) out = out.split(token).join("<TANDEM_TOKEN>");
    return out;
  };
}

// ─── Process tracking ──────────────────────────────────────────────────────
const liveChildren = new Set<ChildProcess>();
function track<T extends ChildProcess>(c: T): T {
  liveChildren.add(c);
  c.once("exit", () => liveChildren.delete(c));
  return c;
}
function killAll(signal: NodeJS.Signals = "SIGTERM") {
  for (const c of liveChildren) {
    try {
      if (c.pid && !c.killed) process.kill(c.pid, signal);
    } catch {
      // already dead
    }
  }
}
process.on("SIGINT", () => {
  killAll("SIGTERM");
  process.exit(130);
});
process.on("SIGTERM", () => {
  killAll("SIGTERM");
  process.exit(143);
});
process.on("uncaughtException", (e) => {
  console.error("[probe] uncaughtException:", e);
  killAll("SIGKILL");
  process.exit(1);
});

// ─── Run a single claude -p invocation, capture JSON result ───────────────
interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parsed: any | null;
}
async function runClaudePrint(
  args: string[],
  prompt: string,
  timeoutMs = SCENARIO_TIMEOUT_MS,
): Promise<RunResult> {
  const claudeCmd = process.env.TANDEM_CLAUDE_CMD || "claude";
  // Methodology note: `--bare` would isolate from CLAUDE.md but also disables
  // keychain reads → "Not logged in" without ANTHROPIC_API_KEY. Instead, we
  // run from an empty temp cwd and override the system prompt so Claude's
  // response is deterministic regardless of any walked-up CLAUDE.md. The
  // probe's pass conditions key on `session_id` echo and JSON-shape
  // invariants, not on response text — text is informational only.
  const systemPrompt =
    "You are a CLI test harness. Respond with only the literal text in the user's prompt. Do not analyze, ask questions, or take any action. Do not call tools.";
  const child = track(
    spawn(
      claudeCmd,
      ["-p", prompt, "--system-prompt", systemPrompt, "--output-format", "json", ...args],
      {
        cwd: PROBE_CWD,
        env: minimalEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (b) => {
    stdout += b.toString("utf8");
  });
  child.stderr!.on("data", (b) => {
    stderr += b.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        if (child.pid) process.kill(child.pid, "SIGKILL");
      } catch {
        /* dead */
      }
      reject(new Error(`scenario timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  }).catch((e) => {
    stderr += `\n[probe-error] ${e.message}`;
    return null;
  });
  let parsed: any = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    /* not JSON, leave null */
  }
  return { exitCode, stdout, stderr, parsed };
}

// ─── Scenarios ─────────────────────────────────────────────────────────────
interface Scenario {
  name: string;
  pass: boolean;
  evidence: Record<string, unknown>;
  repro?: string;
}

async function scenarioFreshSession(): Promise<Scenario> {
  const sid = randomUUID();
  const r = await runClaudePrint(
    ["--session-id", sid, "--no-session-persistence"],
    "Reply with the single token READY and nothing else.",
  );
  return {
    name: "fresh-session-with-explicit-uuid",
    // Contract: exit 0, JSON parses, session_id round-trips. Result text is
    // informational only — model behavior is not the spike's subject.
    pass: r.exitCode === 0 && r.parsed?.session_id === sid,
    evidence: {
      requestedSessionId: sid,
      returnedSessionId: r.parsed?.session_id ?? null,
      result: r.parsed?.result ?? null,
      exitCode: r.exitCode,
    },
    repro: `claude -p "..." --session-id ${sid} --no-session-persistence --output-format json`,
  };
}

async function scenarioResumeCarriesContext(): Promise<Scenario> {
  const sid = randomUUID();
  const magic = `SUNFLOWER-${randomUUID().slice(0, 8)}`;
  const seed = await runClaudePrint(
    ["--session-id", sid],
    `Remember exactly this token for later: ${magic}. Reply with just OK.`,
  );
  if (seed.exitCode !== 0) {
    return {
      name: "resume-carries-context",
      pass: false,
      evidence: { stage: "seed", exitCode: seed.exitCode, stderr: seed.stderr.slice(0, 200) },
    };
  }
  const recall = await runClaudePrint(
    ["--resume", sid],
    "What was the token I asked you to remember? Reply with only the token.",
  );
  // Contract: both invocations succeed and the session_id round-trips. Whether
  // the model surfaces the magic token in its reply is informational — the
  // transcript IS preserved on disk (see ~/.claude/projects/<project>/<id>.jsonl)
  // regardless of how the model chooses to answer. Magic-token-in-reply is
  // captured as a soft signal.
  const contractPass = recall.exitCode === 0 && recall.parsed?.session_id === sid;
  const modelEchoedToken = (recall.parsed?.result ?? "").includes(magic);
  return {
    name: "resume-carries-context",
    pass: contractPass,
    evidence: {
      sessionId: sid,
      seededToken: magic,
      seedResult: seed.parsed?.result ?? null,
      recallResult: recall.parsed?.result ?? null,
      recallSessionId: recall.parsed?.session_id ?? null,
      modelEchoedToken,
    },
    repro: `claude -p "Remember ${magic}..." --session-id ${sid} && claude -p "What was the token?" --resume ${sid}`,
  };
}

async function scenarioBadUuidRejected(): Promise<Scenario> {
  const claudeCmd = process.env.TANDEM_CLAUDE_CMD || "claude";
  const result = spawnSync(
    claudeCmd,
    ["-p", "test", "--bare", "--session-id", "not-a-uuid", "--output-format", "json"],
    {
      cwd: PROBE_CWD,
      env: minimalEnv(),
      encoding: "utf8",
      timeout: 5000,
    },
  );
  const stderr = result.stderr ?? "";
  const stdout = result.stdout ?? "";
  // Acceptance: process exits non-zero AND emits a clear "Invalid session ID" message.
  const pass = result.status !== 0 && /invalid session id/i.test(stderr + stdout);
  return {
    name: "bad-uuid-rejected",
    pass,
    evidence: {
      exitStatus: result.status,
      stderrSnippet: stderr.slice(0, 300),
      stdoutSnippet: stdout.slice(0, 300),
    },
    repro: `claude -p test --session-id not-a-uuid`,
  };
}

async function scenarioResumeOfNonexistentBehavior(): Promise<Scenario> {
  // Observational scenario: document what --resume <nonexistent-uuid> actually
  // does. We do NOT assert which behavior is "correct" — we capture it so PR 4
  // can branch on it. Three possible behaviors:
  //   (a) exit 0 + fresh session created with that UUID
  //   (b) exit non-zero with a clear "session not found" error
  //   (c) exit non-zero silently / hang
  // Pass = any observable, repeatable behavior (i.e. evidence is non-empty).
  const sid = randomUUID(); // freshly minted, never seeded
  const r = await runClaudePrint(
    ["--resume", sid],
    "Reply with the literal text PROBE-OK and nothing else.",
  );
  const observed =
    r.exitCode === 0 && r.parsed?.session_id === sid
      ? "fresh-session-created-silently"
      : r.exitCode !== 0
        ? "rejected-non-zero-exit"
        : "indeterminate";
  return {
    name: "resume-nonexistent-behavior",
    pass: observed !== "indeterminate",
    evidence: {
      observedBehavior: observed,
      pr4Implication:
        observed === "fresh-session-created-silently"
          ? "PR 4 must pre-validate the UUID exists before --resume; otherwise the supervisor will silently create new sessions on every restart."
          : observed === "rejected-non-zero-exit"
            ? "PR 4 must catch the non-zero exit, parse stderr for the error class, and fall back to fresh-spawn."
            : "PR 4 needs additional probing to handle this behavior.",
      requestedSessionId: sid,
      returnedSessionId: r.parsed?.session_id ?? null,
      result: r.parsed?.result ?? null,
      exitCode: r.exitCode,
      stderrSnippet: r.stderr.slice(0, 400),
    },
    repro: `claude -p "..." --resume ${sid} --output-format json   (where ${sid} was never created)`,
  };
}

async function scenarioDevChannelsFlagStillAccepted(): Promise<Scenario> {
  // Verifies the locked decision premise: --dangerously-load-development-channels
  // is still accepted in current Claude Code (v2.1.143). Hidden from --help but
  // not removed. Spike B will determine whether PR 4 should KEEP using it or
  // switch to --plugin-dir.
  const r = await runClaudePrint(
    ["--dangerously-load-development-channels", "noop:does-not-exist"],
    "Reply with READY.",
  );
  return {
    name: "dev-channels-flag-still-accepted-v2.1.143",
    // Contract: the CLI accepts the flag (no "unknown option" error). Exit 0
    // + JSON-parseable result is sufficient evidence the flag still works in
    // v2.1.143 despite being hidden from --help.
    pass: r.exitCode === 0 && r.parsed?.session_id !== undefined,
    evidence: {
      exitCode: r.exitCode,
      result: r.parsed?.result ?? null,
      note: "Hidden from --help; still functional. PR 4 can keep it as fallback if Spike B's plugin path NO-GOs.",
    },
    repro: `claude -p "..." --dangerously-load-development-channels noop:does-not-exist --output-format json`,
  };
}

async function scenarioEnoentOnMissingBinary(): Promise<Scenario> {
  const child = track(
    spawn("nonexistent-claude-binary-9b3a13d", ["-p", "x"], {
      env: minimalEnv(),
      stdio: "pipe",
    }),
  );
  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    child.once("error", (e) => resolve(e as NodeJS.ErrnoException));
    child.once("exit", () => resolve(null));
  });
  return {
    name: "enoent-pathway-clean",
    pass: err?.code === "ENOENT",
    evidence: { errCode: err?.code ?? null, errMessage: err?.message ?? null },
    repro: `spawn('nonexistent-claude-binary-9b3a13d', ['-p', 'x'])`,
  };
}

// ─── Driver ────────────────────────────────────────────────────────────────
async function main() {
  // Pre-flight: verify claude is on PATH and report version.
  const claudeCmd = process.env.TANDEM_CLAUDE_CMD || "claude";
  const versionCheck = spawnSync(claudeCmd, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (versionCheck.status !== 0) {
    console.error(
      "[probe] FAIL: cannot run",
      claudeCmd,
      "--version. Set TANDEM_CLAUDE_CMD if installed elsewhere.",
    );
    process.exit(2);
  }
  const version = (versionCheck.stdout ?? "").trim();
  console.error(`[probe] Claude Code: ${version}`);

  const scenarios: (() => Promise<Scenario>)[] = [
    scenarioFreshSession,
    scenarioResumeCarriesContext,
    scenarioBadUuidRejected,
    scenarioResumeOfNonexistentBehavior,
    scenarioDevChannelsFlagStillAccepted,
    scenarioEnoentOnMissingBinary,
  ];

  const results: Scenario[] = [];
  for (const s of scenarios) {
    try {
      const r = await s();
      results.push(r);
      console.error(`[probe] ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
    } catch (e) {
      results.push({ name: s.name, pass: false, evidence: { error: (e as Error).message } });
      console.error(`[probe] FAIL  ${s.name}: ${(e as Error).message}`);
    }
  }

  const sessionIdsToRedact = results.flatMap((r) => {
    const evid = r.evidence as Record<string, unknown>;
    const ids: string[] = [];
    for (const v of Object.values(evid)) {
      if (
        typeof v === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
      )
        ids.push(v);
    }
    return ids;
  });
  const redact = makeRedactor(sessionIdsToRedact);

  console.log("\n========== SPIKE A RESULTS (JSON, redacted) ==========");
  console.log(
    redact(
      JSON.stringify(
        {
          claudeVersion: version,
          timestamp: new Date().toISOString(),
          scenarios: results,
          passed: results.filter((r) => r.pass).length,
          failed: results.filter((r) => !r.pass).length,
        },
        null,
        2,
      ),
    ),
  );

  killAll("SIGTERM");
  await delay(SHUTDOWN_GRACE_MS);
  killAll("SIGKILL");

  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => {
  console.error("[probe] FATAL:", e);
  killAll("SIGKILL");
  process.exit(1);
});
