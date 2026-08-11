import os from "node:os";
import type { Request, Response } from "express";
import type { DoctorReport, RunDoctorOptions } from "../../../cli/doctor.js";
import { runDoctor, summarizeDoctorResults } from "../../../cli/doctor.js";
import { isLoopback } from "../../auth/middleware.js";
import { collectHostInfo } from "../host-info.js";
import { escapeRegex } from "../response.js";
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

/** Recursively apply `scrub` to every string in a free-form value. */
function scrubDeep(value: unknown, scrub: (s: string) => string): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubDeep(v, scrub)]),
    );
  }
  return value;
}

/**
 * Replace the user's home directory with `~` everywhere in the report.
 *
 * Several checks interpolate absolute app-data paths — `doctor.ts` lines ~1420
 * ("Annotation store dir not yet created (${dir})", a *passing* check on the
 * common first run), ~1434, ~1497 and ~1535 — and `resolveAppDataDir()`
 * resolves those under `C:\Users\<username>\AppData\Local\…` or
 * `/Users/<username>/Library/…`. The username is the leak.
 *
 * This mattered less when Copy Diagnostics was the only consumer: a human chose
 * what to paste. The Report-a-bug link prefills a public issue body, which turns
 * that review step into an opt-out, so the redaction happens here instead.
 *
 * Walks the WHOLE report rather than enumerating `message`/`fix`. The per-check
 * `data` bag is free-form and several checks put the raw directory in it
 * (`annotation-store` carries `data.dir`), so a message-only pass leaves the
 * path on the wire — and enumerating fields means a new string field on
 * `DoctorResult` silently escapes redaction with nothing to fail. Rewriting
 * only the home prefix is safe on any string, so the general walk is both
 * shorter and closed.
 *
 * Note this is NOT `scrubPathForCaller` (`routes/_shared.ts`): that one is
 * caller-conditional (a loopback caller gets the real path) and reduces to a
 * basename. It would be a no-op here, since this route 403s every non-loopback
 * caller — and basenaming the report would destroy its diagnostic value. The
 * adversary is different: not a LAN peer, but the public issue the loopback
 * user is about to paste into.
 *
 * Applied to the HTTP route ONLY. The `tandem_diagnostics` MCP tool serves an
 * agent that may need to act on the real path, and it does not feed an issue
 * form. This does not change the route's loopback posture — PIDs, ports and
 * config URLs still make the full report unfit for a LAN caller.
 */
export function redactHomePaths(report: DoctorReport): DoctorReport {
  let home: string;
  try {
    home = os.homedir();
  } catch {
    return report;
  }
  // Guard against a root/empty homedir, where a blind replace would corrupt
  // every absolute path in the report. (`length < 2` already covers "/".)
  if (!home || home.length < 2 || /^[A-Za-z]:[/\\]?$/.test(home)) return report;

  const trimmed = home.replace(/[/\\]+$/, "");
  const variants = [...new Set([trimmed, trimmed.replace(/\\/g, "/")])];
  // Windows paths are case-insensitive and the drive letter's case varies by
  // which API produced the string.
  const flags = process.platform === "win32" ? "gi" : "g";
  // The lookahead requires the next character (if any) to be a separator, so a
  // short home like `/root` cannot swallow the prefix of an unrelated
  // `/rootfs/...`.
  const pattern = new RegExp(`(?:${variants.map(escapeRegex).join("|")})(?![^/\\\\])`, flags);

  return scrubDeep(report, (s) => s.replace(pattern, "~")) as DoctorReport;
}

/**
 * GET /api/diagnostics — embedded `tandem doctor` for the client's
 * "Copy diagnostics" button.
 *
 * Loopback-only, unconditionally: the report embeds absolute paths and PIDs —
 * and the unfiltered collector additionally sees MCP config URLs. (Home-dir
 * paths are `~`-redacted by {@link redactHomePaths} before they go on the wire,
 * because this payload reaches a public issue body; that narrows the leak, it
 * does not change the posture.) This is deliberately stricter than /api/info's
 * per-field stripping — there is no useful LAN subset of this report. The
 * hand-rolled check predates #1293, which made `assertLoopbackForMutation`
 * unconditional; either would work now, and this one is kept only because a
 * read route has no business importing a helper named "for mutation".
 * "Loopback-only" still includes every web origin
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
      const report = redactHomePaths(filterDevRepoChecks(await inFlight));
      res.json({
        report,
        version: deps.version,
        transport: deps.transport,
        ...collectHostInfo(),
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
