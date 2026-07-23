/**
 * Proves the AsyncLocalStorage session context actually reaches a tool handler.
 *
 * `src/server/sessions/context.ts` argues, from a read of the SDK's dispatch
 * path, that a `run()` wrapping the awaited `transport.handleRequest` is still
 * bound by the time a `tools/call` handler executes. That argument is only an
 * argument — this file is the evidence.
 *
 * The decisive case is the CONCURRENT one. A module-level "current session"
 * variable would pass a sequential test and fail here: both handlers are
 * deliberately in flight at the same time (each awaits before reading the
 * context), so a shared mutable variable would hand both the id of whichever
 * request arrived last.
 *
 * Deliberately built from raw SDK pieces rather than `startMcpServerHttp`,
 * because no Tandem tool reads the context yet — the mechanism has to be
 * testable before its first consumer exists, or it ships unverified.
 */

import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCurrentSessionId, runWithMcpContext } from "../../src/server/sessions/context.js";
import { allocPort } from "../helpers/alloc-port.js";

const MCP_ACCEPT = "application/json, text/event-stream";

let httpServer: Server;
let baseUrl: string;
/** Session id → its live transport, mirroring the production registry. */
const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * A server whose single tool reports the session id it observed — after an
 * await, so the read happens on a later microtask than the dispatch.
 */
function buildProbeServer(): McpServer {
  const server = new McpServer({ name: "probe", version: "1.0.0" });
  server.tool("whoami", async () => {
    await new Promise((r) => setTimeout(r, 25));
    return { content: [{ type: "text" as const, text: getCurrentSessionId() ?? "<none>" }] };
  });
  return server;
}

beforeEach(async () => {
  transports.clear();
  const port = await allocPort();
  baseUrl = `http://127.0.0.1:${port}`;

  const app = express();
  app.use(express.json());
  app.post("/mcp", async (req, res) => {
    const body = req.body as unknown;
    const claudeSessionId =
      typeof req.headers["x-claude-session-id"] === "string"
        ? req.headers["x-claude-session-id"]
        : undefined;

    if (isInitializeRequest(body)) {
      const server = buildProbeServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          transports.set(sessionId, transport);
        },
      });
      await server.connect(transport);
      await runWithMcpContext({ claudeSessionId }, () => transport.handleRequest(req, res, body));
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "no session" } });
      return;
    }
    await runWithMcpContext({ claudeSessionId, mcpSessionId: sessionId }, () =>
      transport.handleRequest(req, res, body),
    );
  });

  httpServer = await new Promise<Server>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function openSession(claudeSessionId?: string): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
  };
  if (claudeSessionId) headers["X-Claude-Session-Id"] = claudeSessionId;

  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "probe-client", version: "1.0.0" },
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id") ?? "";
  await res.text();

  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.text());

  return sessionId;
}

/** Call `whoami` and return the session id the handler observed. */
async function whoami(sessionId: string, claudeSessionId?: string): Promise<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
    "mcp-session-id": sessionId,
  };
  if (claudeSessionId) headers["X-Claude-Session-Id"] = claudeSessionId;

  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  });
  const raw = await res.text();
  // The response arrives as an SSE frame; pull the JSON-RPC payload out of it.
  const line = raw.split("\n").find((l) => l.startsWith("data: "));
  const parsed = JSON.parse(line ? line.slice(6) : raw) as {
    result?: { content?: Array<{ text?: string }> };
  };
  return parsed.result?.content?.[0]?.text ?? "<unparsed>";
}

describe("MCP session context", () => {
  it("delivers the calling Claude session id to a tool handler", async () => {
    const s = await openSession("claude-aaa");
    expect(await whoami(s, "claude-aaa")).toBe("claude-aaa");
  });

  it("reports <none> when the caller carries no Claude session id", async () => {
    // The direct-HTTP config path. Tools must see "unknown", not a stale id
    // left behind by some other session.
    const s = await openSession();
    expect(await whoami(s)).toBe("<none>");
  });

  it("keeps contexts separate across CONCURRENT calls from different sessions", async () => {
    // The load-bearing case. Both handlers await before reading, so their
    // executions overlap; a module-level "current session" variable would give
    // both the same answer here.
    const a = await openSession("claude-aaa");
    const b = await openSession("claude-bbb");

    const [ra, rb] = await Promise.all([whoami(a, "claude-aaa"), whoami(b, "claude-bbb")]);

    expect(ra).toBe("claude-aaa");
    expect(rb).toBe("claude-bbb");
  });

  it("does not leak context between an identified and an unidentified session", async () => {
    const a = await openSession("claude-aaa");
    const b = await openSession();

    const [ra, rb] = await Promise.all([whoami(a, "claude-aaa"), whoami(b)]);

    expect(ra).toBe("claude-aaa");
    expect(rb).toBe("<none>");
  });

  it("leaves no ambient context outside a request", () => {
    expect(getCurrentSessionId()).toBeUndefined();
  });
});
