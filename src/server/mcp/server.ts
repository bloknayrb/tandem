import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";
import type { Server } from "http";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require("../../../package.json") as { version: string };
export { APP_VERSION };
import { CTRL_ROOM, Y_MAP_AWARENESS, Y_MAP_CHAT } from "../../shared/constants.js";
import type { ClaudeAwareness } from "../../shared/types.js";
import { generateMessageId } from "../../shared/utils.js";
import { MCP_ORIGIN } from "../events/queue.js";
import { sseHandler } from "../events/sse.js";
import { getOrCreateDocument } from "../yjs/provider.js";
import { registerAnnotationTools } from "./annotations.js";
import { registerAwarenessTools } from "./awareness.js";
import { registerDocumentTools } from "./document.js";
import { detectFormat } from "./document-model.js";
import { openFileByPath, openFileFromContent } from "./file-opener.js";
import { registerNavigationTools } from "./navigation.js";

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

  return server;
}

/** Extract the JSON-RPC `id` from a request body (single message only, not batches). */
export function jsonrpcId(body: unknown): unknown {
  return body && typeof body === "object" && !Array.isArray(body) && "id" in body
    ? (body as Record<string, unknown>).id
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

  /** CORS + DNS rebinding protection middleware for /api/* routes */
  function apiMiddleware(
    req: import("express").Request,
    res: import("express").Response,
    next: import("express").NextFunction,
  ): void {
    if (!isHostAllowed(req.headers.host as string | undefined)) {
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
  function sendApiError(res: import("express").Response, err: unknown): void {
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
  app.post(
    "/api/open",
    apiMiddleware,
    largeBody,
    async (req: import("express").Request, res: import("express").Response) => {
      const { filePath } = (req.body ?? {}) as Record<string, unknown>;
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
    },
  );

  app.options("/api/upload", apiMiddleware);
  app.post(
    "/api/upload",
    apiMiddleware,
    largeBody,
    async (req: import("express").Request, res: import("express").Response) => {
      const { fileName, content } = (req.body ?? {}) as Record<string, unknown>;
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
    },
  );

  // --- Channel support endpoints ---

  // SSE event stream for channel shim
  app.get("/api/events", apiMiddleware, sseHandler);

  // Channel awareness: shim posts Claude's status for browser StatusBar
  app.options("/api/channel-awareness", apiMiddleware);
  app.post(
    "/api/channel-awareness",
    apiMiddleware,
    (req: import("express").Request, res: import("express").Response) => {
      const { documentId, status, active, focusParagraph } = (req.body ?? {}) as Record<
        string,
        unknown
      >;
      if (typeof status !== "string") {
        res.status(400).json({ error: "BAD_REQUEST", message: "status is required" });
        return;
      }
      // Write to the document's Y.Map('awareness') so the browser StatusBar updates
      const docId = typeof documentId === "string" ? documentId : null;
      if (docId) {
        const doc = getOrCreateDocument(docId);
        const awarenessMap = doc.getMap(Y_MAP_AWARENESS);
        const state: ClaudeAwareness = {
          status: status as string,
          timestamp: Date.now(),
          active: active === true,
          focusParagraph: typeof focusParagraph === "number" ? focusParagraph : null,
        };
        doc.transact(() => awarenessMap.set("claude", state), MCP_ORIGIN);
      }
      res.json({ ok: true, written: !!docId });
    },
  );

  // Channel error: shim reports errors for browser display
  app.options("/api/channel-error", apiMiddleware);
  app.post(
    "/api/channel-error",
    apiMiddleware,
    (req: import("express").Request, res: import("express").Response) => {
      const { error, message } = (req.body ?? {}) as Record<string, unknown>;
      console.error(`[Channel] Error: ${error} — ${message}`);
      // Could broadcast to browser via Y.Map in the future
      res.json({ ok: true });
    },
  );

  // Channel reply: shim forwards Claude's chat replies
  app.options("/api/channel-reply", apiMiddleware);
  app.post(
    "/api/channel-reply",
    apiMiddleware,
    (req: import("express").Request, res: import("express").Response) => {
      const { text, documentId, replyTo } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof text !== "string") {
        res.status(400).json({ error: "BAD_REQUEST", message: "text is required" });
        return;
      }
      const ctrlDoc = getOrCreateDocument(CTRL_ROOM);
      const chatMap = ctrlDoc.getMap(Y_MAP_CHAT);
      const id = generateMessageId();
      const msg = {
        id,
        author: "claude" as const,
        text: text as string,
        timestamp: Date.now(),
        ...(typeof documentId === "string" ? { documentId } : {}),
        ...(typeof replyTo === "string" ? { replyTo } : {}),
        read: true,
      };
      ctrlDoc.transact(() => chatMap.set(id, msg), MCP_ORIGIN);
      res.json({ sent: true, messageId: id });
    },
  );

  // Channel permission relay: shim forwards Claude Code's tool approval prompts
  // Pending requests stored for browser polling (SSE push to browser is a follow-up)
  const pendingPermissions = new Map<
    string,
    {
      requestId: string;
      toolName: string;
      description: string;
      inputPreview: string;
      createdAt: number;
    }
  >();
  const PERMISSION_TTL_MS = 30_000; // Stale after 30s (terminal answer already won)

  app.options("/api/channel-permission", apiMiddleware);
  app.post(
    "/api/channel-permission",
    apiMiddleware,
    (req: import("express").Request, res: import("express").Response) => {
      const { requestId, toolName, description, inputPreview } = (req.body ?? {}) as Record<
        string,
        unknown
      >;
      if (typeof requestId !== "string" || typeof toolName !== "string") {
        res.status(400).json({ error: "BAD_REQUEST", message: "requestId and toolName required" });
        return;
      }
      pendingPermissions.set(requestId as string, {
        requestId: requestId as string,
        toolName: toolName as string,
        description: (description as string) ?? "",
        inputPreview: (inputPreview as string) ?? "",
        createdAt: Date.now(),
      });
      console.error(
        `[Channel] Permission request: ${toolName} — ${description} (id: ${requestId})`,
      );
      res.json({ ok: true });
    },
  );

  // Browser polls for pending permission requests
  app.get(
    "/api/channel-permission",
    apiMiddleware,
    (_req: import("express").Request, res: import("express").Response) => {
      // Evict stale requests before returning
      const now = Date.now();
      for (const [id, perm] of pendingPermissions) {
        if (now - perm.createdAt > PERMISSION_TTL_MS) pendingPermissions.delete(id);
      }
      res.json({ pending: Array.from(pendingPermissions.values()) });
    },
  );

  // Browser submits verdict
  app.options("/api/channel-permission-verdict", apiMiddleware);
  app.post(
    "/api/channel-permission-verdict",
    apiMiddleware,
    (req: import("express").Request, res: import("express").Response) => {
      const { requestId, approved } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof requestId !== "string") {
        res.status(400).json({ error: "BAD_REQUEST", message: "requestId is required" });
        return;
      }
      pendingPermissions.delete(requestId as string);
      // Store verdict for the channel shim to poll (or push via SSE in follow-up)
      console.error(`[Channel] Permission verdict: ${requestId} → ${approved ? "allow" : "deny"}`);
      res.json({ ok: true, requestId, behavior: approved ? "allow" : "deny" });
    },
  );

  // Claude Code launcher
  app.options("/api/launch-claude", apiMiddleware);
  app.post(
    "/api/launch-claude",
    apiMiddleware,
    async (_req: import("express").Request, res: import("express").Response) => {
      try {
        const { launchClaude } = await import("./launcher.js");
        const result = launchClaude();
        res.json(result);
      } catch (err) {
        console.error("[Tandem] Failed to launch Claude:", err);
        res.status(500).json({
          error: "LAUNCH_FAILED",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

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
