/**
 * tandem_diagnostics — agent-readable boot/connection health (#1174 gap #2).
 *
 * Wraps the existing `runDoctor()` collector (the same one behind the
 * `GET /api/diagnostics` HTTP route, `routes/diagnostics.ts`) in a read-only
 * MCP tool so a connected agent can self-diagnose a broken connection over its
 * OWN transport — without making a loopback HTTP call it may not be able to
 * make. A Cowork VM in particular cannot reach `localhost:3479` (ADR-023), so
 * the HTTP route is unreachable there; the MCP transport is the only channel
 * back to the host, and this tool rides it.
 *
 * Security: adds NO new HTTP surface. `runDoctor()` is a side-effect-free
 * collector; the MCP transport is already loopback-gated, the same posture
 * that lets `/api/diagnostics` return the full report (paths/PIDs/config URLs)
 * loopback-only. Read-only, so it is deliberately NOT wrapped in `gatedTool()`
 * — diagnostics must stay available even when the license gate is restricted
 * (the read-only escape hatch).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DoctorReport, RunDoctorOptions } from "../../cli/doctor.js";
import { runDoctor } from "../../cli/doctor.js";
import { DEFAULT_MCP_PORT, DEFAULT_WS_PORT } from "../../shared/constants.js";
import { diagnosticsOutputShape } from "./output-schemas.js";
import { mcpStructured, withErrorBoundary, withStructuredErrors } from "./response.js";
import { filterDevRepoChecks } from "./routes/diagnostics.js";

export interface DiagnosticsToolDeps {
  /** Running app version string (APP_VERSION from server.ts). */
  version?: string;
  /** Transport this server is serving — "http" for the sidecar, "stdio" legacy. */
  transport?: "http" | "stdio";
  /** Live Hocuspocus port (TANDEM_PORT-aware), threaded into the self-probe. */
  wsPort?: number;
  /** Live MCP HTTP port (TANDEM_MCP_PORT-aware), threaded into the self-probe. */
  mcpPort?: number;
  /** Diagnostic collector — injectable for tests. Defaults to {@link runDoctor}. */
  collect?: (opts: RunDoctorOptions) => Promise<DoctorReport>;
}

/**
 * Register the read-only `tandem_diagnostics` MCP tool on `server`.
 *
 * Mirrors the `/api/diagnostics` payload: the dev-repo-filtered `DoctorReport`
 * (node-modules / mcp-json checks dropped — the server cwd is arbitrary for a
 * desktop/global install) plus the runtime environment fields.
 */
export function registerDiagnosticsTools(server: McpServer, deps: DiagnosticsToolDeps = {}): void {
  const version = deps.version ?? "unknown";
  const transport = deps.transport ?? "http";
  const wsPort = deps.wsPort ?? DEFAULT_WS_PORT;
  const mcpPort = deps.mcpPort ?? DEFAULT_MCP_PORT;
  const collect = deps.collect ?? runDoctor;

  server.registerTool(
    "tandem_diagnostics",
    {
      description:
        "Read connection and boot health (Node version, config registration, port probes, " +
        "/health, SSE) as a structured report. No params. Use this to self-diagnose a broken " +
        "Tandem connection over MCP instead of asking the user to run `tandem doctor`.",
      inputSchema: {},
      outputSchema: diagnosticsOutputShape,
    },
    withStructuredErrors(
      withErrorBoundary("tandem_diagnostics", async () => {
        const report = filterDevRepoChecks(await collect({ wsPort, mcpPort }));
        return mcpStructured({
          ...report,
          version,
          transport,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          tauriSidecar: process.env.TANDEM_TAURI_SIDECAR === "1",
        });
      }),
    ),
  );
}
