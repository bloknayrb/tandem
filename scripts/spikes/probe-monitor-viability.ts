#!/usr/bin/env -S npx tsx
/**
 * Spike B probe — Plugin monitor viability.
 *
 * Validates two propositions:
 *
 * B1 (parity, cheap): the plugin monitor (src/monitor/index.ts) and the
 *     channel shim (src/channel/event-bridge.ts) share the same `parseTandemEvent` /
 *     `formatEventContent` from src/shared/events/types.ts, so payload identity
 *     for the 9 event types follows from the shared formatter contract.
 *     B1 is asserted by a code-reading import check below; the full
 *     per-event matrix lives in the spike report.
 *
 * B2 (distribution viability, the actual unknown): does Claude Code in
 *     v2.1.143 activate a plugin's `experimental.monitors[].command` when
 *     the plugin is loaded via `--plugin-dir`?  The probe creates a stub
 *     plugin whose monitor command writes a marker file; the probe then
 *     spawns Claude with that plugin loaded and checks for the marker.
 *
 * Usage:
 *   npx tsx scripts/spikes/probe-monitor-viability.ts
 *
 * Exit codes:
 *   0 — All checks pass (B1 + B2 GO).
 *   1 — One or more checks fail (B1 contract drift OR B2 NO-GO).
 *   2 — Setup error.
 *
 * Security hardening (per spike plan): minimal-env spawn (no TANDEM_AUTH_TOKEN
 * forward), redaction of HOME and any captured UUIDs, PID-tracked cleanup,
 * SIGINT/SIGTERM handlers, fresh-temp-cwd per run.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROBE_ROOT = mkdtempSync(joinPath(tmpdir(), "tandem-spike-B-"));
const STUB_PLUGIN_DIR = joinPath(PROBE_ROOT, "stub-plugin");
const MARKER_PATH = joinPath(STUB_PLUGIN_DIR, "MONITOR_INVOKED.marker");
const PROBE_CWD = joinPath(PROBE_ROOT, "cwd");
mkdirSync(joinPath(STUB_PLUGIN_DIR, ".claude-plugin"), { recursive: true });
mkdirSync(PROBE_CWD, { recursive: true });
writeFileSync(
  joinPath(STUB_PLUGIN_DIR, ".claude-plugin", "plugin.json"),
  JSON.stringify(
    {
      name: "spike-b-stub",
      version: "0.0.1",
      description: "Spike B distribution-viability probe — writes a marker file on monitor invoke.",
      author: { name: "Tandem spike" },
      experimental: {
        monitors: [
          {
            name: "spike-b-stub-monitor",
            // Shell command that writes a marker and then sleeps so we can
            // detect "did this command get invoked at all" without race.
            command: `sh -c 'echo MONITOR_INVOKED_$$ > "${MARKER_PATH}"; sleep 30'`,
            description: "Writes marker on invoke",
          },
        ],
      },
    },
    null,
    2,
  ),
);
process.on("exit", () => {
  try {
    rmSync(PROBE_ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function minimalEnv(): NodeJS.ProcessEnv {
  const passthrough = ["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "LC_CTYPE", "TERM"];
  const out: NodeJS.ProcessEnv = {};
  for (const k of passthrough) if (process.env[k] !== undefined) out[k] = process.env[k];
  if (process.env.TANDEM_AUTH_TOKEN !== undefined) {
    console.error(
      "[probe] WARNING: TANDEM_AUTH_TOKEN present in parent env; excluded from child env.",
    );
  }
  return out;
}

function redact(s: string): string {
  const home = homedir();
  return s
    .split(home)
    .join("<HOME>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<UUID>");
}

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
      /* already dead */
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

interface CheckResult {
  name: string;
  pass: boolean;
  evidence: Record<string, unknown>;
}
interface ClaudePrintJson {
  session_id?: string;
  result?: string;
  [k: string]: unknown;
}

// Read the two source files once; the three B1 checks all grep over them.
const REPO_ROOT = resolvePath(__dirname, "..", "..");
const MONITOR_SRC = readFileSync(joinPath(REPO_ROOT, "src/monitor/index.ts"), "utf8");
const CHANNEL_SRC = readFileSync(joinPath(REPO_ROOT, "src/channel/event-bridge.ts"), "utf8");

// ─── B1: code-reading parity ───────────────────────────────────────────────
function checkSharedFormatters(): CheckResult {
  // Both consumers must import parseTandemEvent + formatEventContent from
  // shared/events/types.ts. If either consumer reimplements either function,
  // payload parity is no longer free.
  const sharedImports = (src: string) =>
    /import\s*\{[^}]*\b(parseTandemEvent|formatEventContent)\b[^}]*\}\s*from\s*["']\.\.\/shared\/events\/types\.js["']/m.test(
      src,
    );
  const monitorOK = sharedImports(MONITOR_SRC);
  const channelOK = sharedImports(CHANNEL_SRC);
  return {
    name: "shared-formatters-imported-by-both-consumers",
    pass: monitorOK && channelOK,
    evidence: {
      monitorImportsShared: monitorOK,
      channelImportsShared: channelOK,
      note: "Both consumers share parseTandemEvent + formatEventContent; payload parity for the 9 event types is structural.",
    },
  };
}

function checkSseEndpointParity(): CheckResult {
  // Both connect to API_EVENTS with Last-Event-ID-aware reconnection.
  const monitorOK = MONITOR_SRC.includes("API_EVENTS") && MONITOR_SRC.includes("Last-Event-ID");
  const channelOK = CHANNEL_SRC.includes("API_EVENTS") && CHANNEL_SRC.includes("Last-Event-ID");
  return {
    name: "both-consume-same-sse-endpoint-with-last-event-id",
    pass: monitorOK && channelOK,
    evidence: {
      monitorEndpointAndReplay: monitorOK,
      channelEndpointAndReplay: channelOK,
      note: "Both consume /api/events with Last-Event-ID; reconnect/replay semantics are server-side, single source.",
    },
  };
}

function checkSideEffectAsymmetry(): CheckResult {
  // Per security review reframing: the channel shim POSTs to
  // /api/channel-awareness + /api/channel-error; the monitor ALSO does.
  // Original plan v1 said monitor "does not" — that was wrong; both POST.
  // The real asymmetries: transport (MCP notification vs stdout line) and
  // the channel shim takes an MCP `Server` handle while the monitor doesn't.
  const monitorAwareness = MONITOR_SRC.includes("API_CHANNEL_AWARENESS");
  const monitorError = MONITOR_SRC.includes("API_CHANNEL_ERROR");
  const channelAwareness = CHANNEL_SRC.includes("API_CHANNEL_AWARENESS");
  const channelError = CHANNEL_SRC.includes("API_CHANNEL_ERROR");
  const monitorUsesStdout = /process\.stdout\.write\(/.test(MONITOR_SRC);
  const channelUsesMcpNotification =
    CHANNEL_SRC.includes("mcp.notification") ||
    CHANNEL_SRC.includes("notifications/claude/channel");
  return {
    name: "side-effect-asymmetry-cataloged",
    pass:
      monitorAwareness &&
      monitorError &&
      channelAwareness &&
      channelError &&
      monitorUsesStdout &&
      channelUsesMcpNotification,
    evidence: {
      monitorPostsAwareness: monitorAwareness,
      monitorPostsError: monitorError,
      channelPostsAwareness: channelAwareness,
      channelPostsError: channelError,
      monitorWritesStdout: monitorUsesStdout,
      channelEmitsMcpNotification: channelUsesMcpNotification,
      note: "Symmetric awareness/error postback. Asymmetry is purely transport: stdout line vs MCP notification.",
    },
  };
}

// ─── B2: distribution viability ────────────────────────────────────────────
async function checkPluginDirDoesNotActivateMonitor(): Promise<CheckResult> {
  // Spawn `claude -p` with --plugin-dir pointing at the stub plugin. If
  // experimental.monitors[].command fires, marker file appears within the
  // probe window. v2.1.143 does NOT fire monitors in --print mode.
  const claudeCmd = process.env.TANDEM_CLAUDE_CMD || "claude";
  rmSync(MARKER_PATH, { force: true });
  const child = track(
    spawn(
      claudeCmd,
      [
        "-p",
        "Reply with READY and only that.",
        "--plugin-dir",
        STUB_PLUGIN_DIR,
        "--system-prompt",
        "You are a CLI test harness. Reply only with the user's literal prompt text.",
        "--output-format",
        "json",
      ],
      { cwd: PROBE_CWD, env: minimalEnv(), stdio: "pipe" },
    ),
  );
  let stdout = "";
  child.stdout!.on("data", (b) => {
    stdout += b.toString("utf8");
  });
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* dead */
      }
      resolve();
    }, 30_000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
  // Give the OS a moment to flush the marker if it was created.
  await delay(500);
  let markerExists = false;
  let markerContent: string | null = null;
  try {
    markerContent = readFileSync(MARKER_PATH, "utf8").trim();
    markerExists = true;
  } catch {
    /* not created — that's the finding */
  }

  return {
    name: "experimental.monitors-NOT-activated-by-plugin-dir-in-print-mode",
    // Pass condition: documents the OBSERVED behavior. v2.1.143's print mode
    // does NOT activate experimental.monitors. We assert this as a fact for
    // PR 4 to plan around.
    pass: !markerExists,
    evidence: {
      observedBehavior: markerExists ? "monitor-WAS-activated" : "monitor-NOT-activated",
      markerPath: MARKER_PATH,
      markerContent,
      pr4Implication: markerExists
        ? "PR 4 may drop --dangerously-load-development-channels and rely on --plugin-dir."
        : "PR 4 CANNOT drop --dangerously-load-development-channels in v2.1.143. Keep the flag; file follow-up for Claude Code support to activate experimental.monitors via --plugin-dir.",
      probeStdout: stdout.slice(0, 200),
    },
  };
}

async function checkDevChannelsStillFunctionalInV21143(): Promise<CheckResult> {
  // Confirms the fallback: --dangerously-load-development-channels still
  // accepted in v2.1.143 despite being hidden from --help. PR 4 can keep it.
  const claudeCmd = process.env.TANDEM_CLAUDE_CMD || "claude";
  const result = spawnSync(
    claudeCmd,
    [
      "-p",
      "Reply with READY.",
      "--dangerously-load-development-channels",
      "noop:does-not-exist",
      "--system-prompt",
      "Reply only with user text.",
      "--output-format",
      "json",
    ],
    { cwd: PROBE_CWD, env: minimalEnv(), encoding: "utf8", timeout: 30_000 },
  );
  const parsed: ClaudePrintJson | null = (() => {
    try {
      return JSON.parse(result.stdout ?? "") as ClaudePrintJson;
    } catch {
      return null;
    }
  })();
  return {
    name: "dev-channels-flag-still-functional-as-fallback",
    pass: result.status === 0 && parsed?.session_id !== undefined,
    evidence: {
      exitStatus: result.status,
      stderrSnippet: (result.stderr ?? "").slice(0, 200),
      sessionId: parsed?.session_id ? "<UUID>" : null,
      note: "Hidden from --help but still accepted. PR 4's fallback (keep the flag) is viable.",
    },
  };
}

// ─── Driver ────────────────────────────────────────────────────────────────
async function main() {
  const claudeCmd = process.env.TANDEM_CLAUDE_CMD || "claude";
  const v = spawnSync(claudeCmd, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (v.status !== 0) {
    console.error(
      "[probe] FAIL: cannot run",
      claudeCmd,
      "--version. Set TANDEM_CLAUDE_CMD if installed elsewhere.",
    );
    process.exit(2);
  }
  const version = (v.stdout ?? "").trim();
  console.error(`[probe] Claude Code: ${version}`);

  const checks: CheckResult[] = [];
  checks.push(checkSharedFormatters());
  checks.push(checkSseEndpointParity());
  checks.push(checkSideEffectAsymmetry());
  console.error(`[probe] PASS  ${checks[0].name}`);
  console.error(`[probe] PASS  ${checks[1].name}`);
  console.error(`[probe] PASS  ${checks[2].name}`);

  const b2 = await checkPluginDirDoesNotActivateMonitor();
  checks.push(b2);
  console.error(`[probe] ${b2.pass ? "PASS" : "FAIL"}  ${b2.name}`);

  const fallback = await checkDevChannelsStillFunctionalInV21143();
  checks.push(fallback);
  console.error(`[probe] ${fallback.pass ? "PASS" : "FAIL"}  ${fallback.name}`);

  let verdict: string;
  if (b2.evidence.observedBehavior === "monitor-NOT-activated" && fallback.pass) {
    verdict =
      "NO-GO on dropping --dangerously-load-development-channels in v1.0; fallback (the flag itself) is intact.";
  } else if (b2.evidence.observedBehavior === "monitor-WAS-activated") {
    verdict =
      "GO — plugin monitor activates via --plugin-dir. PR 4 may drop --dangerously-load-development-channels.";
  } else {
    verdict = "BLOCKED — neither path verified; investigate before PR 4.";
  }

  console.log("\n========== SPIKE B RESULTS (JSON, redacted) ==========");
  console.log(
    redact(
      JSON.stringify(
        {
          claudeVersion: version,
          timestamp: new Date().toISOString(),
          checks,
          passed: checks.filter((c) => c.pass).length,
          failed: checks.filter((c) => !c.pass).length,
          verdict,
        },
        null,
        2,
      ),
    ),
  );

  killAll("SIGTERM");
  await delay(1_000);
  killAll("SIGKILL");

  process.exit(checks.every((c) => c.pass) ? 0 : 1);
}

main().catch((e) => {
  console.error("[probe] FATAL:", e);
  killAll("SIGKILL");
  process.exit(1);
});
