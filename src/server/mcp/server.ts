import type { Server } from "http";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerDocumentTools } from "./document.js";
import { registerAnnotationTools } from "./annotations.js";
import { registerNavigationTools } from "./navigation.js";
import { registerAwarenessTools } from "./awareness.js";
import { openFileByPath, openFileFromContent } from "./file-opener.js";
import { detectFormat } from "./document-model.js";

// McpServer is long-lived (tool registrations survive close/reconnect).
// Transport is ephemeral — rotated on each new initialize request.
let mcpServer: McpServer | null = null;
let currentTransport: StreamableHTTPServerTransport | null = null;
let connectingPromise: Promise<void> | null = null;

/** Create an McpServer with all tool groups registered (no transport). */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "tandem",
    version: "0.1.0",
  });

  registerDocumentTools(server);
  registerAnnotationTools(server);
  registerNavigationTools(server);
  registerAwarenessTools(server);

  return server;
}

/** Extract the JSON-RPC `id` from a request body (single message only, not batches). */
export function jsonrpcId(body: unknown): unknown {
  return body && typeof body === "object" && !Array.isArray(body) && "id" in body
    ? (body as any).id
    : null;
}

/** Check if a Host header value is allowed (localhost only). Exported for testing. */
export function isHostAllowed(host: string | undefined): boolean {
  const reqHost = (host ?? "").split(":")[0];
  return reqHost === "localhost" || reqHost === "127.0.0.1";
}

/** Check if an Origin header is a localhost URL. Exported for testing. */
export const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
export function isLocalhostOrigin(origin: string | undefined): boolean {
  return LOCALHOST_ORIGIN_RE.test(origin ?? "");
}

/** Map error code to HTTP status. Exported for testing. */
export function errorCodeToHttpStatus(code: string | undefined): number {
  switch (code) {
    case "ENOENT":
    case "FILE_NOT_FOUND":
      return 404;
    case "INVALID_PATH":
    case "UNSUPPORTED_FORMAT":
      return 400;
    case "FILE_TOO_LARGE":
      return 413;
    case "EBUSY":
    case "EPERM":
      return 423;
    case "EACCES":
      return 403;
    default:
      return 500;
  }
}

/** Send a JSON-RPC error response. */
function sendJsonRpcError(
  res: any,
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

  // /api routes need large bodies — register parser BEFORE SDK app
  app.use("/api", express.json({ limit: "70mb" }) as any);

  // SDK app provides express.json() (100kb limit) + DNS rebinding protection
  const mcpApp = createMcpExpressApp({ host });

  mcpApp.post("/mcp", async (req: any, res: any) => {
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

  mcpApp.get("/mcp", async (req: any, res: any) => {
    if (!currentTransport) {
      sendJsonRpcError(res, 503, -32000, "No active session");
      return;
    }
    await currentTransport.handleRequest(req, res, req.body);
  });

  // DELETE — SDK handles session teardown internally
  mcpApp.delete("/mcp", async (req: any, res: any) => {
    if (!currentTransport) {
      sendJsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    await currentTransport.handleRequest(req, res, req.body);
    currentTransport = null;
  });

  mcpApp.get("/health", (_req: any, res: any) => {
    res.json({ status: "ok", transport: "http", hasSession: currentTransport !== null });
  });

  // Mount SDK app (handles /mcp, /health with 100kb body parser)
  app.use(mcpApp);

  // --- REST API for browser-initiated file opening ---

  /** CORS + DNS rebinding protection middleware for /api/* routes */
  function apiMiddleware(req: any, res: any, next: any): void {
    if (!isHostAllowed(req.headers.host)) {
      res.status(403).json({ error: "FORBIDDEN", message: "Host not allowed." });
      return;
    }
    const origin = req.headers.origin as string | undefined;
    res.header("Access-Control-Allow-Origin", isLocalhostOrigin(origin) ? origin! : "null");
    res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  }

  /** Map error codes from file-opener to HTTP responses */
  function sendApiError(res: any, err: unknown): void {
    const e = err as NodeJS.ErrnoException;
    const code = e.code ?? "";
    const msg = e.message ?? String(err);
    if (code === "ENOENT" || code === "FILE_NOT_FOUND") {
      res.status(404).json({ error: "FILE_NOT_FOUND", message: msg });
    } else if (code === "INVALID_PATH") {
      res.status(400).json({ error: "INVALID_PATH", message: msg });
    } else if (code === "UNSUPPORTED_FORMAT") {
      res.status(400).json({ error: "UNSUPPORTED_FORMAT", message: msg });
    } else if (code === "FILE_TOO_LARGE") {
      res.status(413).json({ error: "FILE_TOO_LARGE", message: msg });
    } else if (code === "EBUSY" || code === "EPERM") {
      res.status(423).json({ error: "FILE_LOCKED", message: "File is locked by another program." });
    } else if (code === "EACCES") {
      res.status(403).json({ error: "PERMISSION_DENIED", message: msg });
    } else {
      console.error("[Tandem] Unhandled API error:", err);
      res.status(500).json({ error: "INTERNAL", message: msg });
    }
  }

  app.options("/api/open", apiMiddleware);
  app.post("/api/open", apiMiddleware, async (req: any, res: any) => {
    const { filePath } = req.body ?? {};
    if (!filePath || typeof filePath !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "filePath is required" });
      return;
    }
    try {
      const result = await openFileByPath(filePath);
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  });

  app.options("/api/upload", apiMiddleware);
  app.post("/api/upload", apiMiddleware, async (req: any, res: any) => {
    const { fileName, content } = req.body ?? {};
    if (!fileName || typeof fileName !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "fileName is required" });
      return;
    }
    if (content === undefined || content === null) {
      res.status(400).json({ error: "BAD_REQUEST", message: "content is required" });
      return;
    }
    if (typeof content !== "string") {
      res.status(400).json({ error: "BAD_REQUEST", message: "content must be a base64 string" });
      return;
    }
    try {
      const format = detectFormat(fileName);
      const decoded = format === "docx" ? Buffer.from(content, "base64") : String(content);
      const result = await openFileFromContent(fileName, decoded);
      res.json({ data: result });
    } catch (err: unknown) {
      sendApiError(res, err);
    }
  });

  return new Promise<Server>((resolve, reject) => {
    const httpServer = app.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      httpServer.on("error", (err: Error) => console.error("[Tandem] HTTP server error:", err));
      console.error(`[Tandem] MCP HTTP server on http://${host}:${port}/mcp`);
      resolve(httpServer);
    });
    httpServer.on("error", reject);
  });
}
