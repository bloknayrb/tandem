/**
 * Regression guard: `/api/events` must not grant CORS to an opaque origin.
 *
 * This pins a coupling that is otherwise invisible. `sseHandler` writes its own
 * status line with `res.writeHead(200, {...})` and never mentions CORS — so
 * read alone, it looks unrelated to the #1291 fix. But Node *merges* the
 * `writeHead` header map with headers already set via `setHeader`, rather than
 * replacing them, so whatever `createApiMiddleware` decided upstream survives
 * onto the stream. That is how the old `Access-Control-Allow-Origin: null`
 * reached `/api/events` and made live document, annotation and chat events
 * `EventSource`-readable from any page.
 *
 * The merge is the load-bearing fact, and it belongs to Node rather than to us:
 * a rewrite to a replacing header write would silently un-fix this endpoint
 * while every `api-middleware` test kept passing. A comment cannot catch that;
 * this test can.
 *
 * It therefore runs against a REAL `http.ServerResponse` over a real socket. A
 * mocked `res` would only prove that the mock merges.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The event queue is irrelevant here — stub it so no real observers are wired.
vi.mock("../../src/server/events/queue.js", () => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  replaySince: vi.fn(() => []),
}));

import { sseHandler } from "../../src/server/events/sse.js";
import { createApiMiddleware } from "../../src/server/mcp/api-routes.js";

let server: http.Server;
let port: number;

beforeAll(async () => {
  const app = express();
  app.use(createApiMiddleware());
  app.get("/api/events", sseHandler);
  // src/server/express.d.ts's ambient `Application` is deliberately minimal (no
  // call signature), so it isn't structurally a `http.RequestListener` even
  // though express's real Application is callable as (req, res) => void.
  server = http.createServer(app as unknown as http.RequestListener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Open the stream and resolve once headers arrive, then abort. We deliberately
 * never read the body — the headers are the whole assertion, and leaving the
 * connection open would hold the keepalive interval.
 */
function fetchStreamHeaders(origin?: string): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/events",
        headers: origin ? { Origin: origin } : {},
      },
      (res) => {
        resolve(res.headers);
        req.destroy();
      },
    );
    req.on("error", (err) => {
      // destroy() after resolve surfaces here; only a pre-resolve error matters.
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") reject(err);
    });
    req.end();
  });
}

describe("/api/events inherits the CORS decision (#1291)", () => {
  it("grants nothing to the opaque `null` origin", async () => {
    const headers = await fetchStreamHeaders("null");
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("grants nothing to an external origin", async () => {
    const headers = await fetchStreamHeaders("https://evil.com");
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("still echoes an allowlisted loopback origin onto the stream", async () => {
    // The positive control. Without it, the two assertions above would also
    // pass if the middleware stopped running on this route entirely — an
    // absence proves nothing unless presence is reachable by the same path.
    const headers = await fetchStreamHeaders("http://127.0.0.1:5173");
    expect(headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
  });

  it("opens the stream at all", async () => {
    const headers = await fetchStreamHeaders("http://127.0.0.1:5173");
    expect(headers["content-type"]).toContain("text/event-stream");
  });
});
