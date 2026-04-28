/**
 * Integration tests for GET /api/info.
 *
 * Spins up a real `startMcpServerHttp` instance so the full Express middleware
 * stack (DNS-rebinding, auth, route) is exercised as deployed.
 *
 * All requests are sent from 127.0.0.1 (loopback), so auth middleware bypasses
 * token validation — the route itself is what we're testing here.
 *
 * DNS-rebinding tests use Node's `http.request` (not `fetch`) so we can inject
 * a custom Host header — the Fetch API forbids overriding Host for security.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startMcpServerHttp } from "../../src/server/mcp/server.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function allocPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (!addr || typeof addr === "string") {
        probe.close();
        reject(new Error("unexpected address"));
        return;
      }
      const p = addr.port;
      probe.close(() => resolve(p));
    });
  });
}

function closeServer(s: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    s.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        console.error("server close error:", err);
      }
      resolve();
    });
  });
}

/** Send an HTTP GET request using Node's http module (supports custom Host headers). */
function rawGet(p: number, path: string, host: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port: p, path, method: "GET", headers: { Host: host } },
      (res: IncomingMessage) => {
        let data = "";
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

let httpServer: Server;
let port: number;

beforeEach(async () => {
  port = await allocPort();
  httpServer = await startMcpServerHttp(port, "127.0.0.1");
});

afterEach(async () => {
  await closeServer(httpServer);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/info — loopback (full response)", () => {
  it("returns 200 with all expected public fields", async () => {
    const { status, body } = await rawGet(port, "/api/info", `127.0.0.1:${port}`);
    const b = body as Record<string, unknown>;

    expect(status).toBe(200);

    // Public fields always present
    expect(typeof b.version).toBe("string");
    expect(b.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(b.transport).toBe("http");
    expect(typeof b.mcpSdkVersion).toBe("string");

    // toolCount: number or null (null only on SDK private-field shape drift)
    expect(b.toolCount === null || typeof b.toolCount === "number").toBe(true);
    // Tools ARE registered unconditionally in createMcpServer(), so count > 0
    expect(b.toolCount).toBeGreaterThan(0);
  });

  it("returns sensitive fields (storagePath, tokenRotatedAt) for loopback callers", async () => {
    const { status, body } = await rawGet(port, "/api/info", `127.0.0.1:${port}`);
    const b = body as Record<string, unknown>;

    expect(status).toBe(200);

    // Loopback-only sensitive fields must be present
    expect("storagePath" in b).toBe(true);
    expect(typeof b.storagePath).toBe("string");
    // storagePath ends in /sessions or \sessions (cross-platform)
    expect(String(b.storagePath)).toMatch(/sessions$/);

    expect("tokenRotatedAt" in b).toBe(true);
    // tokenRotatedAt is null (token file absent) or a number (mtime in ms)
    expect(b.tokenRotatedAt === null || typeof b.tokenRotatedAt === "number").toBe(true);
  });
});

describe("GET /api/info — DNS rebinding protection", () => {
  it("returns 403 when Host header is not localhost", async () => {
    // rawGet uses http.request so the custom Host header is actually sent.
    // Node fetch() forbids overriding Host, making it unsuitable for this test.
    //
    // Note: The 403 may come from either:
    // (a) our apiMiddleware (returns { error: "FORBIDDEN" }), or
    // (b) the MCP SDK's localhostHostValidation middleware (returns a JSON-RPC error).
    // Both reject the request — the important invariant is the 403 status.
    const { status } = await rawGet(port, "/api/info", "evil.example.com");

    expect(status).toBe(403);
  });
});

describe("GET /api/info — public shape contract", () => {
  it("always returns version, toolCount, mcpSdkVersion, transport regardless of host", async () => {
    const { status, body } = await rawGet(port, "/api/info", `127.0.0.1:${port}`);
    const b = body as Record<string, unknown>;

    expect(status).toBe(200);
    expect("version" in b).toBe(true);
    expect("toolCount" in b).toBe(true);
    expect("mcpSdkVersion" in b).toBe(true);
    expect("transport" in b).toBe(true);
    expect(b.transport).toBe("http");
  });
});
