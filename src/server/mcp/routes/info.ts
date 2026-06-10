import { stat } from "node:fs/promises";
import type { Request, Response } from "express";
import { isLoopback } from "../../auth/middleware.js";
import type { Handler } from "./_shared.js";

export interface InfoHandlerDeps {
  /** Running app version string (APP_VERSION from server.ts). */
  version: string;
  /** Number of MCP tools registered at startup. `null` if private SDK field shape drifted. */
  toolCount: number | null;
  /** MCP SDK version string, baked at build time. */
  mcpSdkVersion: string;
  /** Absolute path to session storage directory (env-paths data root + /sessions). */
  storagePath: string;
  /** Returns the absolute path to the auth token file. */
  getTokenFilePath: () => string;
  /**
   * Absolute path to CHANGELOG.md on disk, resolved at server startup.
   * Undefined if the file does not exist (e.g. stripped production builds).
   */
  changelogPath?: string;
  /**
   * Absolute path to docs/workflows.md on disk, resolved at server startup.
   * Undefined if the file does not exist (e.g. stripped production builds).
   */
  workflowsPath?: string;
  /** Active MCP transport mode. */
  transport?: "http" | "stdio";
  /**
   * This server run's generation id — clients pin it as their Hocuspocus auth
   * token so stale tabs from a previous run are rejected before their Y.Doc
   * state can merge back. Returns null before writeGenerationId() runs.
   */
  getGenerationId?: () => string | null;
  /** Bind host for HTTP transport (e.g. "127.0.0.1"). Undefined for stdio. */
  bindHost?: string;
  /** MCP HTTP port number. Undefined for stdio. */
  bindPort?: number;
}

/**
 * GET /api/info — returns app metadata for the client About panel.
 *
 * Public fields (always returned): version, toolCount, mcpSdkVersion, transport, changelogPath.
 * Sensitive fields (loopback-only): storagePath, tokenRotatedAt.
 */
export function makeInfoHandler(deps: InfoHandlerDeps): Handler {
  return async (req: Request, res: Response): Promise<void> => {
    const loopback = isLoopback(req.socket.remoteAddress);

    let tokenRotatedAt: number | null = null;
    if (loopback) {
      const tokenPath = deps.getTokenFilePath();
      try {
        const s = await stat(tokenPath);
        tokenRotatedAt = s.mtimeMs;
      } catch (err) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code === "ENOENT") {
          // Auth token file not yet created — normal on first install.
          tokenRotatedAt = null;
        } else {
          console.error("[Tandem] /api/info: failed to stat token file:", err);
          tokenRotatedAt = null;
        }
      }
    }

    const body: Record<string, unknown> = {
      version: deps.version,
      toolCount: deps.toolCount,
      mcpSdkVersion: deps.mcpSdkVersion,
      transport: deps.transport ?? "http",
    };

    if (deps.bindHost !== undefined) {
      body.bindHost = deps.bindHost;
    }
    if (deps.bindPort !== undefined) {
      body.bindPort = deps.bindPort;
    }

    // changelogPath is not sensitive — include whenever the file exists on disk.
    if (deps.changelogPath !== undefined) {
      body.changelogPath = deps.changelogPath;
    }

    // workflowsPath is not sensitive — include whenever the file exists on disk.
    if (deps.workflowsPath !== undefined) {
      body.workflowsPath = deps.workflowsPath;
    }

    if (loopback) {
      body.storagePath = deps.storagePath;
      body.tokenRotatedAt = tokenRotatedAt;
      // Loopback-only to match its consumer's reach: Hocuspocus binds 127.0.0.1,
      // so only loopback clients can ever use the generation token.
      body.generationId = deps.getGenerationId?.() ?? null;
    }

    res.json(body);
  };
}
