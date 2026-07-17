import type { Request, Response } from "express";
import type { DoctorReport, RunDoctorOptions } from "../../../cli/doctor.js";
import { runDoctor, summarizeDoctorResults } from "../../../cli/doctor.js";
import { isLoopback } from "../../auth/middleware.js";
import type { Handler } from "./_shared.js";

/**
 * Checks that read `process.cwd()` and only make sense in a dev-repo checkout.
 * For a Tauri/npm-global user the server's cwd is arbitrary, so these would
 * FAIL on every field report and bury the real signal under two false
 * failures. `tandem doctor` (CLI) keeps them — there the cwd is meaningful.
 *
 * `npm-staleness`, `orphaned-vite` and `dev-repo` self-gate on
 * `probeTandemEditorRepo(cwd) === "yes"` and so are usually absent here
 * anyway — but that is NOT a substitute for listing them. The self-gate is a
 * property of the cwd, not of the caller: an end user whose cwd happens to be
 * a tandem-editor checkout (or, for `dev-repo`, merely holds an unreadable
 * package.json) would otherwise have cwd-dependent findings recomputed into
 * /api/diagnostics and Copy Diagnostics. This list is the contract; the gate
 * is an optimization.
 */
const DEV_REPO_CHECKS = new Set([
  "node-modules",
  "mcp-json",
  "npm-staleness",
  "orphaned-vite",
  "dev-repo",
]);

export interface DiagnosticsHandlerDeps {
  /** Running app version string (APP_VERSION from server.ts). */
  version: string;
  /** Always "http" today — only startMcpServerHttp registers this route
   *  (stdio mode mounts no REST API). */
  transport: "http";
  /** Live Hocuspocus port (TANDEM_PORT-aware), threaded into the self-probe. */
  wsPort: number;
  /** Live MCP HTTP port (TANDEM_MCP_PORT-aware), threaded into the self-probe. */
  mcpPort: number;
  /** Diagnostic collector — injectable for tests. Defaults to {@link runDoctor}. */
  collect?: (opts: RunDoctorOptions) => Promise<DoctorReport>;
}

/** Drop dev-repo-only checks and recompute the report's aggregate fields. */
export function filterDevRepoChecks(report: DoctorReport): DoctorReport {
  const results = report.results.filter((res) => !DEV_REPO_CHECKS.has(res.check));
  const failures = results.filter((res) => res.status === "fail").length;
  const warnings = results.filter((res) => res.status === "warn").length;
  return {
    ok: failures === 0,
    crashed: report.crashed,
    failures,
    warnings,
    summary: summarizeDoctorResults(failures, warnings),
    error: report.error,
    results,
  };
}

/**
 * GET /api/diagnostics — embedded `tandem doctor` for the client's
 * "Copy diagnostics" button.
 *
 * Loopback-only, unconditionally: the report embeds absolute paths (which
 * include the username) and PIDs — and the unfiltered collector additionally
 * sees MCP config URLs. This is deliberately stricter than /api/info's
 * per-field stripping — there is no useful LAN subset of this report. Note
 * `assertLoopbackForMutation` would NOT work here: it is a no-op outside the
 * unauthenticated-LAN opt-in. "Loopback-only" still includes every web origin
 * served from this machine (any 127.0.0.1:* page passes the socket check and
 * the CORS allowlist) — same accepted posture as /api/info, richer payload.
 *
 * Single-flight: concurrent requests share one in-flight collector run. The
 * collector self-probes the server's own ports (with timeouts), so without
 * this a burst of requests would amplify into a burst of self-probes.
 */
export function makeDiagnosticsHandler(deps: DiagnosticsHandlerDeps): Handler {
  const collect = deps.collect ?? runDoctor;
  let inFlight: Promise<DoctorReport> | null = null;

  return async (req: Request, res: Response): Promise<void> => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Loopback only." });
      return;
    }

    try {
      if (!inFlight) {
        inFlight = collect({ wsPort: deps.wsPort, mcpPort: deps.mcpPort }).finally(() => {
          inFlight = null;
        });
      }
      const report = filterDevRepoChecks(await inFlight);
      res.json({
        report,
        version: deps.version,
        transport: deps.transport,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        tauriSidecar: process.env.TANDEM_TAURI_SIDECAR === "1",
      });
    } catch (err) {
      // Check crashes propagate out of runDoctor (only runDoctorCli converts
      // them to a crashed report). Keep the wire generic; the real error goes
      // to the server log.
      console.error("[Tandem] /api/diagnostics failed:", err);
      res.status(500).json({ error: "diagnostics failed" });
    }
  };
}
