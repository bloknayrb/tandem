/**
 * Claude Code supervisor — spawns Claude as a child of Tandem and guarantees
 * OS-level reaping when Tandem dies (via the tandem-reaper helper binary).
 *
 * Gating: HTTP mode only. Requires a `claude-code` integration with
 * `apply !== "skip"` in `integrations.json`. Otherwise no-op.
 *
 * Lifecycle:
 *   start() — read integration, spawn reaper(claude). Backoff on crash.
 *   relaunch(cwd) — stop + respawn with a new cwd (used by /relaunch-here).
 *   stop() — SIGTERM the reaper; reaper forwards to Claude with 5s SIGKILL escalation.
 *
 * Session persistence: stores the last session ID in
 * `<appDataDir>/launcher-session.json`. On startup, attempts `--resume <id>`;
 * on non-zero exit within the resume window, falls back to a fresh
 * `--session-id <uuid>` spawn.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ClaudeCodeIntegration } from "../../shared/integrations/contract.js";
import {
  CLAUDE_STREAM_JSON_FLAGS,
  type LauncherErrorCode,
  REAPER_NOT_FOUND_MARKER,
  SUPERVISOR_INITIAL_PROMPT,
  serializeUserTurn,
} from "../../shared/launcher/contract.js";
import { createIntegrationsStore } from "../integrations/storage.js";

interface SupervisorOpts {
  /** Directory containing `integrations.json` (typically `resolveAppDataDir()`). */
  integrationsBase: string;
}

interface SpawnPlan {
  integration: ClaudeCodeIntegration;
  cwd: string;
  sessionId: string;
  resuming: boolean;
}

const SESSION_FILE_NAME = "launcher-session.json";
/** How long a resumed spawn must run before its session is considered
 * confirmed successful. If it exits non-zero before this threshold, the saved
 * session is cleared so the next spawn starts fresh. Must be strictly greater
 * than the longest observed `claude --resume <id>` probe time (~6 s on a slow
 * machine) — the old 5 s grace window was shorter than that probe, causing
 * the stale session to never be cleared (issue #1169). */
export const RESUME_CONFIRM_MS = 30_000;
const RESTART_BACKOFFS_MS = [1_000, 5_000, 30_000];
/** Circuit breaker: if Claude crashes this many times within
 * CIRCUIT_BREAKER_WINDOW_MS, the supervisor gives up and surfaces via status.
 * Avoids unbounded restart-loop spam from a permanently-broken Claude binary. */
const CIRCUIT_BREAKER_MAX_ATTEMPTS = 10;
const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60_000;
/** RFC-4122 v4-shape UUID, accepted for `--session-id` / `--resume`.
 * Defense-in-depth: even though `launcher-session.json` is mode 0o600,
 * an attacker-controlled value flowing into `--resume` could hijack
 * Claude's loaded conversation state. Reject anything not UUID-shaped. */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Supervisor {
  start(): Promise<void>;
  /** Respawn Claude with a new cwd. Loses conversation context. */
  relaunch(newCwd: string): Promise<void>;
  /** Idempotent — safe to call when not running. */
  stop(): Promise<void>;
  /** Drop any persisted session and respawn fresh.
   * If `cwdOverride` is provided, the spawn uses that cwd (and the integration's
   * persisted workingDirectory is left untouched). Otherwise uses the integration's
   * setting. Single atomic stop+clear+spawn under the supervisor lock. */
  startFresh(cwdOverride?: string): Promise<void>;
  /** Current state for /api/launcher/status. */
  status(): SupervisorStatus;
}

/** Discriminated union: when `running === false` the only extra field is the
 * (optional) `lastError`; when `running === true` all process-level fields are
 * guaranteed present.
 *
 * `lastError` is deliberately absent from the `running: true` branch, and that
 * omission is only sound because `spawnOnce()` *clears* `lastError` once a
 * spawn actually starts. Without the clear, an error from a previous failed
 * spawn would sit in the closure invisibly for the whole run and then
 * resurface — attributed to nothing — the moment the user cleanly stopped a
 * perfectly healthy supervisor. The explicit `lastError?: undefined` below
 * encodes that invariant instead of leaving it to the reader. */
export type SupervisorStatus =
  | { running: false; lastError?: LauncherErrorCode }
  | {
      running: true;
      /** PID of the reaper process. Claude's own PID is intentionally not
       * exposed — the reaper is the lifecycle owner. */
      reaperPid: number;
      cwd: string;
      sessionId: string;
      resuming: boolean;
      /** Never set: a running supervisor has, by construction, no pending
       * fatal error. Present as an explicit `undefined` so `status.lastError`
       * type-checks on the un-narrowed union. */
      lastError?: undefined;
    };

/**
 * Pure decision: should the saved session be cleared after a spawn exits?
 * Exported for unit testing — all three parameters must be satisfied:
 *   - we were attempting a resume (`resuming`)
 *   - the process exited with an error code (not a signal kill — code is null on SIGTERM)
 *   - the spawn never ran long enough to be considered successfully resumed
 */
export function shouldClearSession(opts: {
  resuming: boolean;
  code: number | null;
  resumeConfirmed: boolean;
}): boolean {
  return opts.resuming && opts.code !== null && opts.code !== 0 && !opts.resumeConfirmed;
}

/**
 * Full argument vector handed to the `claude` binary, in order.
 *
 * Module-scope and exported (mirroring `resolveSafeCwd` below) so the wire
 * shape can be asserted without spawning anything: this vector IS the
 * launcher's half of the CLI contract, and #1267 changed it with no coverage.
 * Takes only the two fields it reads so callers/tests don't have to construct
 * a whole `SpawnPlan`.
 */
export function buildClaudeArgs(plan: { sessionId: string; resuming: boolean }): string[] {
  const args = [...CLAUDE_STREAM_JSON_FLAGS];
  // --resume replays an existing conversation; --session-id names a new one.
  // Passing both is an error, so this is strictly either/or.
  if (plan.resuming) {
    args.push("--resume", plan.sessionId);
  } else {
    args.push("--session-id", plan.sessionId);
  }
  return args;
}

/**
 * Newline framer for a child's stdout/stderr.
 *
 * `data` events carry arbitrary byte-range chunks, not lines: a single
 * stream-json object routinely arrives split across two events, and two small
 * objects routinely arrive glued into one. Parsing a raw chunk therefore
 * fails, unpredictably, under exactly the load that matters.
 *
 * Callers MUST feed this pre-decoded strings (`stream.setEncoding("utf8")`),
 * never `chunk.toString()` — a multi-byte character straddling a chunk
 * boundary is corrupted by per-chunk decoding, and the corruption survives
 * reassembly here.
 *
 * `flush()` emits any trailing partial line, for the case where the stream
 * ends without a final newline. Exported for unit testing.
 */
export function createLineFramer(onLine: (line: string) => void): {
  push(text: string): void;
  flush(): void;
} {
  let buffer = "";
  return {
    push(text: string): void {
      buffer += text;
      const parts = buffer.split("\n");
      // The last element is either "" (chunk ended on a newline) or a partial
      // line still awaiting its terminator — carry it to the next push.
      buffer = parts.pop() ?? "";
      for (const line of parts) onLine(line);
    },
    flush(): void {
      const rest = buffer;
      buffer = "";
      if (rest) onLine(rest);
    },
  };
}

export function createSupervisor(opts: SupervisorOpts): Supervisor {
  let child: ChildProcess | null = null;
  let currentCwd: string | undefined;
  let currentSessionId: string | undefined;
  let currentResuming = false;
  let stopRequested = false;
  let restartIndex = 0;
  let restartTimer: NodeJS.Timeout | null = null;
  /** Confirmation timer for the active spawn. Set in spawnOnce, cancelled in
   * stopInternal and the exit handler. Module-scoped so stopInternal can
   * cancel it if the user-stops the process before it confirms. */
  let confirmTimer: NodeJS.Timeout | null = null;
  /** Circuit-breaker timestamps of recent restart attempts. */
  let recentAttempts: number[] = [];
  /** True once the breaker has tripped — supervisor refuses further restarts. */
  let breakerTripped = false;
  /** Serializes start / stop / relaunch so concurrent callers don't race the
   * child handle. Each public method takes this lock; reentrant calls within
   * the same task chain (e.g. relaunch → stop → spawn) sequence naturally
   * because relaunch awaits stop before chaining. */
  let opLock: Promise<void> = Promise.resolve();
  /** Last fatal error message — surfaced via status() when running=false. */
  let lastError: LauncherErrorCode | undefined;
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = opLock.then(fn, fn);
    opLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function readIntegration(): Promise<ClaudeCodeIntegration | null> {
    const store = createIntegrationsStore(opts.integrationsBase);
    const file = await store.read();
    const found = file.integrations.find(
      (i): i is ClaudeCodeIntegration => i.kind === "claude-code" && i.apply !== "skip",
    );
    return found ?? null;
  }

  function sessionFilePath(): string {
    return path.join(opts.integrationsBase, SESSION_FILE_NAME);
  }

  function readSavedSession(): string | undefined {
    try {
      const raw = fs.readFileSync(sessionFilePath(), "utf8");
      const parsed = JSON.parse(raw) as { sessionId?: unknown };
      if (typeof parsed.sessionId !== "string") return undefined;
      // UUID-shape gate: anything else is either corruption or tampering.
      if (!UUID_V4_PATTERN.test(parsed.sessionId)) {
        console.error("[Launcher] launcher-session.json sessionId is not UUID-shaped — ignoring");
        return undefined;
      }
      return parsed.sessionId;
    } catch {
      return undefined;
    }
  }

  function writeSavedSession(sessionId: string): void {
    try {
      fs.writeFileSync(sessionFilePath(), JSON.stringify({ sessionId }, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch (err) {
      console.error("[Launcher] Failed to persist session id:", err);
    }
  }

  function clearSavedSession(): void {
    try {
      fs.unlinkSync(sessionFilePath());
    } catch {
      // best-effort
    }
  }

  function resolveCwd(integration: ClaudeCodeIntegration, override?: string): string {
    const candidate = override ?? (integration as { workingDirectory?: unknown }).workingDirectory;
    if (typeof candidate === "string") {
      const normalized = safeCwd(candidate);
      if (normalized) return normalized;
    }
    return os.homedir();
  }

  function safeCwd(candidate: string): string | null {
    return resolveSafeCwd(candidate);
  }

  function reaperPath(): string {
    const exeName = process.platform === "win32" ? "tandem-reaper.exe" : "tandem-reaper";
    // TANDEM_REAPER_PATH is honored only in dev/test runtimes — both
    // NODE_ENV !== "production" AND not a Tauri sidecar build. Belt-and-suspenders
    // against a malicious shell rc redirecting the reaper inside a packaged sidecar
    // where NODE_ENV may not always be set to "production".
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.TANDEM_TAURI_SIDECAR !== "1" &&
      process.env.TANDEM_REAPER_PATH &&
      fs.existsSync(process.env.TANDEM_REAPER_PATH)
    ) {
      return process.env.TANDEM_REAPER_PATH;
    }
    // 1. Same directory as the running Node binary (npm install layout).
    const adjacent = path.join(path.dirname(process.execPath), exeName);
    if (fs.existsSync(adjacent)) return adjacent;
    // 2. Tauri sidecar layout (resourceDir/binaries/).
    if (process.env.TANDEM_TAURI_SIDECAR) {
      const tauriBin = path.join(path.dirname(process.execPath), "binaries", exeName);
      if (fs.existsSync(tauriBin)) return tauriBin;
    }
    // 3. Dev: top-level reaper crate output.
    const devPath = path.resolve(process.cwd(), "reaper", "target", "release", exeName);
    if (fs.existsSync(devPath) && process.env.NODE_ENV !== "production") return devPath;
    throw new Error(`${REAPER_NOT_FOUND_MARKER} (checked ${adjacent})`);
  }

  // TANDEM_CLAUDE_CMD honors PATH search via spawn. Security boundary is
  // "user controls their own PATH" — same as running `claude` in any terminal.
  function claudeCommand(): string {
    return process.env.TANDEM_CLAUDE_CMD || "claude";
  }

  async function buildPlan(cwdOverride?: string): Promise<SpawnPlan | null> {
    const integration = await readIntegration();
    if (!integration) return null;

    const saved = readSavedSession();
    const sessionId = saved ?? randomUUID();
    const resuming = !!saved;

    return {
      integration,
      cwd: resolveCwd(integration, cwdOverride),
      sessionId,
      resuming,
    };
  }

  async function spawnOnce(plan: SpawnPlan): Promise<void> {
    if (child) throw new Error("Supervisor already running — call stop() first");

    const reaper = reaperPath();
    const claudeBin = claudeCommand();
    const claudeArgs = buildClaudeArgs(plan);

    const reaperArgs = [String(process.pid), claudeBin, ...claudeArgs];

    console.error(
      `[Launcher] Spawning Claude via reaper. cwd=${plan.cwd} session=${plan.sessionId} resuming=${plan.resuming}`,
    );

    // Every handler below closes over `spawned`, never the mutable module-level
    // `child`. `child` is reassigned by the next spawn (and nulled on exit), so
    // a late callback from THIS process that dereferenced `child` could act on
    // a *different, newer* process — e.g. writing this spawn's bootstrap turn
    // into a freshly restarted Claude's stdin.
    const spawned = spawn(reaper, reaperArgs, {
      cwd: plan.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    child = spawned;

    // A spawn that reached this point supersedes whatever went wrong before it;
    // leaving the old code set would make it resurface on the next clean stop
    // (see the note on SupervisorStatus).
    lastError = undefined;

    currentCwd = plan.cwd;
    currentSessionId = plan.sessionId;
    currentResuming = plan.resuming;

    // Persist the session id on first successful spawn. We mark it as
    // "current" immediately; if Claude crashes during the resume window we'll
    // drop it in the exit handler.
    if (!plan.resuming) {
      writeSavedSession(plan.sessionId);
    }

    const spawnedAt = Date.now();

    // Track whether this spawn has run long enough to be considered a
    // successful resume. Fresh spawns are inherently "confirmed" — only a
    // --resume that exits early (conversation not found) should clear the
    // saved session. The timer is cancelled in the exit handler and in
    // stopInternal() so it never fires on a deliberate stop.
    let resumeConfirmed = !plan.resuming;
    if (plan.resuming) {
      confirmTimer = setTimeout(() => {
        resumeConfirmed = true;
        confirmTimer = null;
      }, RESUME_CONFIRM_MS);
    }

    // Loop-invariant, resolved once rather than per line: the bootstrap turn is
    // only ever sent on a fresh spawn (a resumed session already has its
    // history — a second copy of the prompt would be a duplicate turn), and
    // only once. Flipping this to false is what retires both conditions.
    let awaitingInit = !plan.resuming;

    /** Write the one bootstrap user turn. Targets `spawned`, not `child`. */
    function sendInitialTurn(): void {
      const stdin = spawned.stdin;
      if (!stdin?.writable) {
        console.error("[Launcher] Claude stdin not writable — initial prompt not delivered");
        return;
      }
      stdin.write(serializeUserTurn(SUPERVISOR_INITIAL_PROMPT), (err) => {
        if (err) console.error("[Launcher] Failed to send initial prompt:", err.message);
      });
    }

    function handleStdoutLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      // Deliberate discard: in stream-json mode stdout carries ONLY the JSON
      // envelope. Anything else is a non-Claude process, a pre-protocol banner,
      // or a wrapper's own chatter — none of it is ours to interpret, and none
      // of it is lost, because a real diagnostic goes to stderr, which the
      // handler below already logs verbatim. Re-logging it here would double
      // every message.
      //
      // This parser speaks Claude's stream-json envelope specifically. The
      // supervisor only spawns Claude today, so no provider guard is needed
      // here -- but one MUST be added back the moment a second provider can
      // reach this handler, or we would write a Claude-shaped user turn into
      // a foreign process's stdin.
      if (!trimmed.startsWith("{")) return;

      let parsed: { type?: string; subtype?: string; is_error?: boolean; errors?: string[] };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Started with `{` but isn't JSON — surface it rather than swallow it.
        console.error(`[Claude] ${trimmed}`);
        return;
      }

      if (awaitingInit && parsed.type === "system" && parsed.subtype === "init") {
        awaitingInit = false;
        sendInitialTurn();
        return;
      }
      // NOTE (#1267): `errors` is NOT confirmed to exist on the CLI's `result`
      // envelope — it can only be settled against a running `claude` binary.
      // Left as-is deliberately; the branch is inert if the field never
      // appears, so guessing a different shape would be strictly worse.
      if (parsed.type === "result" && parsed.is_error && Array.isArray(parsed.errors)) {
        console.error(`[Claude] Output error: ${parsed.errors.join("; ")}`);
      }
    }

    // setEncoding, not chunk.toString(): the decoder is stateful and holds back
    // a partial multi-byte sequence until its remaining bytes arrive. Decoding
    // each chunk independently replaces any non-ASCII character straddling a
    // chunk boundary with U+FFFD.
    //
    // Scope, stated honestly because it was measured: U+FFFD inside a JSON
    // string is still valid JSON, and the only fields dispatched on today
    // (`type`, `subtype`) are ASCII — so per-chunk decoding does NOT currently
    // drop protocol messages, and no end-to-end test can detect it. What it
    // corrupts is every *content* field: the `result` text logged below, and
    // anything a future branch reads. Silent, unrecoverable downstream, and one
    // line to prevent. See `createLineFramer`'s unit tests for the mechanism.
    spawned.stdout?.setEncoding("utf8");
    const stdoutFramer = createLineFramer(handleStdoutLine);
    spawned.stdout?.on("data", (text: string) => stdoutFramer.push(text));
    // A stream can end mid-line (no trailing newline). Without this the last
    // message — often the `result` envelope — would never be seen.
    spawned.stdout?.on("end", () => stdoutFramer.flush());

    // stderr is line-buffered for the same reason stdout is: a per-chunk
    // console.error splits one Claude diagnostic across two log lines and
    // glues unrelated ones together.
    spawned.stderr?.setEncoding("utf8");
    const stderrFramer = createLineFramer((line) => {
      const text = line.trimEnd();
      if (text) console.error(`[Claude] ${text}`);
    });
    spawned.stderr?.on("data", (text: string) => stderrFramer.push(text));
    spawned.stderr?.on("end", () => stderrFramer.flush());

    spawned.on("error", (err: NodeJS.ErrnoException) => {
      // Cancel the confirmation timer — spawn errors don't flow through the
      // exit handler, so confirmTimer must be cleared here too. Without this,
      // the 30s timer from a failed resuming spawn would fire later and null
      // out confirmTimer for a subsequent spawn.
      if (confirmTimer) {
        clearTimeout(confirmTimer);
        confirmTimer = null;
      }
      // CRITICAL: clear child state so status() doesn't lie about being
      // running and so subsequent start()/relaunch() actually re-attempt.
      // ENOENT is unrecoverable without user action — trip the breaker
      // immediately rather than schedule a doomed restart.
      // Guarded on identity: a late event from a superseded spawn must not
      // erase the handle of the process that replaced it.
      if (child === spawned) {
        child = null;
        currentCwd = undefined;
        currentSessionId = undefined;
        currentResuming = false;
      }
      if (err.code === "ENOENT") {
        lastError = "binary-not-found";
        breakerTripped = true;
        console.error(
          `[Launcher] Reaper or Claude binary not found (${err.message}). Install Claude Code: npm i -g @anthropic-ai/claude-code`,
        );
      } else {
        lastError = "spawn-failed";
        console.error("[Launcher] Reaper spawn error:", err);
        if (!stopRequested) scheduleRestart();
      }
    });

    spawned.on("exit", (code, signal) => {
      const ranFor = Date.now() - spawnedAt;
      console.error(`[Launcher] Reaper exited (code=${code} signal=${signal} after ${ranFor}ms)`);
      // Identity-guarded for the same reason as the error handler above.
      if (child === spawned) child = null;

      // Cancel the confirmation timer — the process has already exited.
      if (confirmTimer) {
        clearTimeout(confirmTimer);
        confirmTimer = null;
      }

      // If the resume failed before being confirmed, drop the stale session so
      // the next restart goes fresh. Guard code !== null to avoid clearing on
      // signal kills (SIGTERM/SIGKILL set code=null, signal="SIGTERM"/"SIGKILL").
      // The old ranFor < RESUME_GRACE_MS guard was broken because claude --resume
      // takes ~6 s to detect a missing conversation — longer than RESUME_GRACE_MS
      // was set (5 s), so the session was never cleared (issue #1169).
      if (shouldClearSession({ resuming: plan.resuming, code, resumeConfirmed })) {
        console.error("[Launcher] Resume failed before confirmation — clearing saved session");
        clearSavedSession();
      }

      if (stopRequested) return;

      scheduleRestart();
    });

    // Await the immediate spawn outcome so an exec failure reaches the caller
    // (relaunch/startFresh) instead of resolving `{ ok: true }` while the error
    // lands only on stderr. `spawn()` reports exec failures ASYNCHRONOUSLY via
    // "error" — without this race the route's try/catch never sees them.
    // Resolve on "spawn" (the process actually started; later errors/exits then
    // flow through the long-lived handlers above). Reject on an "error" that
    // beats "spawn". The "exit" guard only fires in the pathological
    // exit-without-spawn case — without it that case would hang this await
    // *while holding withLock*, permanently wedging the supervisor.
    // Bound to the captured `spawned` ref, not the module-level `child` (the
    // long-lived error handler nulls `child`, which would defuse cleanup).
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        spawned.off("spawn", onSpawn);
        spawned.off("error", onEarlyError);
        spawned.off("exit", onEarlyExit);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onEarlyError = (err: NodeJS.ErrnoException) => {
        cleanup();
        // The long-lived child.on("error") handler (registered earlier) has
        // already cleared state (and, for ENOENT, tripped the breaker); we
        // only translate the error for the caller here.
        if (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EISDIR") {
          // The reaper binary is present-but-unrunnable → same user-actionable
          // class as "not found". Reuse the shared marker so api-routes maps it
          // to LAUNCHER_ERROR_REAPER_NOT_FOUND + the "reinstall Tandem" hint.
          reject(new Error(`${REAPER_NOT_FOUND_MARKER} (spawn ${err.code}: ${err.message})`));
        } else {
          reject(err);
        }
      };
      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`reaper exited before spawn (code=${code} signal=${signal})`));
      };
      spawned.once("spawn", onSpawn);
      spawned.once("error", onEarlyError);
      spawned.once("exit", onEarlyExit);
    });
  }

  function scheduleRestart(): void {
    if (restartTimer) clearTimeout(restartTimer);

    // Circuit breaker: drop attempts older than the window, then check count.
    const now = Date.now();
    recentAttempts = recentAttempts.filter((t) => now - t < CIRCUIT_BREAKER_WINDOW_MS);
    recentAttempts.push(now);
    if (recentAttempts.length > CIRCUIT_BREAKER_MAX_ATTEMPTS) {
      breakerTripped = true;
      lastError = "circuit-open";
      console.error(
        `[Launcher] Circuit breaker tripped: ${recentAttempts.length} restart attempts in ${CIRCUIT_BREAKER_WINDOW_MS}ms — giving up. Restart Tandem to retry.`,
      );
      return;
    }

    const delay = RESTART_BACKOFFS_MS[Math.min(restartIndex, RESTART_BACKOFFS_MS.length - 1)];
    restartIndex++;
    console.error(`[Launcher] Restarting Claude in ${delay}ms (attempt ${restartIndex})`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void startInternal();
    }, delay);
  }

  /** Internal start without lock acquisition — called by scheduleRestart and
   * the public `start()` wrapper. */
  async function startInternal(): Promise<void> {
    if (child) return;
    if (breakerTripped) return;
    stopRequested = false;
    const plan = await buildPlan();
    if (!plan) {
      console.error("[Launcher] No claude-code integration with apply != skip — skipping");
      return;
    }
    try {
      await spawnOnce(plan);
      // Reset backoff once a spawn runs long enough to be considered stable.
      // Must match RESUME_CONFIRM_MS — a doomed --resume exits at ~6s, so
      // the old 5s timer fired while the process was still alive, resetting
      // restartIndex before the exit and permanently neutering the backoff.
      setTimeout(() => {
        if (child) restartIndex = 0;
      }, RESUME_CONFIRM_MS);
    } catch (err) {
      console.error("[Launcher] Spawn failed:", err);
    }
  }

  async function start(): Promise<void> {
    return withLock(() => startInternal());
  }

  async function relaunch(newCwd: string): Promise<void> {
    return withLock(async () => {
      await stopInternal();
      // Relaunch always means "user is actively asking" → clear breaker.
      breakerTripped = false;
      recentAttempts = [];
      // stopInternal() raised the stop flag on the way in. Lower it before the
      // new spawn, or the exit handler treats the *next* crash as a deliberate
      // stop and silently declines to restart — the supervisor stays dead.
      stopRequested = false;
      const plan = await buildPlan(newCwd);
      if (!plan) return;
      await spawnOnce(plan);
    });
  }

  async function stopInternal(): Promise<void> {
    stopRequested = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    const c = child;
    if (!c || c.killed) {
      // Already dead, or never started — nothing to signal. But we must still
      // DROP the handle rather than early-returning with `child` set:
      // spawnOnce() throws when `child` is non-null, so a killed-but-retained
      // handle turns the very next relaunch()/startFresh() into a user-visible
      // "relaunch failed" for a supervisor that is, in fact, idle.
      child = null;
      currentCwd = undefined;
      currentSessionId = undefined;
      currentResuming = false;
      return;
    }
    try {
      c.kill("SIGTERM");
    } catch {
      // best-effort
    }
    // Wait for the reaper to exit gracefully. If it doesn't within
    // SIGTERM_GRACE_MS, escalate to SIGKILL (which the reaper's own escalation
    // would do for Claude anyway, but here we're escalating the REAPER itself
    // because its kqueue/PDEATHSIG handler might be stuck). Then a final
    // safety-net timeout so we never block shutdown indefinitely.
    const SIGTERM_GRACE_MS = 6_000;
    const SAFETY_NET_MS = 10_000;
    const exited = await new Promise<boolean>((resolve) => {
      const onExit = () => resolve(true);
      c.once("exit", onExit);
      setTimeout(() => resolve(false), SIGTERM_GRACE_MS);
    });
    if (!exited) {
      console.error("[Launcher] Reaper did not exit on SIGTERM — escalating to SIGKILL");
      try {
        c.kill("SIGKILL");
      } catch {
        // best-effort
      }
      await new Promise<void>((resolve) => {
        c.once("exit", () => resolve());
        setTimeout(resolve, SAFETY_NET_MS - SIGTERM_GRACE_MS);
      });
      if (c.exitCode === null && c.signalCode === null) {
        console.error(
          "[Launcher] Reaper failed to exit even after SIGKILL — abandoning handle, child may persist",
        );
        lastError = "stop-failed";
      }
    }
    child = null;
    currentCwd = undefined;
    currentSessionId = undefined;
    currentResuming = false;
  }

  async function stop(): Promise<void> {
    return withLock(() => stopInternal());
  }

  async function startFresh(cwdOverride?: string): Promise<void> {
    return withLock(async () => {
      await stopInternal();
      clearSavedSession();
      breakerTripped = false;
      recentAttempts = [];
      // See relaunch(): stopInternal() set stopRequested, and leaving it set
      // would disarm the auto-restart for the whole life of the new spawn.
      stopRequested = false;
      const plan = await buildPlan(cwdOverride);
      if (!plan) return;
      await spawnOnce(plan);
    });
  }

  function status(): SupervisorStatus {
    if (
      child &&
      !child.killed &&
      child.pid !== undefined &&
      currentCwd !== undefined &&
      currentSessionId !== undefined
    ) {
      return {
        running: true,
        reaperPid: child.pid,
        cwd: currentCwd,
        sessionId: currentSessionId,
        resuming: currentResuming,
      };
    }
    return lastError ? { running: false, lastError } : { running: false };
  }

  return { start, relaunch, stop, startFresh, status };
}

/** Exported for unit testing. Resolves a cwd candidate to a canonical path,
 * rejecting UNC paths, Windows `\\?\` / `\\.\` device namespaces, relative
 * paths, and anything that does not canonicalize to a real directory.
 * Returns null on any rejection so callers can fall back to a safe default.
 *
 * This is the *permissive* resolver used by integration-file reads — a user
 * who edits `integrations.json` directly can point the launcher at any
 * canonical directory on disk. HTTP-driven mutations must use
 * `resolveRouteCwd()` below, which additionally home-confines. */
export function resolveSafeCwd(candidate: string): string | null {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return null;
  if (process.platform === "win32") {
    if (candidate.startsWith("\\\\?\\") || candidate.startsWith("\\\\.\\")) return null;
    if (candidate.startsWith("\\\\")) return null; // UNC
  }
  try {
    // This function IS the path validator: it canonicalizes via realpath,
    // rejects non-directories, and returns null on any failure. Callers
    // either gate the result further (resolveRouteCwd home-confines) or
    // accept advanced users' explicit integrations.json scope.
    const real = fs.realpathSync(candidate); // lgtm[js/path-injection]
    const stat = fs.statSync(real); // lgtm[js/path-injection]
    if (!stat.isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

/** HTTP-surface variant of `resolveSafeCwd`. Adds: the canonical path must
 * be under `os.homedir()` (also canonicalized) so a malicious loopback page
 * can't pivot Claude into system directories via a junction/symlink the user
 * happens to have under their home tree. The integration-file path bypasses
 * this — advanced users who hand-edit `integrations.json` opt into wider
 * scope.
 *
 * `opts.homeOverride` is a test-only seam: passing an explicit "home" lets
 * cross-platform unit tests stand up a tmpdir, treat it as $HOME, and
 * assert outside-home rejection deterministically on every platform.
 * Mirrors the `refreshSkillIfStale(opts: { homeOverride? })` pattern in
 * `src/server/integrations/apply.ts`. Production callers leave it unset
 * and get `os.homedir()`. */
export function resolveRouteCwd(
  candidate: string,
  opts: { homeOverride?: string } = {},
): string | null {
  const safe = resolveSafeCwd(candidate);
  if (safe === null) return null;
  let homeReal: string;
  try {
    homeReal = fs.realpathSync(opts.homeOverride ?? os.homedir());
  } catch {
    return null;
  }
  const rel = path.relative(homeReal, safe);
  // Outside home (`rel` starts with `..`), or a different drive on Windows
  // (`rel` is absolute), or the empty string (home itself — allowed).
  if (rel === "") return safe;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return safe;
}
