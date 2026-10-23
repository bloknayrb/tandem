import { expect } from "vitest";

/**
 * `tools/list` over real HTTP, against a server started with
 * `startMcpServerHttp`.
 *
 * For suites that must see the PRODUCTION tool list: `createMcpServer` wraps
 * the SDK's `tools/list` handler (`schema-dialect.ts`) and registers every
 * tool group, so a test that assembled its own `McpServer` from a few
 * `register*Tools` calls would pass whether or not the factory does either.
 */

const MCP_ACCEPT = "application/json, text/event-stream";

export interface ListedTool {
  name: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/**
 * The transport answers with SSE, so the JSON-RPC payload is a `data:` line.
 *
 * Matched by request id rather than by taking the first frame: only one frame
 * rides this stream today, but a notification interleaved on it would otherwise
 * be parsed as the response and surface as a TypeError on `.tools` instead of a
 * readable failure.
 */
function parseRpc(body: string, id: number): Record<string, unknown> {
  const frames = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice("data:".length).trim()) as Record<string, unknown>);
  const match = frames.find((f) => f.id === id);
  expect(match, `no JSON-RPC frame with id ${id} in ${body}`).toBeDefined();
  return match as Record<string, unknown>;
}

/** Initialize a session on `baseUrl` and return its `tools/list` payload. */
export async function listToolsOverHttp(baseUrl: string): Promise<ListedTool[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
  };
  const init = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "tools-list-test", version: "1.0.0" },
      },
    }),
  });
  const sessionId = init.headers.get("mcp-session-id") ?? "";
  await init.text();
  expect(sessionId).not.toBe("");

  const withSession = { ...headers, "mcp-session-id": sessionId };
  await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: withSession,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).then((r) => r.text());

  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: withSession,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const rpc = parseRpc(await res.text(), 2);
  expect(rpc.result, `tools/list returned no result: ${JSON.stringify(rpc)}`).toBeDefined();
  return (rpc.result as { tools: ListedTool[] }).tools;
}
