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
}

/**
 * GET /api/info — returns app metadata for the client About panel.
 *
 * Public fields (always returned): version, toolCount, mcpSdkVersion, transport.
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
      transport: "http",
    };

    if (loopback) {
      body.storagePath = deps.storagePath;
      body.tokenRotatedAt = tokenRotatedAt;
    }

    res.json(body);
  };
}
