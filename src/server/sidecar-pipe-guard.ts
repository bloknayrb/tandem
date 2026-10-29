/**
 * The desktop sidecar's stdout/stderr are pipes whose read ends only the Tauri
 * shell holds (tauri-plugin-shell drains them on reader threads). When the
 * shell dies without stopping the sidecar — a `kill -9`, a crash — those read
 * ends close, and the sidecar's next write fails with EPIPE (#1988).
 *
 * Unhandled, that error event becomes an `uncaughtException`, and it was worse
 * than a crash. Measured 2026-10-28 with a stand-in parent holding the three
 * pipes and then `kill -9`'d: on the following SIGTERM, `shutdown()` logged,
 * the write failed, `handleFatalError` saw the shutdown latch and logged
 * "(ignored)" — which failed again — and the process spun at 100% CPU,
 * never exiting and never releasing the store lock. On Linux the shell's
 * parent-death signal (`src-tauri/src/sidecar_anchor.rs`) sends exactly that
 * SIGTERM, so without this guard the fix would have turned an idle orphan into
 * a busy one.
 *
 * Installed only when this process is the Tauri sidecar (`isTauriSidecar`,
 * keyed on argv): an npm `tandem` writing to a closed terminal keeps Node's
 * default behaviour. On EPIPE the shell is gone — while it lives, its reader
 * threads hold the read ends until EOF — so `onShellGone` runs once, and
 * `index.ts` wires it to `shutdown()`. That also means a macOS orphan, which
 * gets no parent-death signal, exits at its first log line after the shell
 * died rather than living on until the next launch reclaims its ports. Every
 * other error on these two streams is swallowed: there is nowhere left to
 * report it, and rethrowing would re-enter the loop above.
 */

interface ErrorEmitter {
  on(event: "error", listener: (err: NodeJS.ErrnoException) => void): unknown;
}

export function installSidecarPipeGuard(
  streams: readonly ErrorEmitter[],
  onShellGone: () => void,
): void {
  let fired = false;
  for (const stream of streams) {
    stream.on("error", (err) => {
      if (err?.code !== "EPIPE" || fired) return;
      fired = true;
      onShellGone();
    });
  }
}
