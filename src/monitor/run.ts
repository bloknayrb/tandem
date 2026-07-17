/**
 * Tandem Monitor runtime — shared by the standalone binary entry
 * (`src/monitor/index.ts`, built to `dist/monitor/index.js`) and the
 * `tandem monitor` CLI subcommand (`npx -y tandem-editor@<version> monitor`).
 *
 * Connects to the Tandem server's /api/events SSE endpoint and prints
 * formatted event lines to stdout. Each line becomes a Claude Code
 * notification automatically via the plugin monitor mechanism. Replaces the
 * channel shim for event delivery without requiring
 * --dangerously-load-development-channels.
 *
 * This module deliberately carries NO auto-run block — the `isDirectRun`
 * guard lives only in the thin `src/monitor/index.ts` standalone entry. That
 * split is load-bearing: the CLI imports this runtime, and in the bundled
 * `dist/cli/index.js` the auto-run's `process.argv[1] === import.meta.url`
 * comparison would be TRUE (both resolve to the CLI bundle), so keeping the
 * auto-run out of the imported module is what prevents `tandem monitor` from
 * running `main()` twice (double SSE subscription → doubled events). Mirrors
 * the `src/channel/run.ts` vs `src/channel/index.ts` split.
 *
 * **STDOUT IS RESERVED** (CLAUDE.md rule #3). The only writes to stdout are
 * the formatted event notification inside the `onEvent` callback and the
 * exhaustion notice inside `main`. Everything else — including anything that
 * would otherwise call `console.log/warn/info` — is redirected to stderr by
 * the guard immediately below. When adding a new dependency, grep its source
 * for `process.stdout.write` and `console.log` before accepting; a
 * stdout-writing dep bundled into this file would corrupt the plugin-host
 * line protocol silently.
 *
 * All retry / SSE-frame / awareness / mode-cache logic lives in the shared
 * `src/shared/sse-consumer.ts` module (extracted in #282). This file is the
 * thin stdout-aware adapter that owns the delivery callback, the EPIPE
 * handler, and the SIGINT/SIGTERM shutdown drain.
 */

import { resolveTandemUrl } from "../shared/cli-runtime.js";
import { formatEventContent } from "../shared/events/types.js";
import {
  _resetSseConsumerStateForTests,
  _addOutstandingAwarenessForTests as _sharedAddOutstandingAwarenessForTests,
  getCachedMode as _sharedGetCachedMode,
  _getLastDocumentIdForTests as _sharedGetLastDocumentIdForTests,
  getModeSync as _sharedGetModeSync,
  _setLastDocumentIdForTests as _sharedSetLastDocumentIdForTests,
  connectAndStreamOnce,
  type EventConsumerOptions,
  flushFinalAwareness,
  runEventConsumer,
} from "../shared/sse-consumer.js";
import { MONITOR_CONNECT_FAILED, type TandemMode } from "../shared/types.js";

const IS_VITEST = process.env.VITEST === "true";

// Guard the redirect so test imports don't pollute vitest's console routing.
if (!IS_VITEST) {
  console.log = console.error;
  console.warn = console.error;
  console.info = console.error;
}

// Resolved at module-load time. Tests that mutate URL env vars must
// `vi.resetModules()` and dynamic-import this module to pick up changes.
const TANDEM_URL = resolveTandemUrl();
const LOG_PREFIX = "[Monitor]";

function buildOptions(): EventConsumerOptions {
  return {
    tandemUrl: TANDEM_URL,
    logPrefix: LOG_PREFIX,
    errorCode: MONITOR_CONNECT_FAILED,
    onEvent: (event) => {
      // Collapse newlines so multi-line content stays as a single
      // notification (each stdout line is delivered separately).
      const content = formatEventContent(event).replace(/\n/g, " ");
      // False-checkpoint guard: the shared consumer advances lastEventId
      // only AFTER `onEvent` resolves without throwing. EPIPE on
      // process.stdout is almost always async — Node emits 'error' after
      // the close; see installStdoutErrorHandler, which calls
      // process.exit(1) so the plugin host respawns us. A synchronous
      // throw (rare) propagates out and the retry layer handles it.
      process.stdout.write(content + "\n");
    },
    onExhaustion: () => {
      // Visible-to-Claude-Code notification. stderr is invisible to the
      // plugin host, so the user would otherwise see events just stop
      // with no signal.
      process.stdout.write(
        "Tandem monitor disconnected — restart Tandem to restore real-time events\n",
      );
    },
  };
}

export async function main(): Promise<void> {
  installShutdownHandlers();
  installStdoutErrorHandler();
  console.error(`${LOG_PREFIX} Tandem monitor starting (server: ${TANDEM_URL})`);

  // Warm the mode cache before the first event so we don't default-suppress
  // or default-deliver under an unknown user setting.
  await getCachedMode().catch(() => {
    // Already logged inside getCachedMode; continue with fail-closed default
  });

  await runEventConsumer(buildOptions());
}

/**
 * Single-attempt SSE consumer. Re-exported via a thin wrapper that injects
 * the monitor's stdout delivery so the existing per-attempt tests
 * (`sse-parsing`, `solo-filter`, `mode-cache`, `sse-timeout`, `retry`) keep
 * exercising the same surface.
 */
export async function connectAndStream(
  lastEventId: string | undefined,
  onEventId: (id: string) => void,
  onStable: () => void = () => {},
): Promise<void> {
  return connectAndStreamOnce(buildOptions(), lastEventId, { onEventId, onStable });
}

/** Called on SIGINT/SIGTERM and from tests. Flushes awareness then exits. */
export async function shutdownMonitor(signal: string): Promise<void> {
  console.error(`${LOG_PREFIX} Received ${signal}, clearing awareness and exiting`);
  const ok = await flushFinalAwareness(TANDEM_URL, LOG_PREFIX);
  process.exit(ok ? 0 : 1);
}

/** Exposed for testing only — seeds the lastDocumentId that shutdown reads. */
export function _setLastDocumentIdForTests(id: string | null): void {
  _sharedSetLastDocumentIdForTests(id);
}

/** Exposed for testing only — reads the last document id that shutdown would send. */
export function _getLastDocumentIdForTests(): string | null {
  return _sharedGetLastDocumentIdForTests();
}

/** Exposed for testing only — seeds an outstanding awareness POST so the
 *  shutdown test can assert the drain-before-exit behavior. */
export function _addOutstandingAwarenessForTests(p: Promise<unknown>): void {
  _sharedAddOutstandingAwarenessForTests(p);
}

function installShutdownHandlers(): void {
  // Never install real signal handlers under vitest — tests drive
  // shutdownMonitor() directly. Prevents listener accumulation and
  // stray real-SIGINT mid-test process.exit.
  if (IS_VITEST) return;
  const handler = (signal: string) => {
    shutdownMonitor(signal).catch((err) => {
      console.error(`${LOG_PREFIX} Shutdown handler failed:`, err);
      process.exit(1);
    });
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

/**
 * Async EPIPE handler. `process.stdout.write` does NOT synchronously throw
 * on EPIPE — Node emits an 'error' event asynchronously when the downstream
 * pipe (plugin host) closes its read end mid-stream. Without this handler,
 * writes after the close are silently dropped and the retry loop keeps
 * advancing lastEventId past events that never arrived; the next reconnect's
 * Last-Event-ID header then skips the lost range. Logging to stderr keeps a
 * trail for support; exit 1 so the plugin host respawns us with a fresh
 * stdout instead of wedging on a dead pipe.
 */
function onStdoutError(err: Error): void {
  console.error(`${LOG_PREFIX} stdout error (plugin-host pipe likely closed):`, err);
  process.exit(1);
}

function installStdoutErrorHandler(): void {
  if (IS_VITEST) return;
  process.stdout.on("error", onStdoutError);
}

// --- Mode cache re-exports (preserve existing public surface) ---

/**
 * Get the current collaboration mode, with a 2s TTL cache. Fail-closed
 * to "solo" on any failure. Wraps the shared cache so existing callers
 * (and tests) don't need to know about the underlying module.
 */
export async function getCachedMode(): Promise<TandemMode> {
  return _sharedGetCachedMode(TANDEM_URL, LOG_PREFIX);
}

/** Sync reader — always returns the last known mode. Use on the hot path. */
export function getModeSync(): TandemMode {
  return _sharedGetModeSync();
}

/**
 * Testing-only. Resets module-level state so tests within a single file
 * don't contaminate each other. Also strips any process signal handlers
 * registered by previous main() calls to prevent listener accumulation
 * (Node emits MaxListenersExceededWarning after 10).
 *
 * DO NOT call this from production code.
 */
export function _resetMonitorStateForTests(): void {
  _resetSseConsumerStateForTests();
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
}

/**
 * Test-only exports. DO NOT import from production code.
 * Grouped in a single namespace so production imports never accidentally
 * pull handler internals.
 */
export const _monitorTestExports = {
  onStdoutError,
};
