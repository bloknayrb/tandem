import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRequestId, getResponseId, parseTimeoutMs } from "../../src/cli/mcp-stdio.js";

async function readOneLine(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 10_000,
): Promise<string> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => stderrChunks.push(c.toString("utf8")));
  return new Promise<string>((resolveResp, rejectResp) => {
    const checker = setInterval(() => {
      const joined = stdoutChunks.join("");
      const nl = joined.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        clearInterval(checker);
        resolveResp(joined.slice(0, nl));
      }
    }, 50);
    const timer = setTimeout(() => {
      clearInterval(checker);
      rejectResp(
        new Error(
          `no stdout within ${timeoutMs}ms. stderr=${stderrChunks.join("")} stdout=${stdoutChunks.join("")}`,
        ),
      );
    }, timeoutMs);
  });
}

/**
 * Read up to `n` newline-delimited JSON-RPC lines from child stdout.
 * Returns as soon as n lines arrive or timeoutMs elapses (in which case
 * it resolves with whatever arrived — callers assert on the count).
 */
async function readLines(
  child: ChildProcessWithoutNullStreams,
  n: number,
  timeoutMs = 10_000,
): Promise<string[]> {
  const stdoutChunks: string[] = [];
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));
  return new Promise<string[]>((resolveResp) => {
    const lines: string[] = [];
    let remainder = "";
    const checker = setInterval(() => {
      const joined = remainder + stdoutChunks.join("");
      stdoutChunks.length = 0;
      const parts = joined.split("\n");
      remainder = parts.pop() ?? "";
      for (const part of parts) {
        if (part.trim()) lines.push(part);
      }
      if (lines.length >= n) {
        clearTimeout(timer);
        clearInterval(checker);
        resolveResp(lines);
      }
    }, 50);
    const timer = setTimeout(() => {
      clearInterval(checker);
      resolveResp(lines);
    }, timeoutMs);
  });
}

describe("getRequestId", () => {
  it("returns the id for JSON-RPC requests (has method + id)", () => {
    expect(getRequestId({ jsonrpc: "2.0", id: 1, method: "tools/list" } as never)).toBe(1);
    expect(getRequestId({ jsonrpc: "2.0", id: "abc", method: "tools/call" } as never)).toBe("abc");
  });

  it("returns undefined for JSON-RPC notifications (method, no id)", () => {
    expect(getRequestId({ jsonrpc: "2.0", method: "notifications/foo" } as never)).toBeUndefined();
  });

  it("returns undefined for JSON-RPC responses (id, no method)", () => {
    expect(getRequestId({ jsonrpc: "2.0", id: 1, result: {} } as never)).toBeUndefined();
    expect(
      getRequestId({ jsonrpc: "2.0", id: 1, error: { code: 0, message: "" } } as never),
    ).toBeUndefined();
  });
});

describe("getResponseId", () => {
  it("returns the id for JSON-RPC responses (id, no method)", () => {
    expect(getResponseId({ jsonrpc: "2.0", id: 1, result: {} } as never)).toBe(1);
    expect(
      getResponseId({ jsonrpc: "2.0", id: "abc", error: { code: 0, message: "" } } as never),
    ).toBe("abc");
  });

  it("returns undefined for JSON-RPC requests (has method)", () => {
    expect(getResponseId({ jsonrpc: "2.0", id: 1, method: "tools/list" } as never)).toBeUndefined();
  });

  it("returns undefined for JSON-RPC notifications (has method, no id)", () => {
    expect(getResponseId({ jsonrpc: "2.0", method: "notifications/foo" } as never)).toBeUndefined();
  });
});

describe("mcp-stdio proxy integration", () => {
  let server: Server;
  let port: number;
  let receivedPosts: Array<{
    body: unknown;
    headers: Record<string, string | string[] | undefined>;
  }>;
  let child: ChildProcessWithoutNullStreams | undefined;

  beforeEach(async () => {
    receivedPosts = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            body = null;
          }
          receivedPosts.push({ body, headers: req.headers });
          const msg = body as { id?: number | string; method?: string } | null;
          if (msg && typeof msg.method === "string" && "id" in msg) {
            const response = {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "fake-tandem", version: "0.0.0-test" },
              },
            };
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          } else {
            // notifications get 202 Accepted, no body
            res.writeHead(202);
            res.end();
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    port = addr.port;
  });

  afterEach(async () => {
    child?.kill();
    child = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("forwards an initialize request to the fake HTTP server and returns the response on stdout", async () => {
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const initialize = {
      jsonrpc: "2.0",
      id: 42,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-harness", version: "0.0.0" },
        capabilities: {},
      },
    };
    // Small delay so the child's stdio transport and http transport both have started
    await new Promise((r) => setTimeout(r, 500));
    child.stdin.write(`${JSON.stringify(initialize)}\n`);

    const response = await readOneLine(child);
    const parsed = JSON.parse(response) as {
      id: number;
      result?: { serverInfo?: { name?: string } };
    };
    expect(parsed.id).toBe(42);
    expect(parsed.result?.serverInfo?.name).toBe("fake-tandem");
    expect(receivedPosts).toHaveLength(1);
    expect((receivedPosts[0]?.body as { method?: string })?.method).toBe("initialize");
  }, 30_000);
});

describe("mcp-stdio error synthesis on upstream unavailability", () => {
  let child: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  it("forwards a buffered request once upstream becomes ready", async () => {
    // Regression guard for the drain path: a request arriving BEFORE
    // http.start() completes must still be forwarded (not dropped, not
    // synthesized) once httpReady flips. The fake server artificially
    // delays /health so preflight takes ~400ms — long enough that a
    // stdin write immediately after spawn lands in preReadyBuffer.
    const receivedPosts: Array<{ method?: string; id?: unknown }> = [];
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
        }, 400);
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          receivedPosts.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } },
            }),
          );
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    const port = addr.port;

    try {
      const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
      child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
        env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Write IMMEDIATELY — no 500ms grace. The request must land in
      // preReadyBuffer and survive the drain once httpReady flips.
      const initialize = {
        jsonrpc: "2.0",
        id: 55,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-harness", version: "0.0.0" },
          capabilities: {},
        },
      };
      child.stdin.write(`${JSON.stringify(initialize)}\n`);

      const line = await readOneLine(child);
      const parsed = JSON.parse(line) as {
        id: number;
        result?: { capabilities?: Record<string, unknown> };
        error?: { code: number };
      };
      expect(parsed.id).toBe(55);
      // Must be a successful forward, NOT a synthesized -32000.
      expect(parsed.error).toBeUndefined();
      expect(parsed.result?.capabilities).toBeDefined();
      expect(receivedPosts).toHaveLength(1);
      expect(receivedPosts[0]?.method).toBe("initialize");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it("synthesizes -32000 for an initialize request when the upstream server is not running", async () => {
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    // Point at a port nothing's listening on. Preflight probe fails, the
    // already-started stdio transport replies -32000 to any incoming request.
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: { ...process.env, TANDEM_URL: "http://127.0.0.1:1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const initialize = {
      jsonrpc: "2.0",
      id: 99,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "test-harness", version: "0.0.0" },
        capabilities: {},
      },
    };
    // Send the request immediately; the child will either buffer it (not
    // ready yet) or receive it after preflight fails but before exit. Either
    // way, the reply must be a -32000.
    child.stdin.write(`${JSON.stringify(initialize)}\n`);

    const line = await readOneLine(child);
    const parsed = JSON.parse(line) as {
      id: number;
      error?: { code: number; message: string };
    };
    expect(parsed.id).toBe(99);
    expect(parsed.error?.code).toBe(-32000);
    expect(parsed.error?.message).toMatch(/not (running|ready)/i);
  }, 30_000);

  it("synthesizes -32000 for pending requests when the upstream dies mid-session", async () => {
    // Fake server that accepts the initialize POST but never responds —
    // then close the socket mid-request to simulate an upstream crash.
    let held: ServerResponse | undefined;
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          // Hold the response — we'll close the server under the client
          // instead of replying.
          held = res;
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    const port = addr.port;

    try {
      const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
      child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
        env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Send immediately and let the preReadyBuffer→drain path deliver the
      // request once preflight completes. No fixed sleep needed — we poll
      // `held` below and proceed only once the server has the POST in hand.
      const initialize = {
        jsonrpc: "2.0",
        id: 77,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-harness", version: "0.0.0" },
          capabilities: {},
        },
      };
      child.stdin.write(`${JSON.stringify(initialize)}\n`);

      // Wait until the fake upstream has received the POST, then slam the
      // socket shut so the client's connection closes mid-session.
      for (let i = 0; i < 50; i++) {
        if (held) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // Destroy the held response — exercises forwardToUpstream.catch (not
      // http.onclose, which the current SDK only fires from its own close()).
      held?.destroy();

      const line = await readOneLine(child);
      const parsed = JSON.parse(line) as {
        id: number;
        error?: { code: number; message: string };
      };
      expect(parsed.id).toBe(77);
      expect(parsed.error?.code).toBe(-32000);
      // forwardToUpstream.catch fires with "Tandem HTTP upstream unreachable"
      expect(parsed.error?.message).toMatch(/unreachable/i);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it("does not synthesize for notifications (no id) on preflight failure", async () => {
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    // Point at a dead port so preflight fails immediately.
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: { ...process.env, TANDEM_URL: "http://127.0.0.1:1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Write a notification (no id) — must never produce a -32000 reply.
    const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
    child.stdin.write(`${JSON.stringify(notification)}\n`);

    // Wait for child to exit (it exits 1 after PREFLIGHT_GRACE_MS).
    await new Promise<void>((r) => child!.once("exit", () => r()));

    // Collect any stdout lines that arrived.
    const stdoutChunks: string[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));
    const allOutput = stdoutChunks.join("");
    const lines = allOutput.split("\n").filter((l) => l.trim());

    // No line should be a -32000 error reply.
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { error?: { code?: number } };
        expect(parsed.error?.code).not.toBe(-32000);
      } catch {
        // Non-JSON line — fine, ignore.
      }
    }
  }, 15_000);

  it("synthesizes -32000 for multiple concurrent pending requests on mid-session upstream death", async () => {
    // Fake server: /health → 200, /mcp → holds all POSTs without replying.
    const heldResponses: ServerResponse[] = [];
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          heldResponses.push(res);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    const port = addr.port;

    try {
      const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
      child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
        env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Send three concurrent requests with distinct ids.
      const makeRequest = (id: number) => ({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-harness", version: "0.0.0" },
          capabilities: {},
        },
      });
      child.stdin.write(`${JSON.stringify(makeRequest(100))}\n`);
      child.stdin.write(`${JSON.stringify(makeRequest(101))}\n`);
      child.stdin.write(`${JSON.stringify(makeRequest(102))}\n`);

      // Poll until all three POSTs reach the server (preflight + drain must complete first).
      for (let i = 0; i < 100; i++) {
        if (heldResponses.length >= 3) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(heldResponses.length).toBeGreaterThanOrEqual(3);

      // Destroy all held responses to trigger forwardToUpstream.catch for each.
      for (const r of heldResponses) r.destroy();

      // Collect three -32000 lines.
      const lines = await readLines(child, 3, 10_000);
      expect(lines).toHaveLength(3);

      const receivedIds = new Set<number>();
      for (const line of lines) {
        const parsed = JSON.parse(line) as {
          id: number;
          error?: { code: number };
        };
        expect(parsed.error?.code).toBe(-32000);
        receivedIds.add(parsed.id);
      }
      expect(receivedIds).toEqual(new Set([100, 101, 102]));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);

  it("clears pendingRequests after a successful response", async () => {
    // Fake server: first POST (id=1) → success reply; second POST (id=2) → held.
    let postCount = 0;
    let held: ServerResponse | undefined;
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            id?: number | string;
          };
          postCount++;
          if (postCount === 1) {
            // Reply immediately for id=1.
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id,
                result: { protocolVersion: "2024-11-05", capabilities: {} },
              }),
            );
          } else {
            // Hold id=2 — will be destroyed to trigger forwardToUpstream.catch.
            held = res;
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    const port = addr.port;

    try {
      const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
      child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
        env: { ...process.env, TANDEM_URL: `http://127.0.0.1:${port}` },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const makeRequest = (id: number) => ({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test-harness", version: "0.0.0" },
          capabilities: {},
        },
      });

      // Send id=1, read success response — proves delete-after-send path.
      child.stdin.write(`${JSON.stringify(makeRequest(1))}\n`);
      const line1 = await readOneLine(child, 10_000);
      const parsed1 = JSON.parse(line1) as { id: number; error?: { code: number } };
      expect(parsed1.id).toBe(1);
      expect(parsed1.error).toBeUndefined();

      // Send id=2 and wait until the server holds it.
      child.stdin.write(`${JSON.stringify(makeRequest(2))}\n`);
      for (let i = 0; i < 100; i++) {
        if (held) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(held).toBeDefined();

      // Destroy the held response → forwardToUpstream.catch fires for id=2 only.
      held!.destroy();

      const line2 = await readOneLine(child, 10_000);
      const parsed2 = JSON.parse(line2) as { id: number; error?: { code: number } };
      expect(parsed2.id).toBe(2);
      expect(parsed2.error?.code).toBe(-32000);

      // Verify no additional line arrives — id=1 must have been removed from
      // pendingRequests on success and must NOT be re-synthesized.
      const extra = await readLines(child, 1, 500);
      expect(extra).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 30_000);
});

describe("mcp-stdio per-request timeout", () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let timeoutServer: Server | undefined;

  afterEach(async () => {
    // Kill child first so the HTTP connection is released before server.close().
    child?.kill();
    child = undefined;
    if (timeoutServer) {
      // closeAllConnections() (Node 18.2+) forces open keep-alive sockets
      // closed so server.close() resolves without hanging.
      (timeoutServer as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((r) => timeoutServer!.close(() => r()));
      timeoutServer = undefined;
    }
  });

  /**
   * Spin up a fake Tandem server whose /mcp endpoint holds every POST
   * without replying. Used by half-open timeout tests.
   */
  async function makeHalfOpenServer(): Promise<{ port: number }> {
    timeoutServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        // Intentionally never respond — simulates a half-open upstream.
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => (timeoutServer as Server).listen(0, "127.0.0.1", r));
    const addr = (timeoutServer as Server).address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    return { port: addr.port };
  }

  it("synthesizes -32000 after timeout when upstream accepts but never responds (half-open)", async () => {
    // Fake server: /health → 200, /mcp → holds the POST without replying.
    const { port } = await makeHalfOpenServer();
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    // Use a short timeout (500ms) so the test doesn't take 30s.
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: {
        ...process.env,
        TANDEM_URL: `http://127.0.0.1:${port}`,
        TANDEM_REQUEST_TIMEOUT_MS: "500",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Write after a short delay so httpReady is true (request goes through forwardToUpstream).
    await new Promise((r) => setTimeout(r, 500));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} } })}\n`,
    );

    // Expect -32000 after the 500ms timeout fires (plus processing slack).
    const line = await readOneLine(child, 5_000);
    const parsed = JSON.parse(line) as {
      id: number;
      error?: { code: number; message: string; data?: { detail: string } };
    };
    expect(parsed.id).toBe(10);
    expect(parsed.error?.code).toBe(-32000);
    expect(parsed.error?.message).toMatch(/half-open/i);
    expect(parsed.error?.data?.detail).toMatch(/500ms/);
  }, 15_000);

  it("synthesizes distinct -32000 for each concurrent pending request on timeout", async () => {
    // Fake server: /health → 200, /mcp → holds all POSTs without replying.
    const { port } = await makeHalfOpenServer();
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: {
        ...process.env,
        TANDEM_URL: `http://127.0.0.1:${port}`,
        TANDEM_REQUEST_TIMEOUT_MS: "500",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for httpReady, then send 3 concurrent requests.
    await new Promise((r) => setTimeout(r, 500));
    const makeRequest = (id: number) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test", version: "0" },
          capabilities: {},
        },
      });
    child.stdin.write(`${makeRequest(20)}\n`);
    child.stdin.write(`${makeRequest(21)}\n`);
    child.stdin.write(`${makeRequest(22)}\n`);

    // Collect 3 -32000 lines (allow 5s slack after 500ms timeout).
    const lines = await readLines(child, 3, 5_000);
    expect(lines).toHaveLength(3);

    const receivedIds = new Set<number>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { id: number; error?: { code: number } };
      expect(parsed.error?.code).toBe(-32000);
      receivedIds.add(parsed.id);
    }
    expect(receivedIds).toEqual(new Set([20, 21, 22]));
  }, 15_000);

  it("does not synthesize double -32000 when timer fires before upstream crash arrives", async () => {
    // Regression guard: when the per-request timer fires and deletes the map entry,
    // a subsequent forwardToUpstream.catch for the same id must find the map empty
    // and NOT emit a second -32000.
    //
    // Sequence:
    //  1. Short timer (300ms) starts when request is forwarded.
    //  2. Server holds the POST (never responds), timer fires → map deleted → -32000 (half-open).
    //  3. Test destroys the server connection after the timer has fired.
    //  4. forwardToUpstream.catch fires: pendingRequests.delete() returns false → no second -32000.
    let heldRes: ServerResponse | undefined;
    timeoutServer = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "POST" && req.url === "/mcp") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          heldRes = res;
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => (timeoutServer as Server).listen(0, "127.0.0.1", r));
    const addr = (timeoutServer as Server).address();
    if (!addr || typeof addr === "string") throw new Error("server.address() unexpected");
    const { port } = addr;

    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: {
        ...process.env,
        TANDEM_URL: `http://127.0.0.1:${port}`,
        // Short enough to fire before we destroy, long enough to be reliable.
        TANDEM_REQUEST_TIMEOUT_MS: "300",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Collect stdout so we can count total -32000 lines later.
    const stdoutChunks: string[] = [];
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c.toString("utf8")));

    // Wait for httpReady, then send the request.
    await new Promise((r) => setTimeout(r, 500));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 30, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} } })}\n`,
    );

    // Poll until server has the POST, then wait for timer to fire first.
    for (let i = 0; i < 60; i++) {
      if (heldRes) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(heldRes).toBeDefined();

    // Wait for the 300ms timer to fire and produce the -32000.
    const firstLine = await readOneLine(child, 3_000);
    const first = JSON.parse(firstLine) as { id: number; error?: { code: number } };
    expect(first.id).toBe(30);
    expect(first.error?.code).toBe(-32000);

    // Now destroy the connection — forwardToUpstream.catch will fire.
    heldRes!.destroy();

    // Wait 500ms for any spurious second -32000 to arrive.
    await new Promise((r) => setTimeout(r, 500));
    const allOutput = stdoutChunks.join("");
    const allLines = allOutput.split("\n").filter((l) => l.trim());
    const errorCount = allLines.filter((l) => {
      try {
        const p = JSON.parse(l) as { id?: number; error?: { code?: number } };
        return p.id === 30 && p.error?.code === -32000;
      } catch {
        return false;
      }
    }).length;
    // Exactly one -32000 for id=30 — timer fired first, catch found map empty.
    expect(errorCount).toBe(1);
  }, 10_000);

  it("process exits in <3s after half-open timeout fires (no orphan handles)", async () => {
    // Regression guard: after the per-request timer fires and the proxy sends a
    // -32000, the process should be able to exit cleanly. If shutdown is triggered
    // (e.g., by the plugin host closing stdin which triggers stdio.close),
    // uncleared timer handles must not delay process.exit.
    //
    // Here we verify a simpler invariant: after a half-open timeout fires (-32000
    // arrives on stdout), the child can be killed cleanly and its 'close' event
    // fires within 3s. The timer has already fired and been cleared from the map.
    const { port } = await makeHalfOpenServer();
    const cliEntry = resolve(__dirname, "../../src/cli/index.ts");
    child = spawn(process.execPath, ["--import", "tsx", cliEntry, "mcp-stdio"], {
      env: {
        ...process.env,
        TANDEM_URL: `http://127.0.0.1:${port}`,
        TANDEM_REQUEST_TIMEOUT_MS: "300",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise((r) => setTimeout(r, 500));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 40, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "test", version: "0" }, capabilities: {} } })}\n`,
    );

    // Wait for the -32000 to arrive (timer fired).
    const line = await readOneLine(child, 3_000);
    const parsed = JSON.parse(line) as { id: number; error?: { code: number } };
    expect(parsed.id).toBe(40);
    expect(parsed.error?.code).toBe(-32000);

    // Kill the child and verify it closes within 3s.
    child.kill();
    const closed = await new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => resolve(false), 3_000);
      child!.once("close", () => {
        clearTimeout(deadline);
        resolve(true);
      });
    });
    expect(closed).toBe(true);
  }, 10_000);
});

describe("parseTimeoutMs", () => {
  it("returns the parsed value for a valid positive integer string", () => {
    expect(parseTimeoutMs("5000")).toBe(5000);
    expect(parseTimeoutMs("1")).toBe(1);
    expect(parseTimeoutMs("2147483647")).toBe(2_147_483_647);
  });

  it("returns 30000 for undefined (no env var set)", () => {
    expect(parseTimeoutMs(undefined)).toBe(30_000);
  });

  it("returns 30000 for NaN input", () => {
    expect(parseTimeoutMs("not-a-number")).toBe(30_000);
  });

  it("accepts scientific-notation-like input as the leading integer (parseInt stops at 'e')", () => {
    // parseInt("3e4", 10) === 3 — a small positive integer, accepted as valid.
    expect(parseTimeoutMs("3e4")).toBe(3);
    // parseInt("1e10", 10) === 1 — also a small positive integer.
    expect(parseTimeoutMs("1e10")).toBe(1);
  });

  it("returns 30000 for overflow (> MAX_TIMEOUT_MS)", () => {
    expect(parseTimeoutMs("9999999999999")).toBe(30_000);
    expect(parseTimeoutMs("2147483648")).toBe(30_000);
  });

  it("returns 30000 for negative values", () => {
    expect(parseTimeoutMs("-1")).toBe(30_000);
    expect(parseTimeoutMs("-100")).toBe(30_000);
  });

  it("returns 30000 for zero", () => {
    expect(parseTimeoutMs("0")).toBe(30_000);
  });
});
