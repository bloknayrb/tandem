import type { Request, Response } from "express";

import { API_SHUTDOWN } from "../../../shared/api-paths.js";
import { isLoopback } from "../../auth/middleware.js";
import { isLocalhostOrigin } from "../api-routes.js";
import type { Handler } from "./_shared.js";

/** Dependencies injected by the entry point (`src/server/index.ts`). */
export interface ShutdownRouteDeps {
  /**
   * Triggers the same graceful shutdown sequence as SIGTERM/SIGINT
   * (`shutdown()` in src/server/index.ts): unwatchAll → stopAutoSave →
   * autoSaveAllToDisk (5s-bounded) → saveCurrentSession → closeMcpSession →
   * process.exit(0). The index.ts implementation is idempotent (its
   * `isShuttingDown` guard), and the route adds its own one-shot guard so the
   * function is invoked at most once per process regardless of repeat POSTs.
   */
  requestShutdown: (reason: string) => void;
}

/**
 * POST /api/shutdown (#1088) — graceful shutdown trigger for the Tauri shell.
 *
 * `restart_sidecar` (and the updater's pre-install stop) POST here before
 * falling back to a hard `child.kill()`, so up to ~60s of edits since the
 * last autosave tick get flushed to disk and the session snapshot stays in
 * sync with the surviving WebView. Responds 202 immediately; the
 * process-exiting shutdown runs only after the response has been fully
 * handed to the socket.
 */
export function makeShutdownHandler(deps: ShutdownRouteDeps): Handler {
  let invoked = false;
  return (req: Request, res: Response): void => {
    // 1. Unconditional loopback gate — deliberately STRICTER than
    // assertLoopbackForMutation (which only activates under
    // TANDEM_ALLOW_UNAUTHENTICATED_LAN=1). A process-kill endpoint must never
    // be reachable from the network, even by a caller holding a valid Bearer
    // token on a TANDEM_BIND_HOST LAN bind: remote shutdown is a DoS
    // primitive the LAN opt-in did not consent to, and the only legitimate
    // caller (the Tauri shell's reqwest client) is always loopback.
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: `${API_SHUTDOWN} is loopback-only.`,
      });
      return;
    }

    // 2. CSRF gate: when an Origin header IS present (browser caller), it
    // must be on the localhost/Tauri allowlist — same check the mutating
    // integration routes use. An ABSENT Origin is allowed: the primary caller
    // is the Tauri shell's reqwest client (sends no Origin header), and
    // browsers always attach Origin to cross-site POSTs, so a missing Origin
    // cannot be a CSRF vector.
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin !== undefined && !isLocalhostOrigin(origin)) {
      res.status(403).json({
        error: "FORBIDDEN",
        message: `Origin not allowlisted for ${API_SHUTDOWN}`,
      });
      return;
    }

    const alreadyInProgress = invoked;
    if (!alreadyInProgress) {
      invoked = true;
      // Defer the (process-exiting) shutdown until the 202 response has been
      // fully handed to the socket, so the caller's HTTP request is never
      // killed mid-flight. "close" fires after "finish" on normal completion
      // and also when the connection terminates prematurely — either way the
      // response is out of our hands by then.
      res.once("close", () => deps.requestShutdown(API_SHUTDOWN));
    }
    res.status(202).json({ data: { shuttingDown: true, alreadyInProgress } });
  };
}
