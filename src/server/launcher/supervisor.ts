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
import type { LauncherErrorCode } from "../../shared/launcher/contract.js";
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
const RESUME_GRACE_MS = 5_000;
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

/** Discriminated union: when `running === false` no other fields exist;
 * when `running === true` all process-level fields are guaranteed present. */
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
    };

export function createSupervisor(opts: SupervisorOpts): Supervisor {
  let child: ChildProcess | null = null;
  let currentCwd: string | undefined;
  let currentSessionId: string | undefined;
  let currentResuming = false;
  let stopRequested = false;
  let restartIndex = 0;
  let restartTimer: NodeJS.Timeout | null = null;
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
    throw new Error(`tandem-reaper binary not found (checked ${adjacent})`);
  }

  // TANDEM_CLAUDE_CMD honors PATH search via spawn. Security boundary is
  // "user controls their own PATH" — same as running `claude` in any terminal.
  function claudeCommand(): string {
    return process.env.TANDEM_CLAUDE_CMD || "claude";
  }

  function buildClaudeArgs(plan: SpawnPlan): string[] {
    const args = ["--dangerously-load-development-channels", "server:tandem-channel"];
    if (plan.resuming) {
      args.push("--resume", plan.sessionId);
    } else {
      args.push("--session-id", plan.sessionId);
    }
    return args;
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
    const reaper = reaperPath();
    const claudeBin = claudeCommand();
    const claudeArgs = buildClaudeArgs(plan);

    const reaperArgs = [String(process.pid), claudeBin, ...claudeArgs];

    console.error(
      `[Launcher] Spawning Claude via reaper. cwd=${plan.cwd} session=${plan.sessionId} resuming=${plan.resuming}`,
    );

    child = spawn(reaper, reaperArgs, {
      cwd: plan.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });

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

    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trimEnd();
      if (line) console.error(`[Claude] ${line}`);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      // CRITICAL: clear child state so status() doesn't lie about being
      // running and so subsequent start()/relaunch() actually re-attempt.
      // ENOENT is unrecoverable without user action — trip the breaker
      // immediately rather than schedule a doomed restart.
      child = null;
      currentCwd = undefined;
      currentSessionId = undefined;
      currentResuming = false;
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

    child.on("exit", (code, signal) => {
      const ranFor = Date.now() - spawnedAt;
      console.error(`[Launcher] Reaper exited (code=${code} signal=${signal} after ${ranFor}ms)`);
      child = null;

      // If we were resuming and crashed inside the grace window, drop the
      // saved session and retry fresh next time.
      if (plan.resuming && code !== 0 && ranFor < RESUME_GRACE_MS) {
        console.error("[Launcher] Resume failed within grace window — clearing saved session");
        clearSavedSession();
      }

      if (stopRequested) return;

      scheduleRestart();
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
      // Reset backoff once a spawn lives past the resume window.
      setTimeout(() => {
        if (child) restartIndex = 0;
      }, RESUME_GRACE_MS);
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
    const c = child;
    if (!c || c.killed) return;
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
