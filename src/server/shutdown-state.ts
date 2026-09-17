/**
 * Whether this process has begun shutting down.
 *
 * A leaf module rather than a `let` in `index.ts` because `/health` needs to
 * read it and `index.ts` imports the MCP server, not the other way round.
 *
 * **Why `/health` cares (#1758 review).** `shutdown()` closes the HTTP listener
 * LAST — after up to 5s of `autoSaveAllToDisk`, up to 2s of
 * `shutdownSearchWorker`, `launcherSupervisor.stop()` and `releaseStoreLock()`.
 * For that whole window a dying server still answers `/health` with a real
 * `pid` and `version`, so `probeTandemInstance` classified it as live and the
 * *replacement* process refused to start: Ctrl-C `dev:server` and re-run it
 * within ~7s, or any supervisor that SIGTERMs then respawns, and startup
 * printed "quit the running one first" — advice the user had already followed.
 *
 * The fix is on the `status` FIELD, deliberately, and not on the HTTP status
 * code or the listener's lifetime. The Tauri shell's `wait_for_server_gone`
 * (`src-tauri/src/sidecar.rs`) treats *any* non-2xx — and any connect failure —
 * as "the sidecar has exited" and then hard-kills the child. Flipping to 503,
 * or closing the listener before the flush, would therefore truncate the very
 * flush the graceful stop exists to perform. A 200 whose `status` is
 * `"shutting-down"` keeps the shell waiting for the real exit while telling a
 * would-be successor that this instance is on its way out.
 */
let shuttingDown = false;

/** True once {@link markShuttingDown} has been called. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Latch the shutdown flag. Idempotent, and returns whether THIS call was the
 * one that latched it — `shutdown()` uses that as its single-flight guard.
 */
export function markShuttingDown(): boolean {
  if (shuttingDown) return false;
  shuttingDown = true;
  return true;
}

/** Tests only: reset the module-level latch between cases. */
export function resetShutdownStateForTests(): void {
  shuttingDown = false;
}
