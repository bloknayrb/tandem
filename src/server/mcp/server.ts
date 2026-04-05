import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import type { Server } from "http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "module";

import { openBrowser } from "../open-browser.js";
import { registerAnnotationTools } from "./annotations.js";
import { apiMiddleware, registerApiRoutes } from "./api-routes.js";
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
export async function startMcpServerHttp(port: number, host = "127.0.0.1"): Promise<Server> {
  mcpServer = createMcpServer();

  // We need two different body parser limits: 100kb for MCP (SDK default)
  // and 70MB for file upload API. createMcpExpressApp applies express.json()
  // globally with 100kb limit. Solution: create our own outer app, register
  // /api routes with a larger body parser, then mount the SDK app for /mcp.
  const { default: express } = await import("express");
  const app = express();

  // Large body parser for file-open and upload routes only (up to 70MB).
  // NOT mounted globally — other routes (MCP, /health) use the SDK's own parser.
  const largeBody = express.json({ limit: "70mb" });

  // SDK app provides express.json() (100kb limit) + DNS rebinding protection
  const mcpApp = createMcpExpressApp({ host });

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

  // Health endpoint on outer app (bypasses SDK's DNS rebinding middleware)
  app.get("/health", (_req: import("express").Request, res: import("express").Response) => {
    res.json({
      status: "ok",
      version: APP_VERSION,
      transport: "http",
      hasSession: currentTransport !== null,
    });
  });

  // RFC 9728 Protected Resource Metadata — declares no auth required.
  // Newer Claude Code versions probe this before connecting to MCP.
  app.get(
    "/.well-known/oauth-protected-resource/mcp",
    (_req: import("express").Request, res: import("express").Response) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.json({
        resource: `http://localhost:${port}/mcp`,
        bearer_methods_supported: [],
      });
    },
  );
  app.get(
    "/.well-known/oauth-protected-resource",
    (_req: import("express").Request, res: import("express").Response) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.json({
        resource: `http://localhost:${port}/mcp`,
        bearer_methods_supported: [],
      });
    },
  );

  // Mount SDK app (handles /mcp with 100kb body parser + DNS rebinding)
  app.use(mcpApp);

  // --- REST API for browser-initiated file opening ---
  registerApiRoutes(app, largeBody);

  // --- Channel support endpoints ---
  registerChannelRoutes(app, apiMiddleware);

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
