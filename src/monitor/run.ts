/**
 * Tandem Monitor runtime — shared by the standalone binary entry
 * (`src/monitor/index.ts`, built to `dist/monitor/index.js`) and the
 * `tandem monitor` CLI subcommand (`npx -y tandem-editor@<version> monitor`).
 *
 * Connects to the Tandem server's /api/events SSE endpoint and prints one
 * PAYLOAD-FREE wake line to stdout per WAKE-WORTHY event — annotations and
 * chat, the same `isWakeWorthy` set every other push path uses; `document:*`
 * tab churn is consumed but not printed. Each line becomes a Claude Code
 * notification automatically via the plugin monitor mechanism. An alternative
 * to the channel shim for event delivery in a hand-launched session, without
 * requiring --dangerously-load-development-channels.
 *
 * "Payload-free" is the contract, not an implementation detail — see the long
 * comment on `onEvent`. The event payload is still consumed inside this
 * process (awareness attribution needs `documentId`); it just never reaches
 * the model.
 *
 * "Flagless" is not "unconditional": the plugin host spawns monitors through a
 * non-login shell, so this process inherits whatever PATH Claude Code itself
 * started with. A GUI-launched Claude Code frequently has no resolvable Node
 * and the monitor dies `exit 127` — every time it is armed, which since #1354
 * means every session that dispatched the Tandem skill rather than every
 * session on the machine. See docs/spikes/plugin-delivery.md.
 * Neither transport is involved in an auto-launched session; those are woken
 * over the supervisor's stdin (ADR-047).
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
 * the wake line inside the `onEvent` callback and the exhaustion notice
 * inside `main`. Everything else — including anything that
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
import { isWakeWorthy } from "../shared/events/wake-scope.js";
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
      // PAYLOAD-FREE, and deliberately so — ADR-049 decision 2. This line
      // becomes an unsolicited `<task_notification>` turn, so anything printed
      // here is content pushed at a model that did not ask for it. Until
      // #1354 this printed `formatEventContent(event)`: the annotation body, a
      // verbatim document slice (`textSnippet`), chat text, selected text, the
      // filename, and `[doc: <documentId>]` — which `docIdFromPath` builds as
      // `<basename-slug>-<hash>`, i.e. a filename in all but name.
      //
      // Three reasons it is a wake and not a report, in ascending order:
      //  1. A line with no content cannot leak content, so a future regression
      //     in `shouldForwardExternally` costs timing rather than the user's
      //     words. The sharpest case is a `.docx` import: Word comment bodies
      //     land as notes, and "Send to Claude" promotes them onto this emit
      //     branch, so third-party file text reached this channel after one
      //     click, with only `\n`→space applied to it.
      //  2. A model that answers from the payload never calls
      //     `tandem_checkInbox`, so the item is never marked surfaced and is
      //     re-reported on the next wake.
      //  3. Wakes are lossy under load — a 25-event burst reached the socket
      //     in full while at least 7 never became notifications. Answering
      //     from a payload means answering from a partial view.
      //
      //     Cite this one carefully: it was measured on the SELF-ARMED `ws`
      //     watch (docs/spikes/monitor-self-arm-probe.md), not on this path.
      //     It transfers because the loss is in the half the two paths SHARE —
      //     the manifest contributes no delivery machinery of its own, it
      //     produces the same `kind:"monitor"` task with the same
      //     stdout→`task_notification` delivery and the same host-side rate
      //     limiter (which emits `[plugin monitor "…" suppressed N events —
      //     output rate exceeded]` here, in code, 2.1.226). But a burst has
      //     NOT been run on this path: plugin-monitor-tty-activation.md lists
      //     it under "what is still not established". Reasons 1 and 2 stand
      //     alone and do not need it.
      //
      // `event.type` is not content: it is the same field `toWakeFrame` keeps.
      //
      // The monitor still consumes the FULL stream rather than
      // `?filter=wake`, because `flushAwareness` needs `event.documentId` to
      // attribute the "Claude is processing" indicator to a document, and a
      // wake frame carries none. The payload stays inside this process and
      // never reaches the model. If per-document awareness is ever dropped
      // here, switching the request to `?filter=wake` is the remaining step.
      //
      // CONSUMING the full stream is not EMITTING on all of it. `document:*`
      // lifecycle fires whenever the user clicks a tab, and every other push
      // path drops it (`isWakeWorthy` — supervisor stdin, `?filter=wake`,
      // `/api/wake`). This one printed it, which mattered less when the line
      // was descriptive; now that it says "call tandem_checkInbox", each tab
      // click becomes a forced turn that can only discover there was nothing
      // to do. And the cost is not just the wasted turn: those lines spend the
      // same host rate limiter that reason 3 above says silently drops wakes,
      // so navigation noise can push out the annotation the user is waiting on.
      if (!isWakeWorthy(event)) return;
      const content = `Tandem: ${event.type} — call tandem_checkInbox for details`;
      // False-checkpoint guard: the shared consumer advances lastEventId
      // only AFTER `onEvent` resolves without throwing. EPIPE on
      // process.stdout is almost always async — Node emits 'error' after
      // the close; see installStdoutErrorHandler, which exits (the host does
      // NOT respawn us — measured; see that function's note). A synchronous
      // throw (rare) propagates out and the retry layer handles it.
      process.stdout.write(content + "\n");
    },
    onExhaustion: ({ everConnected }) => {
      // Visible-to-Claude-Code notification. stderr is invisible to the
      // plugin host, so a user whose stream really dropped would otherwise
      // see events just stop with no signal.
      //
      // But ONLY when we actually had a stream.
      //
      // The original argument for that was population-based: the host armed
      // this monitor in EVERY session (`when: "always"`) while a desktop user
      // runs Tandem occasionally, so a never-connected run was usually a
      // session with nothing to do with Tandem. #1354 inverted that premise —
      // arming now follows a Tandem skill dispatch, so a never-connected run
      // means the user asked for Tandem and Tandem was not reachable, which is
      // a case where "restart Tandem" is at least on-topic.
      //
      // Silence is still right, for reasons that never depended on the
      // population:
      //   - Nothing was lost. The line says "restore real-time events", which
      //     presupposes events were flowing; none ever were.
      //   - The model finds out far better by calling any `tandem_*` tool,
      //     which fails with a real error naming the real problem.
      //   - A monitor that exits is never respawned (spike F9), so this line
      //     would be the last thing this process ever says — a claim that
      //     stays in context after it stops being true.
      if (!everConnected) return;
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
 * trail for support; exit rather than wedge on a dead pipe.
 *
 * **This used to say "exit 1 so the plugin host respawns us with a fresh
 * stdout". It does not.** Measured 2026-08-09 on CC 2.1.226
 * (`scripts/spikes/probe-monitor-respawn.py`): a monitor that exits is not
 * respawned, and the exit code makes no difference — 0 and 1 both stayed dead
 * for the rest of the session. So this is a clean shutdown, not a recovery:
 * once the host's read end closes, that session has no monitor again until it
 * is restarted. Exiting is still right — a monitor that cannot write cannot
 * deliver, and continuing would advance `lastEventId` past events nobody
 * received — but do not build anything on the respawn that isn't there.
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
