/**
 * Claude Code supervisor — spawns Claude as a child of Tandem and guarantees
 * OS-level reaping when Tandem dies (via the tandem-reaper helper binary).
 *
 * Gating: HTTP mode only. Requires a `claude-code` integration with
 * `apply !== "skip"` in `integrations.json`. Otherwise no-op.
 *
 * Lifecycle:
 *   start() — read integration, spawn reaper(claude). Backoff on crash.
 *   relaunch(cwd?) — stop + respawn, optionally with a new cwd (/relaunch-here).
 *   stop() — SIGTERM the reaper; reaper forwards to Claude with 5s SIGKILL escalation.
 *
 * Session persistence: stores the last session ID **and the directory it was
 * created in** in `<appDataDir>/launcher-session.json`. On startup, attempts
 * `--resume <id>` only when the planned cwd still matches that directory —
 * Claude Code stores conversations per directory, so a resume from anywhere
 * else cannot succeed (see `sessionCwdMatches`). On non-zero exit within the
 * resume window, falls back to a fresh `--session-id <uuid>` spawn.
 *
 * Moving Claude: a `relaunch`/`startFresh` that names a cwd also PERSISTS it to
 * the integration, so a later crash-restart — which rebuilds the plan with no
 * override — stays where the user put it (see `persistWorkingDirectory`).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TandemEvent } from "../../shared/events/types.js";
import type {
  ClaudeCodeIntegration,
  IntegrationConfig,
} from "../../shared/integrations/contract.js";
import {
  detectClaudeCli,
  isBareNameLaunchable,
} from "../../shared/integrations/detect-claude-cli.js";
import {
  CLAUDE_STREAM_JSON_FLAGS,
  type LauncherErrorCode,
  REAPER_NOT_FOUND_MARKER,
  SUPERVISOR_INITIAL_PROMPT,
  SUPERVISOR_WAKE_PROMPT,
  serializeUserTurn,
} from "../../shared/launcher/contract.js";
import { subscribe, unsubscribe } from "../events/queue.js";
import { createIntegrationsStore } from "../integrations/storage.js";

interface SupervisorOpts {
  /** Directory containing `integrations.json` (typically `resolveAppDataDir()`). */
  integrationsBase: string;
  /**
   * Seam onto the event fan-out, for tests that need to drive wakes without
   * standing up the real queue's Y.Doc observers. Returns an unsubscribe fn.
   *
   * The default subscribes as `"external"`, and that is the load-bearing part:
   * the launched Claude is a consumer OUTSIDE this process, so it must sit
   * behind the queue's Solo gate (`shouldForwardExternally`) exactly as the SSE
   * consumers do. Subscribing as `"internal"` would bypass that gate and push
   * the user's Solo-held annotations at Claude — the precise leak WS-A2 exists
   * to prevent. `"external"` is also correct for `alreadyPushed` accounting: a
   * turn written to the child's stdin genuinely reaches Claude.
   *
   * Unlike the always-on local-model collaborator the `externalSubscribers`
   * docblock warns about, this subscription lives and dies with a running child
   * process, so `getSubscriberCount() > 0` stays a true statement about
   * something being attached rather than a constant.
   */
  subscribeToEvents?: (cb: (event: TandemEvent) => void) => () => void;
  /**
   * Override for `WAKE_LATCH_MAX_MS`, so the latch-breaker can be tested in
   * milliseconds rather than by waiting ten minutes.
   *
   * The latch exists precisely to convert a silent permanent failure into a
   * delayed one; leaving it unreachable from a test would mean the safeguard
   * against silent failure was itself unverified.
   */
  wakeLatchMs?: number;
  /**
   * Seam onto the "is the Claude CLI usable at all?" filesystem probe, so the
   * breaker-trip tests don't depend on whether the host running them happens
   * to have a `claude` binary installed.
   *
   * MUST stay synchronous. `scheduleRestart` sets `breakerTripped` and the
   * discriminated `lastError` in one tick, which is the only reason `status()`
   * can never observe one without the other; an async probe would open that
   * window silently, with nothing in the type to warn the next editor.
   */
  probeCliUsable?: () => boolean;
  /**
   * Override for `RESTART_BACKOFFS_MS`, so a test can drive the eleven crashes
   * the circuit breaker needs without waiting out the real 1s/5s/30s ladder.
   *
   * Same justification as `wakeLatchMs`: the breaker is a safeguard whose whole
   * job is to stop an invisible restart loop, and testing it through a mirror of
   * `scheduleRestart` rather than the function itself would verify the mirror.
   */
  restartBackoffsMs?: number[];
}

/**
 * Default `probeCliUsable`: the CLI is usable if it exists *and* the launcher's
 * bare-name spawn can actually start it. The second half is the Windows npm
 * shim case — `claude.cmd` on PATH answers "installed" to every check a user
 * would run by hand, and `CreateProcessW` still cannot launch it (#1273).
 *
 * Both halves are `statSync`-based, hence synchronous; see `probeCliUsable`.
 */
function defaultProbeCliUsable(): boolean {
  return detectClaudeCli() !== "NOT_INSTALLED" && isBareNameLaunchable();
}

/** Exported for test only — the `"external"` argument below is the single line
 * standing between Solo mode and a leak, so it needs a test that exercises the
 * real queue rather than an injected fake. */
export function defaultSubscribeToEvents(cb: (event: TandemEvent) => void): () => void {
  subscribe(cb, "external");
  return () => unsubscribe(cb);
}

/**
 * Which events are worth interrupting Claude for.
 *
 * Narrower than the channel shim's set, which forwards everything that clears
 * the queue's gates. A channel notification is cheap to ignore; a turn written
 * on stdin compels a response, so `document:*` lifecycle — fired whenever the
 * user clicks a tab — would turn ordinary navigation into a stream of forced
 * wakes. Annotations and chat are the events where the user is actually asking
 * for something, and Claude re-reads document state from `tandem_checkInbox`
 * when it does wake.
 *
 * The Solo→Tandem release wake is a synthetic `annotation:created`
 * (`emitModeReleaseWake`), so it clears this filter by construction.
 */
function isWakeWorthy(event: TandemEvent): boolean {
  return event.type.startsWith("annotation:") || event.type === "chat:message";
}

/**
 * Latch-breaker for wake coalescing: if a turn's `result` line never arrives,
 * treat the session as idle again after this long.
 *
 * `turnInFlight` is cleared by the CLI's `result` envelope. If that envelope
 * were ever missed — a shape change, a wedged turn, a dropped line — the latch
 * would stay set and the session would never be woken again, silently and
 * permanently. Deliberately generous: a real turn may legitimately run for
 * minutes, and the cost of breaking the latch early is only a redundant
 * `checkInbox` nudge (the CLI reads stdin as a stream and queues turns), while
 * the cost of never breaking it is a dead feature.
 *
 * Two known limitations, recorded rather than papered over:
 *
 * 1. Breaking the latch on a turn that is merely SLOW leaves two turns
 *    outstanding, and `result` envelopes carry no correlation id — so the
 *    first result to arrive clears the tracking for whichever turn is current.
 *    The consequence is bounded (an extra content-free nudge; never a lost
 *    one), and fixing it properly needs a turn id the wire protocol does not
 *    have. Widening the window is what keeps it rare.
 * 2. This cannot detect a reaper that is alive but has stopped forwarding to
 *    Claude: `write()` succeeds into the reaper's pipe, no `result` ever
 *    returns, and the latch simply expires every window. `result` is the only
 *    liveness signal available, so that state is indistinguishable from a very
 *    long turn. It is why the expiry logs at all.
 */
const WAKE_LATCH_MAX_MS = 10 * 60_000;

interface SpawnPlan {
  integration: ClaudeCodeIntegration;
  cwd: string;
  /** Was `cwd` the caller's override, resolved and honored? False when no
   * override was passed, and false when one was passed but did not resolve —
   * in which case `cwd` is the configured directory or home, NOT the request.
   * The only honest answer to "did the move happen?", produced by the function
   * that decided it (`resolveCwd`) rather than reconstructed by a second
   * resolution of the same string. */
  cwdFromOverride: boolean;
  sessionId: string;
  resuming: boolean;
}

/** The claude-code entry the supervisor will actually launch. `apply: "skip"`
 * means configured-but-disabled, so such an entry is not a launch candidate.
 *
 * Named and shared so the read (`readIntegration`) and the durable write
 * (`persistWorkingDirectory`) cannot drift: a mismatch would persist into an
 * entry the launcher never reads. `makeWorkingDirHandler` (api-routes.ts)
 * deliberately does NOT use this — see `persistWorkingDirectory`. */
function isLaunchableClaudeCode(i: IntegrationConfig): i is ClaudeCodeIntegration {
  return i.kind === "claude-code" && i.apply !== "skip";
}

/** The last-resort working directory, canonicalized.
 *
 * `resolveCwd`'s other exit realpaths via `resolveSafeCwd`, and `plan.cwd` is
 * written verbatim into `launcher-session.json` and then compared by
 * `sessionCwdMatches`, whose contract is "both sides are realpath'd". A raw
 * `os.homedir()` breaks exactly that invariant on any host where $HOME is
 * reached through a symlink (enterprise NFS, a macOS data volume), so the
 * bare-restart spelling and the override spelling of the same folder compare
 * unequal — discarding a live conversation, and oscillating, because a
 * crash-restart lands on one spelling and an explicit restart on the other.
 *
 * `?? os.homedir()` preserves today's behaviour for the pathological case
 * where home itself does not resolve to a directory. */
export function homeCwd(): string {
  return resolveSafeCwd(os.homedir()) ?? os.homedir();
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

/** Options for the two cwd-bearing lifecycle calls. */
export interface RelocateOpts {
  /**
   * Also write the requested folder to the integration's `workingDirectory`,
   * making the move outlive this spawn.
   *
   * Defaults to false, and the default is the safe one: a caller that merely
   * *has* a cwd (the recovery chip, which derives one from the active tab) must
   * not durably repoint Claude. Only a caller that knows the user named the
   * folder should set it. See `persistRequestedCwd`.
   */
  persistCwd?: boolean;
}

export interface Supervisor {
  start(): Promise<void>;
  /**
   * Stop and respawn. Omit `newCwd` to fall back to the integration's
   * configured directory.
   *
   * The conversation survives a same-folder restart; `startFresh` is the one
   * that always drops it. It does NOT survive a move — not by choice, but
   * because Claude Code stores conversations per directory (see
   * `sessionCwdMatches`). "Lost" there means Tandem loses its *pointer*: the
   * old conversation still exists on disk under the old directory, and can be
   * reached by running `claude --resume <id>` from that directory by hand.
   *
   * `newCwd` alone moves Claude for THIS spawn only. Pass
   * `{ persistCwd: true }` to also make it the integration's
   * `workingDirectory`, so later restarts stay there. The split is deliberate —
   * see `persistRequestedCwd` for why a cwd on the wire is not evidence that
   * the user chose that folder.
   */
  relaunch(newCwd?: string, opts?: RelocateOpts): Promise<void>;
  /** Idempotent — safe to call when not running. */
  stop(): Promise<void>;
  /** Drop any persisted session and respawn fresh. Omit `cwdOverride` to use the
   * integration's configured directory; `opts.persistCwd` behaves as in
   * `relaunch`. Single atomic stop+clear+spawn under the supervisor lock. */
  startFresh(cwdOverride?: string, opts?: RelocateOpts): Promise<void>;
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

/** Contents of `launcher-session.json`. */
interface SavedSession {
  sessionId: string;
  /** Directory the session was created in — *created*, not last-used:
   * `writeSavedSession` only fires when `resuming` is false, so a resumed
   * session never rewrites the record.
   *
   * `undefined` for files written before this field existed, AND for a present
   * but non-string value. The two are treated identically, deliberately: unlike
   * `sessionId` — which gets a UUID-shape gate because a tampered value flows
   * into `--resume` — a bad `cwd` can only cost one doomed resume, so the
   * permissive branch is cheaper than a second log line.
   *
   * That bound covers the shapes this branch can DETECT (absent, or
   * present-but-not-a-string → `undefined` → treated as a match). A well-typed
   * but *wrong* `cwd` — reachable because this file is not written atomically,
   * so a kill mid-write can truncate it — costs the opposite and worse thing:
   * a guaranteed mismatch, a fresh UUID, and this single-slot file overwritten,
   * i.e. a discarded conversation with no doomed resume at all. Nothing here
   * can tell that case from a real relocation, which is why the file should
   * eventually be written atomically. */
  cwd?: string;
}

/**
 * May the saved session be resumed by a spawn planned for `plannedCwd`?
 *
 * **The load-bearing fact: Claude Code scopes conversations to the working
 * directory they were created in.** A session minted in folder A cannot be
 * resumed from folder B — measured against the real CLI (2.1.223, 2026-08-05),
 * where `claude --resume <id>` from another directory printed
 * `No conversation found with session ID` and exited 1.
 *
 * That behavioural contract is what this gate depends on. The mechanism behind
 * it — a per-directory store under `~/.claude/projects/<encoded-cwd>/` —
 * is recorded only to explain WHY, and is deliberately not relied on: nothing
 * in Tandem reads that path, no test pins it, and Claude Code may restructure
 * it in any release without this file noticing.
 *
 * Without the gate, that exit is indistinguishable from a crash, so the
 * launcher would attempt the doomed resume, trip `shouldClearSession` (losing
 * the conversation anyway), and schedule a restart — one wasted spawn and a
 * backoff cycle to reach the fresh session it could have started with. Worse,
 * the whole sequence is invisible: the relaunch route already answered
 * `{ ok: true }`. (That chain holds because `RESUME_CONFIRM_MS` exceeds the
 * CLI's ~6s detection; drop it below and a doomed resume would instead be
 * marked confirmed and the dead session KEPT. See the exit handler.)
 *
 * This is the single place that decides it, so every source of a cwd change —
 * `/relaunch` with a cwd, a Settings working-directory edit, a hand-edited
 * `integrations.json` — is covered by construction rather than one at a time.
 *
 * **An unknown origin is treated as a match.** Files written before `cwd` was
 * recorded carry no origin, and the overwhelmingly common case is that nothing
 * moved. Assuming a mismatch would discard a live conversation on upgrade for
 * everyone; assuming a match preserves it, and costs at most the one doomed
 * resume that is today's unconditional behaviour.
 *
 * The cost is real but bounded, and the bound is worth stating precisely: a
 * legacy file that keeps resuming in the same folder is NEVER upgraded, because
 * `writeSavedSession` only fires when `resuming` is false. So such a user stays
 * on the permissive branch indefinitely — and pays exactly once, on their FIRST
 * relocation, which takes the doomed resume, clears the session, and writes a
 * cwd-carrying record. Every later move is gated properly.
 *
 * `platform` is injectable so both comparison branches run on every CI host —
 * vitest runs on `ubuntu-latest` only, which would otherwise leave the win32
 * branch verified nowhere but a maintainer's laptop. Mirrors `resolveRouteCwd`'s
 * `homeOverride` seam.
 */
export function sessionCwdMatches(
  savedCwd: string | undefined,
  plannedCwd: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (savedCwd === undefined) return true;
  // Both sides are realpath'd, but Node's JS `realpathSync` does not
  // case-normalize on Windows — so this fold is load-bearing, not dead code.
  if (platform === "win32") {
    return savedCwd.toLowerCase() === plannedCwd.toLowerCase();
  }
  return savedCwd === plannedCwd;
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
  const subscribeToEvents = opts.subscribeToEvents ?? defaultSubscribeToEvents;
  const wakeLatchMs = opts.wakeLatchMs ?? WAKE_LATCH_MAX_MS;
  const probeCliUsable = opts.probeCliUsable ?? defaultProbeCliUsable;
  const restartBackoffs = opts.restartBackoffsMs?.length
    ? opts.restartBackoffsMs
    : RESTART_BACKOFFS_MS;
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
  /**
   * Teardown for the active spawn's event subscription, paired with the handle
   * it belongs to.
   *
   * Module-scoped for the same reason `confirmTimer` is: `stopInternal` has to
   * be able to release it. Relying on the child's `exit` event alone is not
   * enough — `stopInternal`'s escalation path can give up on a reaper that
   * survives SIGKILL, log "abandoning handle", and null `child` while that
   * process is still alive and its `exit` never fires. The subscription would
   * then outlive the supervisor's own belief that anything is running, keep
   * writing wake turns into a process Tandem no longer controls, and be joined
   * by a second subscription on the next start — once per occurrence, unbounded.
   *
   * Paired with `spawned` rather than stored bare so a late release from a
   * superseded spawn cannot detach the subscription of the one that replaced it.
   */
  let activeTurnDelivery: { spawned: ChildProcess; teardown: () => void } | null = null;

  /** Release the active spawn's subscription, whatever state its process is in.
   * Idempotent — the `exit` handler normally gets here first. */
  function releaseTurnDelivery(): void {
    activeTurnDelivery?.teardown();
    activeTurnDelivery = null;
  }

  /**
   * A wake was owed when the last spawn died, and no turn has carried it yet.
   *
   * Survives across spawns deliberately. Without it: a fresh spawn's bootstrap
   * turn is in flight, the user comments (so `pendingWake` is set), Claude
   * crashes, and the restart resumes — `writeSavedSession` persisted the id
   * before the process proved stable, so `buildPlan` returns `resuming: true`
   * and the resumed path sends NO bootstrap turn. The comment would then sit
   * unannounced until some unrelated later event happened to wake the session.
   */
  let wakeOwedAcrossSpawns = false;

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
    const found = file.integrations.find(isLaunchableClaudeCode);
    return found ?? null;
  }

  function sessionFilePath(): string {
    return path.join(opts.integrationsBase, SESSION_FILE_NAME);
  }

  function readSavedSession(): SavedSession | undefined {
    try {
      const raw = fs.readFileSync(sessionFilePath(), "utf8");
      const parsed = JSON.parse(raw) as { sessionId?: unknown; cwd?: unknown };
      if (typeof parsed.sessionId !== "string") return undefined;
      // UUID-shape gate: anything else is either corruption or tampering.
      if (!UUID_V4_PATTERN.test(parsed.sessionId)) {
        console.error("[Launcher] launcher-session.json sessionId is not UUID-shaped — ignoring");
        return undefined;
      }
      // Absent is the documented legacy case. Present-but-not-a-string is
      // corruption or tampering — only this module writes the file, and it
      // always writes a string. Both end up on the permissive "resume anywhere"
      // branch, so the corrupt one gets a log line for symmetry with the
      // sessionId gate above; without it a tampered file changes launcher
      // behaviour leaving no trace at all.
      if ("cwd" in parsed && typeof parsed.cwd !== "string") {
        console.error("[Launcher] launcher-session.json cwd is not a string — treating as unknown");
      }
      return {
        sessionId: parsed.sessionId,
        // Deliberately `undefined` rather than defaulted — `sessionCwdMatches`
        // decides what an unknown origin means, in one place.
        cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      };
    } catch (err) {
      // ENOENT is the normal "no session yet" path and must stay silent.
      // Anything else — malformed JSON, EACCES, a file truncated by a kill
      // mid-write (this is not an atomic write) — silently drops the user's
      // conversation, so say so.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error("[Launcher] Could not read launcher-session.json — starting fresh:", err);
      }
      return undefined;
    }
  }

  /** `cwd` is written alongside the id because a Claude Code session is only
   * resumable from the directory it was created in — see `sessionCwdMatches`. */
  function writeSavedSession(sessionId: string, cwd: string): void {
    try {
      fs.writeFileSync(sessionFilePath(), JSON.stringify({ sessionId, cwd }, null, 2), {
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

  /**
   * Persist an explicitly-requested cwd as the integration's `workingDirectory`.
   *
   * Without this, the first crash silently undoes the move: `scheduleRestart` →
   * `startInternal` → `buildPlan()` is called with NO override, so `resolveCwd`
   * falls back through the integration to `homeCwd()` and Claude reappears in
   * the folder the user just moved it out of. Persisting is what makes "restart
   * Claude here" also mean "and stay here" — across restarts and across a Tandem
   * restart.
   *
   * Called with the RESOLVED `plan.cwd`, not the caller's raw string, so what is
   * stored is exactly what the spawn runs in.
   *
   * Best-effort: a write failure is logged, never thrown. The spawn that follows
   * still uses the requested cwd, so a failed write costs durability only —
   * strictly less than failing the relaunch the user asked for.
   *
   * Deliberately NOT shared with `makeWorkingDirHandler` (`api-routes.ts`), which
   * does the same read-modify-write from the Settings route. That one validates a
   * raw user string, supports clearing to `null`, and 404s on a missing
   * integration; this one takes an already-resolved path and stays silent. It
   * also selects the integration with `readIntegration`'s predicate
   * (`isLaunchableClaudeCode`, i.e. `apply !== "skip"`) rather than the route's
   * looser `kind === "claude-code"`, because the entry to update is the one the
   * supervisor actually launches — both take the FIRST match, so they differ
   * only when the first claude-code entry is skipped and a live one follows it.
   * When those two entries do differ, the Settings UI reads the route's entry
   * while the launcher runs the supervisor's, so Settings can display a working
   * directory the launcher ignores — and every Settings edit then writes
   * somewhere the launcher never reads. Reconciling the two predicates is a
   * Settings-route behaviour change (an entry whose only claude-code
   * integration is `apply: "skip"` would start 404-ing) and is left deliberate
   * here.
   *
   * Known gap: neither path holds a cross-module lock, so any concurrent
   * `integrations.json` writer landing between this read and write loses one of
   * the two updates — not just a Settings save, but the wizard's whole-array
   * `POST /api/integrations`, `applyConfig`, and `tandem setup --apply`, which
   * are likelier collisions. Narrow because the surfaces are single-user and
   * separately inflight-guarded (NOT because they are loopback — since #1293
   * `assertLoopbackForMutation` does gate unconditionally, but a loopback
   * boundary bounds *who* can race, not whether two local writes interleave).
   * Fixing it properly belongs in the store, not here.
   */
  async function persistWorkingDirectory(cwd: string): Promise<void> {
    try {
      const store = createIntegrationsStore(opts.integrationsBase);
      const file = await store.read();
      const idx = file.integrations.findIndex(isLaunchableClaudeCode);
      if (idx === -1) {
        // Expected-impossible: `buildPlan` just found one. Reachable only if the
        // entry was removed or skipped between its read and ours (the wizard's
        // whole-array POST, a hand edit, a sync tool). Loudest branch, not the
        // quietest — silence here reads as a successful move that then reverts.
        console.error(
          "[Launcher] claude-code integration vanished between plan and persist — working directory not saved",
        );
        return;
      }
      const current = file.integrations[idx] as ClaudeCodeIntegration;
      if (current.workingDirectory === cwd) return; // no-op write
      await store.write({
        ...file,
        integrations: file.integrations.map(
          (entry, i): IntegrationConfig =>
            i === idx ? { ...current, workingDirectory: cwd } : entry,
        ),
      });
    } catch (err) {
      console.error("[Launcher] Failed to persist workingDirectory:", err);
    }
  }

  /**
   * Persist a caller-requested cwd, under TWO conditions. Both are load-bearing
   * and each guards a different way of durably moving Claude somewhere the user
   * never asked for.
   *
   * **1. The caller must have meant it (`persistCwd`).** A cwd on the wire is
   * not evidence of intent. `relaunchClaudeCode()` — the "Restart Claude Code"
   * recovery chip on the status pill, empty state and AI toast — runs
   * `relaunchHere(…, { cwdRequired: false })`, which still *sends*
   * `dirname(activeDocumentPath)` whenever any tab is open; it is bare only in
   * the empty state. Persisting that would mean clicking a RECOVERY button with
   * a stray note open silently repoints Claude at that note's folder forever.
   * Only the palette's explicit "relaunch here" (`cwdRequired: true`) sets this.
   *
   * **2. The request must have been honored.** `resolveCwd` short-circuits on
   * `override ?? workingDirectory`, so a present-but-unresolvable override does
   * NOT fall back to the configured directory — it drops through to
   * `os.homedir()`. Persisting that would overwrite the user's project folder
   * with home. Narrow (both callers pre-validate via `resolveRouteCwd`, so it
   * needs a TOCTOU — a rename, an unmounted drive, an AV hold on
   * `realpathSync`) but silent, durable, and destructive.
   *
   * That second question is answered by `resolveCwd` — the one function that
   * decides it — and carried on `SpawnPlan.cwdFromOverride`, rather than being
   * reconstructed here by resolving the same string a second time. Two
   * independent `realpathSync` calls only have to AGREE for this to be correct,
   * and the direction where the second one succeeds after the first failed is
   * the worse one: it persists a folder the spawn is not running in. One
   * resolution has no second answer to drift from — which also eliminates,
   * rather than merely tolerating, a future change to `resolveCwd`'s fallback
   * order. `plan.cwd` is therefore byte-identical to what the spawn runs in.
   *
   * Residual TOCTOU: a symlink swap between the route's `resolveRouteCwd`
   * (which home-confines) and `buildPlan`'s `safeCwd` (which does not) lands
   * the SPAWN outside home, and a `persistCwd` request then records that
   * escaped path durably. Persisting `plan.cwd` does not close that — the
   * durable write is still only as confined as the permissive resolver — it
   * closes only the divergence between the persisted and the spawned value.
   * Home-confining here would move an HTTP-boundary policy into a
   * process-level API that has non-route callers.
   *
   * Note the write lands BEFORE `spawnOnce`, so a spawn that then throws leaves
   * the setting already moved. Deliberate: the user asked to move, and the next
   * restart should still honour it.
   */
  async function persistRequestedCwd(
    plan: SpawnPlan,
    requested: string | undefined,
    persistCwd: boolean | undefined,
  ): Promise<void> {
    if (!persistCwd || requested === undefined) return;
    if (!plan.cwdFromOverride) {
      // The request did not survive resolution (a rename, an unmounted share,
      // an AV hold on `realpathSync` between the route's check and ours). The
      // spawn is about to run somewhere else; saying so is the whole point —
      // the user asked to move Claude permanently and it did not happen, and
      // this was the only untraced branch in a change whose purpose is
      // removing exactly that.
      console.error(
        `[Launcher] Requested working directory ${requested} could not be resolved — spawning in ${plan.cwd}, workingDirectory left unchanged`,
      );
      return;
    }
    await persistWorkingDirectory(plan.cwd);
  }

  function resolveCwd(
    integration: ClaudeCodeIntegration,
    override?: string,
  ): { cwd: string; fromOverride: boolean } {
    const candidate = override ?? (integration as { workingDirectory?: unknown }).workingDirectory;
    if (typeof candidate === "string") {
      const normalized = safeCwd(candidate);
      // `override !== undefined`, not truthiness: this must report which INPUT
      // was honored, and an empty-string override (rejected upstream by the
      // routes, but not by this function) would read as "no override".
      if (normalized) return { cwd: normalized, fromOverride: override !== undefined };
    }
    return { cwd: homeCwd(), fromOverride: false };
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

    const { cwd, fromOverride } = resolveCwd(integration, cwdOverride);
    const saved = readSavedSession();

    // The resume decision is made HERE, against the planned cwd, rather than at
    // each caller — see `sessionCwdMatches`. `spawnOnce` rewrites the session
    // file whenever `resuming` is false, so a mismatch self-heals.
    let sessionId: string;
    let resuming: boolean;
    if (saved !== undefined && sessionCwdMatches(saved.cwd, cwd)) {
      sessionId = saved.sessionId;
      resuming = true;
    } else {
      if (saved !== undefined) {
        console.error(
          `[Launcher] Saved session belongs to ${saved.cwd} — starting a fresh session in ${cwd}`,
        );
      }
      sessionId = randomUUID();
      resuming = false;
    }

    return { integration, cwd, cwdFromOverride: fromOverride, sessionId, resuming };
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
      writeSavedSession(plan.sessionId, plan.cwd);
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

    // --- Turn delivery -----------------------------------------------------
    //
    // The supervisor, not the channel shim, is what turns Tandem activity into
    // a Claude turn. Measured 2026-08-04 against a real binary
    // (docs/spikes/channel-push-stream-json.md): under these flags a channel
    // notification does NOT become a turn. The shim loads and receives the
    // event — `push.subscribers` rises while the child runs, and a raw read of
    // `/api/events` shows the frame — but the session then sits silent. An
    // aliveness control (a second turn written by hand onto the same idle
    // session, answered normally) rules out "the process was dead". So the
    // last hop is the broken one, and this is the replacement for it.
    //
    // In-process, by direct subscription: no SSE hop, no localhost round-trip,
    // and no dependence on the shim being installed at all.

    /** True between writing a turn and seeing that turn's `result` envelope. */
    let turnInFlight = false;
    /** An event arrived mid-turn; wake once the current turn finishes. */
    let pendingWake = false;
    let latchTimer: NodeJS.Timeout | null = null;

    function clearLatch(): void {
      turnInFlight = false;
      if (latchTimer) {
        clearTimeout(latchTimer);
        latchTimer = null;
      }
    }

    /** Write one user turn. Targets `spawned`, not `child`.
     *
     * Returns whether the write was even attempted. Callers must not treat a
     * `false` as delivered: a wake dropped here is a notification the user will
     * never get, and there is no error surface between here and them.
     *
     * Recovery is by retry, not by queueing, and that works only because the
     * wake carries no payload: `tandem_checkInbox` returns everything pending,
     * so ONE later successful wake subsumes every dropped one. A payload-
     * carrying design would have to buffer here instead. */
    function sendTurn(text: string): boolean {
      const stdin = spawned.stdin;
      if (!stdin?.writable) {
        console.error("[Launcher] Claude stdin not writable — turn not delivered");
        return false;
      }
      turnInFlight = true;
      if (latchTimer) clearTimeout(latchTimer);
      latchTimer = setTimeout(() => {
        latchTimer = null;
        // Not an error path we can distinguish from a legitimately long turn,
        // so log at a level that reads as diagnostic rather than failure.
        console.error("[Launcher] No result envelope within the wake window — assuming idle");
        turnInFlight = false;
        flushPendingWake();
      }, wakeLatchMs);
      stdin.write(serializeUserTurn(text), (err) => {
        if (!err) return;
        console.error("[Launcher] Failed to write turn:", err.message);
        // A failed write means the pipe is gone and the exit handler is about
        // to run. Drop the latch so it cannot outlive the write, and re-arm the
        // wake so the intent survives into the next spawn rather than dying
        // with this one. Do NOT retry against this stdin — it just refused.
        clearLatch();
        pendingWake = true;
      });
      return true;
    }

    /** Send the deferred wake, if one is owed and the session is idle.
     *
     * `pendingWake` is cleared only on a successful write. Clearing it first
     * would mean a failed flush silently consumed the notification: the flag is
     * the only record that a wake is owed, and nothing downstream would ever
     * re-raise it. */
    function flushPendingWake(): void {
      if (!pendingWake || turnInFlight) return;
      if (sendTurn(SUPERVISOR_WAKE_PROMPT)) pendingWake = false;
    }

    function onTandemEvent(event: TandemEvent): void {
      if (!isWakeWorthy(event)) return;
      // Coalesce rather than queue: the wake carries no payload, so N events
      // arriving mid-turn collapse to a single follow-up nudge. Claude reads
      // all of them at once via `tandem_checkInbox`.
      if (turnInFlight) {
        pendingWake = true;
        return;
      }
      // Keep the wake owed if the write could not be attempted, so the next
      // turn boundary — or the next spawn — retries it.
      if (!sendTurn(SUPERVISOR_WAKE_PROMPT)) pendingWake = true;
    }

    const unsubscribeFromEvents = subscribeToEvents(onTandemEvent);

    /**
     * Detach this spawn's event subscription and kill its latch timer.
     *
     * Deliberately NOT identity-guarded on `child === spawned`, unlike the
     * child-state resets in the same handlers: the subscription belongs to THIS
     * process whether or not a newer spawn has since replaced it. Skipping it
     * for a superseded spawn would leak the callback for the lifetime of the
     * server, writing wake turns into a dead pipe forever. Idempotent — `exit`
     * and `error` can both fire.
     */
    function teardownTurnDelivery(): void {
      unsubscribeFromEvents();
      // Hand an undelivered wake to the next spawn rather than dropping it —
      // this runs on crash-restart, not just on a deliberate stop.
      if (pendingWake) wakeOwedAcrossSpawns = true;
      pendingWake = false;
      clearLatch();
      // Identity-guarded: only drop the shared handle if it still points at
      // THIS spawn. A late exit from a superseded process must not clear the
      // successor's registration and leave it unreleasable by stopInternal.
      if (activeTurnDelivery?.spawned === spawned) activeTurnDelivery = null;
    }

    activeTurnDelivery = { spawned, teardown: teardownTurnDelivery };

    // Written on spawn, NOT gated on the CLI's `init` line. Measured against a
    // real `claude` binary on 2026-08-04 (docs/spikes/channel-push-stream-json.md):
    // under `-p --input-format stream-json` the CLI emits nothing at all until
    // it has received a turn, and `init` then follows the write by <1s. Gating
    // the write on `init` is therefore a deadlock — each side waits for the
    // other, and the observed result was a session that sat silent for 200s and
    // produced no output whatsoever.
    //
    // Still fresh-spawn only: a resumed session already carries its history, so
    // a second copy of the prompt would be a duplicate turn.
    //
    // (`init` is also emitted once PER TURN, not once per session, so it could
    // not have served as a one-shot session-ready signal even if it arrived
    // first.)
    //
    // A resumed session gets no bootstrap turn but IS subscribed above, so it
    // wakes on the next piece of Tandem activity. That is the whole reason the
    // resume path is not inert: before this subscription existed it depended on
    // channel push, which finding 2 of the spike shows does not arrive.
    if (!plan.resuming) {
      // The bootstrap prompt already tells Claude to call `tandem_checkInbox`,
      // which surfaces anything that accumulated while nothing was listening —
      // so it discharges any owed wake by itself.
      sendTurn(SUPERVISOR_INITIAL_PROMPT);
      wakeOwedAcrossSpawns = false;
    } else if (wakeOwedAcrossSpawns) {
      if (sendTurn(SUPERVISOR_WAKE_PROMPT)) wakeOwedAcrossSpawns = false;
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

      // A `result` envelope ends a turn, whatever its subtype — that is the
      // idleness signal wake coalescing runs on. Confirmed against a real
      // binary (spike, 2026-08-04): `result` follows every turn, and `init` is
      // re-emitted per turn rather than per session.
      if (parsed.type === "result") {
        clearLatch();

        // NOTE (#1267): `errors` is NOT confirmed to exist on the CLI's
        // `result` envelope — it can only be settled against a running `claude`
        // binary, and no `is_error` result was produced during the spike. Left
        // as-is deliberately; the branch is inert if the field never appears,
        // so guessing a different shape would be strictly worse. Note this is
        // logging only — it must not gate `clearLatch()` above, or an
        // unrecognised result shape would wedge wakes permanently.
        if (parsed.is_error && Array.isArray(parsed.errors)) {
          console.error(`[Claude] Output error: ${parsed.errors.join("; ")}`);
        }

        flushPendingWake();
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
      teardownTurnDelivery();
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
      teardownTurnDelivery();
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
    // Already given up — nothing to schedule, and re-entering would re-run the
    // trip branch's probe. One failed spawn can reach here TWICE: the "error"
    // and "exit" handlers both call this, and both firing for a single spawn is
    // why each carries its own `child === spawned` identity guard.
    if (breakerTripped) return;
    if (restartTimer) clearTimeout(restartTimer);

    // Circuit breaker: drop attempts older than the window, then check count.
    const now = Date.now();
    recentAttempts = recentAttempts.filter((t) => now - t < CIRCUIT_BREAKER_WINDOW_MS);
    recentAttempts.push(now);
    if (recentAttempts.length > CIRCUIT_BREAKER_MAX_ATTEMPTS) {
      breakerTripped = true;
      // Disambiguate WHY it crash-looped, because the two causes have opposite
      // remedies and the UI routes off this one field. A missing or unstartable
      // CLI needs the integration wizard; anything else (stale --resume session,
      // auth failure, OOM, bad plugin) needs a restart, and sending that user to
      // the wizard tells them to install software they already have.
      //
      // Probed once, here, rather than per status poll: it is a filesystem walk,
      // and the answer cannot change usefully mid-run anyway (the supervisor
      // spawns from the PATH this process started with). Synchronous, so this
      // and `breakerTripped` above land in the same tick — see `probeCliUsable`.
      // Guarded because this runs inside the child's "error"/"exit" handlers,
      // which Node calls synchronously from `emit()` with no try/catch in this
      // file. A throw there is not a failed diagnosis — it becomes an
      // `uncaughtException`, and `index.ts`'s handler exits the process for
      // anything that isn't a known Hocuspocus error. That would kill the whole
      // editor at the precise moment the launcher was trying to explain itself,
      // which is strictly worse than the bug this branch exists to fix. The
      // pre-change code could not throw here — it was one assignment — so the
      // guard is a cost of adding I/O, not defensive habit. `probeCliUsable` is
      // also an injection seam, so totality cannot be assumed from the default.
      //
      // Fails OPEN to `circuit-open`: a probe that could not run is not
      // evidence the CLI is missing, and "go install Claude Code" is the more
      // alarming and less recoverable of the two claims to make wrongly. This
      // is exactly the pre-change behaviour.
      let cliUsable = true;
      try {
        cliUsable = probeCliUsable();
      } catch (err) {
        console.error("[Launcher] CLI probe failed; reporting a plain crash loop:", err);
      }
      lastError = cliUsable ? "circuit-open" : "cli-unusable";
      console.error(
        `[Launcher] Circuit breaker tripped: ${recentAttempts.length} restart attempts in ${CIRCUIT_BREAKER_WINDOW_MS}ms — giving up. ${
          cliUsable
            ? "Restart Tandem to retry."
            : "The Claude CLI is missing or cannot be started — check the integration setup."
        }`,
      );
      return;
    }

    const delay = restartBackoffs[Math.min(restartIndex, restartBackoffs.length - 1)];
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
    // `buildPlan` yields, and `scheduleRestart` calls this function WITHOUT the
    // op lock — so a user `stop()` can complete during that await. It takes the
    // lock, finds `child` already null, and resolves successfully. Without this
    // re-check the restart then spawns anyway: `stop()` reported success and
    // Claude silently comes back, event subscription and all.
    if (stopRequested) {
      console.error("[Launcher] Stop requested while building the spawn plan — not spawning");
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

  // `newCwd` is optional for the same reason `startFresh`'s is: `buildPlan`
  // already falls back through the integration's `workingDirectory` to home, and
  // the chip CTAs fire from surfaces that legitimately have no document open.
  // Requiring one here is what made the empty state's safe recovery unreachable
  // while its session-destroying secondary kept working.
  async function relaunch(newCwd?: string, opts?: RelocateOpts): Promise<void> {
    return withLock(() => respawn(newCwd, opts, { clearSession: false }));
  }

  /** The stop+respawn sequence both public entry points perform. They differ by
   * exactly one statement — whether the saved session is dropped first — so the
   * flag is the API and everything else is shared.
   *
   * Callers wrap this in `withLock`; it must NOT lock itself (it awaits
   * `stopInternal`). Declared as a `function`, not a `const` arrow, because it
   * is referenced above its own definition and by `startFresh` below — a
   * `const` would be a TDZ error at the first user relaunch, not at typecheck.
   *
   * Statement order here is load-bearing and pinned by no single test:
   * `clearSavedSession` must precede `buildPlan` (or `startFresh` resumes the
   * session it was asked to drop), `stopRequested = false` must follow
   * `stopInternal`, and the persist must precede `spawnOnce`. */
  async function respawn(
    cwdOverride: string | undefined,
    opts: RelocateOpts | undefined,
    { clearSession }: { clearSession: boolean },
  ): Promise<void> {
    await stopInternal();
    if (clearSession) clearSavedSession();
    // relaunch/startFresh always mean "user is actively asking" → clear breaker.
    breakerTripped = false;
    recentAttempts = [];
    // stopInternal() raised the stop flag on the way in. Lower it before the
    // new spawn, or the exit handler treats the *next* crash as a deliberate
    // stop and silently declines to restart — the supervisor stays dead.
    stopRequested = false;
    const plan = await buildPlan(cwdOverride);
    if (!plan) return;
    await persistRequestedCwd(plan, cwdOverride, opts?.persistCwd);
    await spawnOnce(plan);
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
      releaseTurnDelivery();
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
    // Unconditional, and NOT left to the `exit` handler: the abandon branch
    // above reaches here with a process that is still alive and will never emit
    // `exit`, so this is the only release that runs on that path.
    releaseTurnDelivery();
    child = null;
    currentCwd = undefined;
    currentSessionId = undefined;
    currentResuming = false;
  }

  async function stop(): Promise<void> {
    return withLock(() => stopInternal());
  }

  async function startFresh(cwdOverride?: string, opts?: RelocateOpts): Promise<void> {
    return withLock(() => respawn(cwdOverride, opts, { clearSession: true }));
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
