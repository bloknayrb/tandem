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
  /**
   * Absolute path to sample/welcome.md on disk, resolved at server startup.
   * Undefined if the file does not exist (e.g. stripped production builds).
   * Consumed by the "Replay tutorial" affordance to reopen the welcome doc.
   */
  welcomePath?: string;
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
 * Public fields (always returned): version, toolCount, mcpSdkVersion, transport,
 * changelogPath, workflowsPath, welcomePath.
 * Sensitive fields (loopback-only): storagePath, tokenRotatedAt, generationId.
 *
 * #1294 note — this route deliberately does NOT apply `scrubPathForCaller` to
 * the three `*Path` fields, and it is the one documented exception to that
 * convention. They are absolute install paths, so they do disclose the username
 * and install layout to a token-holding LAN caller. They are still sent whole
 * because the client hands each one straight back to `POST /api/open`
 * ("View Changelog", "Replay tutorial", the About panel's workflows link) — a
 * basename would not resolve, so scrubbing them breaks those buttons for every
 * non-loopback browser rather than hardening anything the caller could not
 * already learn from `/api/info`'s version + platform. Recorded as an accepted
 * residual rather than left as the earlier "…is not sensitive" comments, which
 * were simply false.
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

    // These three are absolute and unscrubbed on purpose — see the accepted
    // residual in the handler docstring above. Include whenever the file exists.
    if (deps.changelogPath !== undefined) {
      body.changelogPath = deps.changelogPath;
    }
    if (deps.workflowsPath !== undefined) {
      body.workflowsPath = deps.workflowsPath;
    }
    if (deps.welcomePath !== undefined) {
      body.welcomePath = deps.welcomePath;
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
