/**
 * Integration tests for concurrent MCP sessions (#438 §3.2).
 *
 * These exercise the actual regression the transport registry fixes: before it,
 * a second `initialize` closed the first client's transport, so the first
 * client's next tool call 404'd with an unknown session id. Two Claude Code
 * sessions could not coexist.
 *
 * Driven over real HTTP against `startMcpServerHttp` so the SDK's own session
 * validation is in the loop — a fake transport would prove nothing here.
 */

import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeMcpSession,
  getPinnedMcpSessionCount,
  reapIdleMcpSessions,
  startMcpServerHttp,
} from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";

let httpServer: Server;
let port: number;
let baseUrl: string;

const MCP_ACCEPT = "application/json, text/event-stream";

function initBody(clientName: string) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0.0" },
    },
  };
}

/** Perform a full initialize handshake and return the minted session id. */
async function openSession(
  clientName: string,
  claudeSessionId?: string,
): Promise<{ sessionId: string; status: number }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
  };
  if (claudeSessionId) headers["X-Claude-Session-Id"] = claudeSessionId;

  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(initBody(clientName)),
  });
  const sessionId = res.headers.get("mcp-session-id") ?? "";
  // Drain so the SSE stream closes and the socket is released.
  await res.text();

  // MCP lifecycle: the client confirms initialization before issuing requests.
  if (sessionId) {
    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).then((r) => r.text());
  }
  return { sessionId, status: res.status };
}

/** Issue a tools/list against a given session id. */
async function toolsList(sessionId: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: MCP_ACCEPT,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  return { status: res.status, body: await res.text() };
}

beforeEach(async () => {
  port = await allocPort();
  baseUrl = `http://127.0.0.1:${port}`;
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
});

afterEach(async () => {
  // Closing the http.Server alone leaves the session registry populated and
  // the idle reaper running, so state would carry into the next test and each
  // test would add another interval. closeMcpSession() undoes both.
  await closeMcpSession();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe("concurrent MCP sessions", () => {
  it("mints a distinct session id per initialize", async () => {
    const a = await openSession("client-a");
    const b = await openSession("client-b");

    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("keeps the first session usable after a second client initializes", async () => {
    // The core regression: this used to 404 because initialize #2 tore down
    // transport #1.
    const a = await openSession("client-a");
    await openSession("client-b");

    const res = await toolsList(a.sessionId);
    expect(res.status).toBe(200);
    expect(res.body).toContain("tandem_");
  });

  it("serves both sessions' tool calls independently", async () => {
    const a = await openSession("client-a");
    const b = await openSession("client-b");

    const [ra, rb] = await Promise.all([toolsList(a.sessionId), toolsList(b.sessionId)]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
  });

  it("404s an unknown session id instead of reporting the server has no session", async () => {
    await openSession("client-a");
    const res = await toolsList("not-a-real-session-id");

    expect(res.status).toBe(404);
    // -32001 "Session not found", not -32000 "No active session": a stale id
    // means re-initialize, not "the server is down".
    expect(res.body).toContain("-32001");
  });

  it("DELETE tears down only the targeted session", async () => {
    const a = await openSession("client-a");
    const b = await openSession("client-b");

    const del = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { Accept: MCP_ACCEPT, "mcp-session-id": a.sessionId },
    });
    expect(del.status).toBeLessThan(500);

    expect((await toolsList(a.sessionId)).status).toBe(404);
    expect((await toolsList(b.sessionId)).status).toBe(200);
  });

  it("leaves the session alive when the SDK rejects the DELETE", async () => {
    // A DELETE carrying a valid session id but a stale/unsupported
    // Mcp-Protocol-Version fails the SDK's own validateProtocolVersion check,
    // which responds 4xx *without* tearing the session down. The route must
    // not force-close it anyway -- that would strand a client that still
    // holds a perfectly valid session.
    const a = await openSession("client-a");

    const del = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        Accept: MCP_ACCEPT,
        "mcp-session-id": a.sessionId,
        "mcp-protocol-version": "1999-01-01",
      },
    });
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect(del.status).toBeLessThan(500);

    const res = await toolsList(a.sessionId);
    expect(res.status).toBe(200);
    expect(res.body).toContain("tandem_");
  });

  it("reports hasSession on loopback /health once a session exists", async () => {
    const before = (await (await fetch(`${baseUrl}/health`)).json()) as { hasSession?: boolean };
    expect(before.hasSession).toBe(false);

    await openSession("client-a");

    const after = (await (await fetch(`${baseUrl}/health`)).json()) as { hasSession?: boolean };
    expect(after.hasSession).toBe(true);
  });

  it("accepts an initialize with no X-Claude-Session-Id (direct-HTTP config path)", async () => {
    // The shipped Claude Code CLI entry is `{type:"http"}` with static headers,
    // so it carries no session id. That must remain a fully working client.
    const a = await openSession("client-a");
    expect(a.sessionId).toBeTruthy();
    expect((await toolsList(a.sessionId)).status).toBe(200);
  });

  it("accepts an initialize carrying X-Claude-Session-Id (stdio-bridge path)", async () => {
    const a = await openSession("client-a", "claude-session-uuid-1");
    expect((await toolsList(a.sessionId)).status).toBe(200);
  });
});

describe("an open standalone stream pins its session against the reaper", () => {
  /**
   * Run the real reap pass with every session treated as stale. The default TTL
   * is 30 minutes, so an un-overridden pass would reap nothing here and the
   * assertions would pass vacuously.
   */
  async function forceReap(): Promise<number> {
    // `lastSeenAt < now - 0` is a strict comparison, so give the clock a tick
    // to move off the last request.
    await new Promise((r) => setTimeout(r, 5));
    return reapIdleMcpSessions(0);
  }

  /**
   * Open a real `GET /mcp` stream and hold it. Resolves once the response
   * headers are in, i.e. once the server has run the route and marked the
   * stream open. The returned `close()` aborts it and waits for the server to
   * observe the close.
   */
  async function openStream(
    sessionId: string,
  ): Promise<{ status: number; close: () => Promise<void> }> {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { Accept: MCP_ACCEPT, "mcp-session-id": sessionId },
      signal: controller.signal,
    });
    return {
      status: res.status,
      close: async () => {
        controller.abort();
        await res.body?.cancel().catch(() => {});
        // Let the server's `res.on("close")` land before asserting on it.
        await new Promise((r) => setTimeout(r, 250));
      },
    };
  }

  afterEach(() => {
    // A leak here is silent — it shows up only as sessions that quietly stop
    // being reapable, right up until the 16-session cap is hit.
    expect(getPinnedMcpSessionCount()).toBe(0);
  });

  it("survives a forced reap while an unattached session does not", async () => {
    const attached = await openSession("attached-client");
    const quiet = await openSession("quiet-client");
    const stream = await openStream(attached.sessionId);
    expect(stream.status).toBe(200);
    expect(getPinnedMcpSessionCount()).toBe(1);

    // The exact pass the 5-minute interval runs, with everything treated as
    // stale. Building a separate registry would assert something weaker about
    // a path the route never touches.
    expect(await forceReap()).toBe(1);

    // The attached client is still usable; the quiet one is gone.
    expect((await toolsList(attached.sessionId)).status).toBe(200);
    expect((await toolsList(quiet.sessionId)).status).toBe(404);

    await stream.close();
  });

  it("becomes reapable again once the stream closes", async () => {
    const session = await openSession("closing-client");
    const stream = await openStream(session.sessionId);
    expect(await forceReap()).toBe(0);

    await stream.close();
    expect(getPinnedMcpSessionCount()).toBe(0);
    expect(await forceReap()).toBe(1);
    expect((await toolsList(session.sessionId)).status).toBe(404);
  });

  it("does not leave a session pinned when the SDK rejects a second stream", async () => {
    // The SDK allows one standalone stream per session and answers 409 for the
    // second. Registering the close listener before handleRequest is what makes
    // that path balance: `res` is still open, so `close` is guaranteed to fire.
    const session = await openSession("double-stream-client");
    const first = await openStream(session.sessionId);
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { Accept: MCP_ACCEPT, "mcp-session-id": session.sessionId },
    });
    await second.text();
    expect(second.status).toBe(409);
    // The rejected stream must not have decremented the survivor's pin.
    expect(await forceReap()).toBe(0);
    expect(getPinnedMcpSessionCount()).toBe(1);

    await first.close();
    expect(await forceReap()).toBe(1);
  });

  it("does not pin an unknown session id", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { Accept: MCP_ACCEPT, "mcp-session-id": "not-a-session" },
    });
    await res.text();
    expect(res.status).toBe(404);
    expect(getPinnedMcpSessionCount()).toBe(0);
  });
});
