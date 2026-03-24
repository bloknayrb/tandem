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
function jsonrpcId(body: unknown): unknown {
  return body && typeof body === "object" && !Array.isArray(body) && "id" in body
    ? (body as any).id
    : null;
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
  const app = createMcpExpressApp({ host });

  app.post("/mcp", async (req: any, res: any) => {
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

  app.get("/mcp", async (req: any, res: any) => {
    if (!currentTransport) {
      sendJsonRpcError(res, 503, -32000, "No active session");
      return;
    }
    await currentTransport.handleRequest(req, res, req.body);
  });

  // DELETE — SDK handles session teardown internally via handleDeleteRequest,
  // which closes the transport and triggers Protocol._onclose().
  app.delete("/mcp", async (req: any, res: any) => {
    if (!currentTransport) {
      sendJsonRpcError(res, 404, -32001, "Session not found");
      return;
    }
    await currentTransport.handleRequest(req, res, req.body);
    currentTransport = null;
  });

  app.get("/health", (_req: unknown, res: { json: (body: unknown) => void }) => {
    res.json({ status: "ok", transport: "http", hasSession: currentTransport !== null });
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
