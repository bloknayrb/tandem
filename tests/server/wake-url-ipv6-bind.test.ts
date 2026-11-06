/**
 * A `::1`-bound server hands a loopback client a `wakeUrl` it can reach.
 *
 * ADR-056 accepts `TANDEM_BIND_HOST=::1` as a loopback bind, and on it the HTTP
 * server listens on `[::1]:<port>` only. The wake URL used to be
 * `ws://127.0.0.1:<port>/api/wake` whatever the bind, which on `::1` names an
 * address nothing of ours listens on: the `Monitor` watch connects to nothing
 * (or to an unrelated service on that port) and looks armed. And even with the
 * right URL, `isHostAllowed` parsed `Host: [::1]:<port>` as "[" and refused the
 * upgrade, every `/api` route, and the `GET /api/events?filter=wake` fallback
 * SKILL.md derives from the same host and port.
 *
 * This file stands up the real server on `::1`, asks the production
 * `tandem_status` for `wakeUrl` over a real MCP session from a `::1` peer (so
 * #1952's per-request loopback check sees a genuine IPv6-loopback
 * `remoteAddress`), and drives a real upgrade against the answer. It is skipped
 * where IPv6 loopback cannot be bound (some containers).
 * `wake-socket.test.ts` covers the URL derivation without IPv6.
 */

import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";
import { allocPort } from "../helpers/alloc-port.js";
import { parseResult } from "../helpers/mcp-harness.js";

// Null where IPv6 loopback cannot be bound, which skips the suite.
const port = await allocPort("::1").catch(() => null);

describe.skipIf(port === null)("wakeUrl on an IPv6-loopback (::1) bind", () => {
  let httpServer: Server;
  let wakeUrl: unknown;

  beforeAll(async () => {
    httpServer = await startMcpServerHttp(port as number, "::1");
    const client = new Client({ name: "wake-ipv6-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://[::1]:${port}/mcp`)));
    try {
      const result = await client.callTool({ name: "tandem_status", arguments: {} });
      wakeUrl = parseResult(result)?.data?.wakeUrl;
    } finally {
      await client.close();
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("hands a ::1 peer the [::1] address the server is listening on", () => {
    expect(wakeUrl).toBe(`ws://[::1]:${port}/api/wake`);
  });

  it("accepts a real WebSocket upgrade against that wakeUrl", async () => {
    const ws = new WebSocket(wakeUrl as string);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
        ws.once("unexpected-response", (_req, res) =>
          reject(new Error(`upgrade refused: HTTP ${res.statusCode}`)),
        );
      });
    } finally {
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once("close", () => resolve());
        ws.terminate();
      });
    }
  });

  it("serves the SSE fallback and /health on the same host and port", async () => {
    // SKILL.md: `ws://H:P/api/wake` -> `http://H:P/api/events?filter=wake`.
    const base = `http://[::1]:${port}`;
    const ctrl = new AbortController();
    const events = await fetch(`${base}/api/events?filter=wake`, { signal: ctrl.signal });
    expect(events.status).toBe(200);
    ctrl.abort();

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
  });
});
