import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import type { Server } from "http";
import { createRequire } from "module";

import { DEFAULT_BIND_HOST, TAURI_HOSTNAME } from "../../shared/constants.js";
import { createAuthMiddleware, isLoopback } from "../auth/middleware.js";
import { openBrowser } from "../open-browser.js";
import { registerAnnotationTools } from "./annotations.js";
import { apiMiddleware, createApiMiddleware, registerApiRoutes } from "./api-routes.js";
import { registerAwarenessTools } from "./awareness.js";
import { registerChannelRoutes } from "./channel-routes.js";
import { registerDocumentTools } from "./document.js";
import { registerApplyTools } from "./docx-apply.js";
import { registerNavigationTools } from "./navigation.js";

const esmRequire = createRequire(import.meta.url);
let APP_VERSION = "0.0.0-unknown";
try {
  APP_VERSION = (esmRequire("../../package.json") as { version: string }).version;
} catch (err) {
  console.error(
    `[Tandem] Could not read version from package.json: ${err instanceof Error ? err.message : err}`,
  );
}

export { APP_VERSION };

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/server/ → dist/client/ (tsup bundles server into dist/server/index.js)
const CLIENT_DIST = join(__dirname, "../client");

// McpServer is long-lived (tool registrations survive close/reconnect).
// Transport is ephemeral — rotated on each new initialize request.
let mcpServer: McpServer | null = null;
let currentTransport: StreamableHTTPServerTransport | null = null;
let connectingPromise: Promise<void> | null = null;

/** Create an McpServer with all tool groups registered (no transport). */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "tandem",
    version: APP_VERSION,
  });

  registerDocumentTools(server);
  registerAnnotationTools(server);
  registerNavigationTools(server);
  registerAwarenessTools(server);
  registerApplyTools(server);

  return server;
}

/** Extract the JSON-RPC `id` from a request body (single message only, not batches). */
export function jsonrpcId(body: unknown): unknown {
  return body && typeof body === "object" && !Array.isArray(body) && "id" in body
    ? (body as Record<string, unknown>).id
    : null;
}

/** Send a JSON-RPC error response. */
function sendJsonRpcError(
  res: import("express").Response,
  status: number,
  code: number,
  message: string,
  id: unknown = null,
): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id });
}

/**
 * Tear down the current transport (if any) and connect a fresh one.
 * Serialized via connectingPromise so concurrent initialize requests
 * don't double-rotate.
 */
async function connectFreshTransport(): Promise<void> {
  if (!mcpServer) throw new Error("mcpServer not initialized");

  const doConnect = async () => {
    if (currentTransport) {
      console.error("[Tandem] Closing previous MCP transport session");
      await mcpServer!.close();
      currentTransport = null;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    await mcpServer!.connect(transport);
    currentTransport = transport;
    console.error("[Tandem] New MCP session established");
  };

  // Chain behind any in-flight rotation to prevent races
  const promise = (connectingPromise ?? Promise.resolve()).then(doConnect);
  connectingPromise = promise;
  await promise;
  // Release the lock once settled so the resolved promise can be GC'd
  if (connectingPromise === promise) connectingPromise = null;
}

/** Close the active MCP session (for graceful shutdown). */
export async function closeMcpSession(): Promise<void> {
  if (currentTransport && mcpServer) {
    await mcpServer.close();
    currentTransport = null;
  }
}

/** Start the MCP server on stdio (legacy, used as fallback via TANDEM_TRANSPORT=stdio). */
export async function startMcpServerStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Start the MCP server on HTTP using Streamable HTTP transport. Returns the http.Server for lifecycle management. */
export async function startMcpServerHttp(
  port: number,
  host = DEFAULT_BIND_HOST,
  token?: string,
  /**
   * Resolved LAN IP for the Host-header allowlist.
   * Passed when TANDEM_BIND_HOST is non-loopback so that browsers on the LAN
   * (which send e.g. `Host: 192.168.1.50:3479`) pass the DNS-rebinding check.
   * undefined for loopback binds — only localhost/127.0.0.1/tauri.localhost allowed.
   */
  resolvedLanIP?: string,
): Promise<Server> {
  mcpServer = createMcpServer();

  // We need two different body parser limits: 100kb for MCP (SDK default)
  // and 70MB for file upload API. createMcpExpressApp applies express.json()
  // globally with 100kb limit. Solution: create our own outer app, register
  // /api routes with a larger body parser, then mount the SDK app for /mcp.
  const { default: express } = await import("express");
  const app = express();

  // Auth middleware: validates Bearer token for all non-loopback requests.
  // Runs before per-route apiMiddleware; loopback bypass preserves DNS-rebinding
  // for loopback callers. Rate-limit and token checks apply to non-loopback
  // requests only.
  // Loopback (127.0.0.1, ::1, ::ffff:127.0.0.1) is always exempt —
  // Claude Code zero-config is preserved.
  //
  // Mutable ref: `POST /api/rotate-token` swaps the token without a server restart.
  const tokenRef = { current: token ?? null };
  const authMiddleware = createAuthMiddleware(() => tokenRef.current);

  // DNS-rebinding middleware: extend the Host-header allowlist with the resolved
  // LAN IP when binding non-loopback. For loopback binds resolvedLanIP is
  // undefined and this falls back to the standard localhost-only middleware.
  const lanAwareApiMiddleware = resolvedLanIP
    ? createApiMiddleware([resolvedLanIP])
    : apiMiddleware;

  // Large body parser for file-open and upload routes only (up to 70MB).
  // NOT mounted globally — other routes (MCP, /health) use the SDK's own parser.
  const largeBody = express.json({ limit: "70mb" });

  // SDK app provides express.json() (100kb limit) + DNS rebinding protection.
  // When binding non-loopback, pass allowedHosts so the SDK's hostHeaderValidation
  // activates for /mcp (port-agnostic hostname matching). This closes the
  // DNS-rebinding gap that would otherwise exist because authMiddleware's loopback
  // bypass runs before the SDK's host-header check on the inner mcpApp.
  // The SDK strips the port via URL.hostname, so we supply bare hostnames only.
  const allowedHosts = resolvedLanIP
    ? ["127.0.0.1", "localhost", "[::1]", resolvedLanIP, TAURI_HOSTNAME]
    : undefined;
  const mcpApp = createMcpExpressApp({ host, ...(allowedHosts ? { allowedHosts } : {}) });

  mcpApp.post("/mcp", async (req: import("express").Request, res: import("express").Response) => {
    const body = req.body as unknown;
    const isInit =
      isInitializeRequest(body) || (Array.isArray(body) && body.some(isInitializeRequest));

    if (isInit) {
      console.error("[Tandem] Received initialize request, rotating transport");
      try {
        await connectFreshTransport();
      } catch (err) {
        console.error("[Tandem] Failed to create new transport:", err);
        sendJsonRpcError(res, 500, -32603, "Internal error", jsonrpcId(body));
        return;
      }
    }

    if (!currentTransport) {
      sendJsonRpcError(res, 503, -32000, "No active session", jsonrpcId(body));
      return;
    }

    await currentTransport.handleRequest(req, res, body);
  });

  mcpApp.get("/mcp", async (req: import("express").Request, res: import("express").Response) => {
    if (!currentTransport) {
      sendJsonRpcError(res, 503, -32000, "No active session");
      return;
    }
    await currentTransport.handleRequest(req, res, req.body);
  });

  // DELETE — SDK handles session teardown internally
  mcpApp.delete("/mcp", async (req: import("express").Request, res: import("express").Response) => {
    if (!currentTransport) {
      sendJsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    await currentTransport.handleRequest(req, res, req.body);
    currentTransport = null;
  });

  // Auth middleware for /mcp and /api/* — AFTER apiMiddleware (DNS-rebinding)
  // but BEFORE route handlers. Loopback is always exempt (Claude Code zero-config).
  // /health and /.well-known/* are intentionally omitted — they're public/diagnostic.
  // Note: all channel routes use /api/channel-* paths (covered by /api below).
  app.use("/mcp", authMiddleware);
  app.use("/api", authMiddleware);

  // Health endpoint — lanAwareApiMiddleware protects against DNS rebinding.
  // Auth-exempt: health is public diagnostic info.
  // Invariant 7: omit hasSession when request is non-loopback (session presence leaks).
  app.get(
    "/health",
    lanAwareApiMiddleware,
    (req: import("express").Request, res: import("express").Response) => {
      const body: Record<string, unknown> = {
        status: "ok",
        version: APP_VERSION,
        transport: "http",
      };
      if (isLoopback(req.socket.remoteAddress)) {
        body.hasSession = currentTransport !== null;
      }
      res.json(body);
    },
  );

  // RFC 9728 Protected Resource Metadata — declares Bearer auth via header.
  // Newer Claude Code versions probe this before connecting to MCP.
  // resource uses literal "localhost" (invariant 6 — never req.host or a detected LAN IP).
  // Auth-exempt: these endpoints must be reachable before auth is established.
  app.get(
    "/.well-known/oauth-protected-resource/mcp",
    (_req: import("express").Request, res: import("express").Response) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.json({
        resource: `http://localhost:${port}/mcp`,
        bearer_methods_supported: ["header"],
        authorization_servers: [`http://localhost:${port}`],
      });
    },
  );
  app.get(
    "/.well-known/oauth-protected-resource",
    (_req: import("express").Request, res: import("express").Response) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.json({
        resource: `http://localhost:${port}/mcp`,
        bearer_methods_supported: ["header"],
        authorization_servers: [`http://localhost:${port}`],
      });
    },
  );

  // Mount SDK app (handles /mcp with 100kb body parser + DNS rebinding)
  app.use(mcpApp);

  // --- REST API for browser-initiated file opening ---
  registerApiRoutes(app, largeBody, token, lanAwareApiMiddleware, (newToken) => {
    tokenRef.current = newToken;
  });

  // --- Channel support endpoints ---
  registerChannelRoutes(app, lanAwareApiMiddleware);

  // Serve built client assets when present (populated by `vite build`).
  // express.static falls through for paths it doesn't find, so /mcp, /api/*,
  // /health, and channel routes registered above continue to work normally.
  // Static routes and SPA fallback intentionally omit apiMiddleware — they only serve
  // static assets, no sensitive data.
  if (existsSync(CLIENT_DIST)) {
    // Express 5 types omit express.static and res.sendFile — they exist at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use((express as any).static(CLIENT_DIST, { index: "index.html" }));
    // SPA fallback: serve index.html for client-side routes not matched above
    const indexPath = join(CLIENT_DIST, "index.html");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.get("/{*path}", (_req: import("express").Request, res: any) => {
      res.sendFile(indexPath);
    });
    console.error(`[Tandem] Serving client from ${CLIENT_DIST}`);
  } else {
    console.error(`[Tandem] No client dist at ${CLIENT_DIST} — run 'npm run build' first`);
  }

  return new Promise<Server>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      httpServer.on("error", (err: Error) => console.error("[Tandem] HTTP server error:", err));
      console.error(`[Tandem] MCP HTTP server on http://${host}:${port}/mcp`);
      if (process.env.TANDEM_OPEN_BROWSER === "1") {
        if (existsSync(CLIENT_DIST)) {
          openBrowser(`http://localhost:${port}`);
        } else {
          console.error("[Tandem] Skipping browser open — no client assets found");
        }
      }
      resolve(httpServer);
    });
    httpServer.on("error", reject);
  });
}
